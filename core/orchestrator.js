'use strict';
const Anthropic = require('@anthropic-ai/sdk');
const chalk     = require('chalk');

const display = require('./display');
const ipc     = require('./ipc');
const memory  = require('./memory');
const dash    = require('./dashboard');
const sys     = require('../tools/system-actions');
const { ORCHESTRATOR_SYSTEM } = require('./personality');

const { fetchWeather, checkFlightDelays, searchLocalEvents } = require('../tools/weather-api');
const { fetchEnhancedForecast, fetchAirQuality, geocode }    = require('../tools/open-meteo');
const { checkEarthquakes }       = require('../tools/disasters');
const { sendNotification }       = require('../tools/notifications');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Maintain a rolling conversation so the orchestrator has context across commands
const conversationHistory = [];
const MAX_HISTORY = 20; // last 10 user/assistant turn pairs

let isProcessing = false;

// ─────────────────────────────────────────────────────────────────────────────
// TOOL DEFINITIONS
// ─────────────────────────────────────────────────────────────────────────────

const TOOLS = [
  // ── weather + environmental ────────────────────────────────────────────
  {
    name: 'fetch_weather',
    description: 'Fetch detailed weather forecast for a destination from Open-Meteo (free) with wttr.in fallback. Returns multi-day forecast with precipitation, wind, UV, severity flags. Also drives the dashboard globe to lock onto the location.',
    input_schema: {
      type: 'object',
      properties: {
        location: { type: 'string', description: 'City and country, e.g. "Tokyo, Japan"' },
        days:     { type: 'number', description: 'Forecast days (1-7, default 3)' },
      },
      required: ['location'],
    },
  },
  {
    name: 'fetch_air_quality',
    description: 'Fetch real-time air quality (AQI, PM2.5, PM10) from Open-Meteo.',
    input_schema: {
      type: 'object',
      properties: { location: { type: 'string' } },
      required: ['location'],
    },
  },
  {
    name: 'check_seismic_activity',
    description: 'Query USGS for earthquakes within radius of destination over past 24 hours.',
    input_schema: {
      type: 'object',
      properties: {
        location:  { type: 'string' },
        radius_km: { type: 'number', description: 'Default 500' },
      },
      required: ['location'],
    },
  },
  {
    name: 'check_flight_delays',
    description: 'Assess flight delay risk for destination.',
    input_schema: {
      type: 'object',
      properties: {
        destination:    { type: 'string' },
        departure_date: { type: 'string' },
      },
      required: ['destination'],
    },
  },
  {
    name: 'search_local_events',
    description: 'Search local events during travel dates.',
    input_schema: {
      type: 'object',
      properties: {
        location:  { type: 'string' },
        date_from: { type: 'string' },
        date_to:   { type: 'string' },
      },
      required: ['location'],
    },
  },
  {
    name: 'compare_with_memory',
    description: 'Compare current weather snapshot against previous runs for this destination. Returns detected changes.',
    input_schema: {
      type: 'object',
      properties: {
        destination: { type: 'string' },
        snapshot:    { type: 'object' },
      },
      required: ['destination', 'snapshot'],
    },
  },

  // ── file system / state ────────────────────────────────────────────────
  {
    name: 'write_alert_log',
    description: 'Persist assessment to data/alerts.json. Mandatory every monitoring cycle.',
    input_schema: {
      type: 'object',
      properties: {
        destination:  { type: 'string' },
        alert_type:   { type: 'string', enum: ['clear','rain_warning','storm_warning','flight_delay','wind_warning','air_quality','seismic','event_note'] },
        severity:     { type: 'string', enum: ['none','low','medium','high','critical'] },
        summary:      { type: 'string' },
        forecast:     { type: 'object' },
        events:       { type: 'array' },
        air_quality:  { type: 'object' },
        seismic:      { type: 'object' },
      },
      required: ['destination', 'alert_type', 'severity', 'summary'],
    },
  },
  {
    name: 'write_monitoring_state',
    description: 'Update data/monitoring-state.json.',
    input_schema: {
      type: 'object',
      properties: {
        destination:        { type: 'string' },
        status:             { type: 'string', enum: ['nominal','monitoring','alert','critical'] },
        conditions_summary: { type: 'string' },
        next_check_in_min:  { type: 'number' },
      },
      required: ['destination', 'status'],
    },
  },
  {
    name: 'read_monitoring_state',
    description: 'Read the current monitoring state file. Use when user asks "show me status" etc.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'read_recent_alerts',
    description: 'Read the recent alerts from data/alerts.json.',
    input_schema: {
      type: 'object',
      properties: { count: { type: 'number', description: 'How many recent alerts to return (default 10)' } },
    },
  },

  // ── IPC ────────────────────────────────────────────────────────────────
  {
    name: 'signal_rerouter',
    description: 'Write data/disruption-signal.json to activate the Re-Router. ONLY when thresholds exceeded.',
    input_schema: {
      type: 'object',
      properties: {
        disruption_type: { type: 'string', enum: ['rain_warning','storm','flight_delay','high_winds','extreme_weather','air_quality','seismic'] },
        severity:        { type: 'string', enum: ['medium','high','critical'] },
        destination:     { type: 'string' },
        travel_dates:    { type: 'string' },
        affected_days:   { type: 'array', items: { type: 'string' } },
        details:         { type: 'string' },
        weather_summary: { type: 'object' },
      },
      required: ['disruption_type', 'severity', 'destination', 'details'],
    },
  },

  // ── system actions ─────────────────────────────────────────────────────
  {
    name: 'send_system_notification',
    description: 'Send a native desktop notification.',
    input_schema: {
      type: 'object',
      properties: {
        title:   { type: 'string' },
        message: { type: 'string' },
        urgency: { type: 'string', enum: ['normal','critical'] },
      },
      required: ['title', 'message'],
    },
  },
  {
    name: 'speak',
    description: 'Speak text aloud using system TTS. Use for short, important summaries only — keep under 2 sentences. Skip if user has muted you.',
    input_schema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
  {
    name: 'set_voice',
    description: 'Enable or disable voice output. Use when user says "go quiet" or "speak again".',
    input_schema: {
      type: 'object',
      properties: { enabled: { type: 'boolean' } },
      required: ['enabled'],
    },
  },
  {
    name: 'write_clipboard',
    description: 'Write text to the system clipboard.',
    input_schema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
  {
    name: 'read_clipboard',
    description: 'Read the current system clipboard content.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'open_file_or_app',
    description: 'Open a file, folder, application, or URL on the user\'s machine.',
    input_schema: {
      type: 'object',
      properties: { target: { type: 'string', description: 'Path, app name, or URL' } },
      required: ['target'],
    },
  },
  {
    name: 'generate_calendar',
    description: 'Generate a .ics calendar file for a trip and save it locally. User can double-click to add to calendar.',
    input_schema: {
      type: 'object',
      properties: {
        title:       { type: 'string' },
        description: { type: 'string' },
        location:    { type: 'string' },
        start_date:  { type: 'string', description: 'YYYY-MM-DD' },
        end_date:    { type: 'string', description: 'YYYY-MM-DD' },
      },
      required: ['title', 'start_date', 'end_date'],
    },
  },
  {
    name: 'play_sound_cue',
    description: 'Trigger a sound effect on the dashboard. Use sparingly for key moments.',
    input_schema: {
      type: 'object',
      properties: {
        cue: { type: 'string', enum: ['lock_on','success','alert','beep','error','boot'] },
      },
      required: ['cue'],
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// TOOL EXECUTOR
// ─────────────────────────────────────────────────────────────────────────────

async function executeTool(name, input) {
  switch (name) {

    case 'fetch_weather': {
      let data, coords;
      try {
        data = await fetchEnhancedForecast(input.location, input.days || 3);
        coords = data.coordinates;
      } catch (err) {
        display.log('TOOL', `Open-Meteo failed, falling back to wttr.in`, 'warning');
        data = await fetchWeather(input.location, input.days || 3);
        try { coords = await geocode(input.location); } catch (_) { coords = null; }
      }
      dash.weather(data);
      if (coords) dash.lockOn(coords, data.location);
      return data;
    }

    case 'fetch_air_quality': {
      const data = await fetchAirQuality(input.location);
      dash.airQuality(data);
      display.log('AIR', `AQI ${data.usAqi} — ${data.category}`, data.isAlertLevel ? 'warning' : 'success');
      return data;
    }

    case 'check_seismic_activity': {
      const data = await checkEarthquakes(input.location, input.radius_km || 500);
      dash.earthquakes(data);
      display.log('SEISMIC', `${data.totalNearby} events / ${data.significant} significant`, data.isAlertLevel ? 'warning' : 'success');
      return data;
    }

    case 'check_flight_delays':
      return await checkFlightDelays(input.destination, input.departure_date);

    case 'search_local_events':
      return await searchLocalEvents(input.location, input.date_from, input.date_to);

    case 'compare_with_memory': {
      const result = memory.detectChanges(input.destination, input.snapshot);
      if (result.changes.length > 0) {
        dash.changes(result.changes);
        result.changes.forEach(c => display.log('MEMORY', `Δ ${c.detail}`, c.severity === 'critical' ? 'alert' : 'info'));
      }
      return result;
    }

    case 'write_alert_log': {
      const result = ipc.appendAlert(input);
      display.log('FS', `Alert logged → ${result.path}`, 'success');
      if (['medium','high','critical'].includes(input.severity)) {
        dash.alert(input.severity, input.summary);
      }
      return result;
    }

    case 'write_monitoring_state': {
      const result = ipc.writeState(input);
      display.log('FS', `State updated → ${result.path}`, 'success');
      dash.state(input);
      return result;
    }

    case 'read_monitoring_state': {
      const state = ipc.readState();
      return state || { message: 'No monitoring state found yet.' };
    }

    case 'read_recent_alerts': {
      const all = ipc.readAlerts();
      return { total: all.length, recent: all.slice(-(input.count || 10)) };
    }

    case 'signal_rerouter': {
      const result = ipc.writeSignal(input);
      display.ipcSignal(result.path);
      dash.ipcSignal(result.path, input);
      dash.sound('alert');
      return { ...result, message: 'Re-Router Agent will activate within 5 seconds.' };
    }

    case 'send_system_notification': {
      const result = await sendNotification(input.title, input.message, input.urgency || 'normal');
      display.log('SYS', `Notification: "${input.title}"`, result.ok ? 'success' : 'warning');
      return result;
    }

    case 'speak': {
      dash.speak(input.text);
      const result = await sys.speak(input.text);
      display.log('VOICE', result.muted ? '(muted)' : `Spoke: "${input.text.slice(0,80)}"`, 'info');
      return result;
    }

    case 'set_voice': {
      const state = sys.setTtsEnabled(input.enabled);
      display.log('VOICE', `TTS ${state ? 'enabled' : 'muted'}`, 'info');
      return { enabled: state };
    }

    case 'write_clipboard': {
      const result = await sys.writeClipboard(input.text);
      display.log('CLIP', `Copied ${result.bytes} bytes`, 'success');
      return result;
    }

    case 'read_clipboard': {
      const result = await sys.readClipboard();
      display.log('CLIP', `Read ${result.content.length} bytes`, 'data');
      return result;
    }

    case 'open_file_or_app': {
      const result = await sys.openTarget(input.target);
      display.log('OPEN', `Opened: ${input.target}`, 'success');
      return result;
    }

    case 'generate_calendar': {
      const result = sys.generateIcs({
        title:       input.title,
        description: input.description,
        location:    input.location,
        startDate:   input.start_date,
        endDate:     input.end_date,
      });
      display.log('CAL', `ICS saved → ${result.path}`, 'success');
      return result;
    }

    case 'play_sound_cue': {
      dash.sound(input.cue);
      return { ok: true, cue: input.cue };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// COMMAND HANDLER — the heart of the orchestrator
// ─────────────────────────────────────────────────────────────────────────────

async function handleCommand(text, source = 'shell') {
  if (isProcessing) {
    display.log('VOYAGER', 'Still processing previous command. Wait.', 'warning');
    return { busy: true };
  }
  isProcessing = true;

  const startTime = Date.now();
  display.log('USER', chalk.white(`▸ ${text}`) + chalk.gray(`  (${source})`), 'info');
  dash.agent('Orchestrator', 'active');
  dash.sound('beep');

  // Push user turn into rolling history
  conversationHistory.push({ role: 'user', content: text });
  if (conversationHistory.length > MAX_HISTORY) conversationHistory.shift();

  // Build messages with full rolling history
  const messages = [...conversationHistory];

  try {
    while (true) {
      const response = await client.messages.create({
        model:      'claude-opus-4-6',
        max_tokens:  4096,
        system:      ORCHESTRATOR_SYSTEM,
        tools:       TOOLS,
        messages,
      });

      if (response.usage) {
        memory.recordTokenUsage(response.usage);
        dash.tokens(response.usage);
      }

      // Print and broadcast any text
      for (const block of response.content) {
        if (block.type === 'text' && block.text.trim()) {
          display.log('VOYAGER', block.text.trim(), 'info');
          dash.reply(block.text.trim());
        }
      }

      if (response.stop_reason === 'end_turn') {
        // Save the final assistant turn to history
        const finalText = response.content
          .filter(b => b.type === 'text')
          .map(b => b.text)
          .join('\n')
          .trim();
        if (finalText) {
          conversationHistory.push({ role: 'assistant', content: finalText });
          if (conversationHistory.length > MAX_HISTORY) conversationHistory.shift();
        }
        break;
      }

      if (response.stop_reason !== 'tool_use') break;

      const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
      const toolResults = [];

      for (const tool of toolUseBlocks) {
        display.toolCall(tool.name, tool.input);
        dash.toolCall(tool.name, tool.input);
        try {
          const result = await executeTool(tool.name, tool.input);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tool.id,
            content: JSON.stringify(result).slice(0, 24000),
          });
          display.toolResult(tool.name, true);
          dash.toolResult(tool.name, true, null);
        } catch (err) {
          display.toolResult(tool.name, false);
          display.log('TOOL', `${tool.name} → ${err.message}`, 'alert');
          dash.toolResult(tool.name, false, { error: err.message });
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tool.id,
            content: JSON.stringify({ error: err.message }),
            is_error: true,
          });
        }
      }

      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user',      content: toolResults });
    }

    const duration = Date.now() - startTime;
    display.log('VOYAGER', chalk.green(`Done in ${(duration/1000).toFixed(1)}s`), 'success');
    dash.cycleEnd(duration);
  } catch (err) {
    display.log('VOYAGER', chalk.red(`Error: ${err.message}`), 'alert');
    dash.log('VOYAGER', `Error: ${err.message}`, 'alert');
  } finally {
    isProcessing = false;
    dash.agent('Orchestrator', 'idle');
  }
}

module.exports = { handleCommand, TOOLS };
