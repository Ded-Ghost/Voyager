'use strict';
const Groq  = require('groq-sdk');
const chalk = require('chalk');

const display = require('./display');
const ipc     = require('./ipc');
const memory  = require('./memory');
const dash    = require('./dashboard');
const sys     = require('../tools/system-actions');
const { ORCHESTRATOR_SYSTEM } = require('./personality');

const { fetchWeather, checkFlightDelays, searchLocalEvents } = require('../tools/weather-api');
const { fetchEnhancedForecast, fetchAirQuality, geocode }    = require('../tools/open-meteo');
const { checkEarthquakes }  = require('../tools/disasters');
const { sendNotification }  = require('../tools/notifications');

const client = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Model — llama-3.3-70b-versatile has the best tool-use support on Groq
const MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

// Rolling conversation history (OpenAI message format)
const conversationHistory = [];
const MAX_HISTORY = 20;

let isProcessing = false;

// ─────────────────────────────────────────────────────────────────────────────
// TOOL DEFINITIONS — Groq uses OpenAI function-calling format
// ─────────────────────────────────────────────────────────────────────────────

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'fetch_weather',
      description: 'Fetch detailed weather forecast from Open-Meteo (free) with wttr.in fallback. Returns multi-day forecast with precipitation, wind, UV, severity flags. Also drives the globe to lock on.',
      parameters: {
        type: 'object',
        properties: {
          location: { type: 'string', description: 'City and country, e.g. "Tokyo, Japan"' },
          days:     { type: 'number', description: 'Forecast days 1-7, default 3' },
        },
        required: ['location'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_air_quality',
      description: 'Fetch real-time air quality (AQI, PM2.5, PM10) from Open-Meteo. Free, no key.',
      parameters: {
        type: 'object',
        properties: { location: { type: 'string' } },
        required: ['location'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_seismic_activity',
      description: 'Query USGS for earthquakes within radius of destination in past 24h. Detects tsunami warnings.',
      parameters: {
        type: 'object',
        properties: {
          location:  { type: 'string' },
          radius_km: { type: 'number', description: 'Default 500' },
        },
        required: ['location'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_flight_delays',
      description: 'Assess flight delay risk for destination.',
      parameters: {
        type: 'object',
        properties: {
          destination:    { type: 'string' },
          departure_date: { type: 'string' },
        },
        required: ['destination'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_local_events',
      description: 'Search local events during travel dates.',
      parameters: {
        type: 'object',
        properties: {
          location:  { type: 'string' },
          date_from: { type: 'string' },
          date_to:   { type: 'string' },
        },
        required: ['location'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'compare_with_memory',
      description: 'Compare current weather snapshot against previous runs. Returns detected changes.',
      parameters: {
        type: 'object',
        properties: {
          destination: { type: 'string' },
          snapshot:    { type: 'object' },
        },
        required: ['destination', 'snapshot'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_alert_log',
      description: 'Persist assessment to data/alerts.json. Mandatory every monitoring cycle.',
      parameters: {
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
  },
  {
    type: 'function',
    function: {
      name: 'write_monitoring_state',
      description: 'Update data/monitoring-state.json.',
      parameters: {
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
  },
  {
    type: 'function',
    function: {
      name: 'read_monitoring_state',
      description: 'Read the current monitoring state. Use when user asks about status.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_recent_alerts',
      description: 'Read recent alerts from data/alerts.json.',
      parameters: {
        type: 'object',
        properties: { count: { type: 'number' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'signal_rerouter',
      description: 'Write data/disruption-signal.json to activate the Re-Router. ONLY when thresholds exceeded.',
      parameters: {
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
  },
  {
    type: 'function',
    function: {
      name: 'send_system_notification',
      description: 'Send a native desktop notification.',
      parameters: {
        type: 'object',
        properties: {
          title:   { type: 'string' },
          message: { type: 'string' },
          urgency: { type: 'string', enum: ['normal','critical'] },
        },
        required: ['title', 'message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'speak',
      description: 'Speak text aloud using system TTS. Keep under 2 sentences.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_voice',
      description: 'Enable or disable voice output.',
      parameters: {
        type: 'object',
        properties: { enabled: { type: 'boolean' } },
        required: ['enabled'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_clipboard',
      description: 'Write text to the system clipboard.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_clipboard',
      description: 'Read the current system clipboard content.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_file_or_app',
      description: 'Open a file, folder, app, or URL on the user machine.',
      parameters: {
        type: 'object',
        properties: { target: { type: 'string' } },
        required: ['target'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_calendar',
      description: 'Generate a .ics calendar file for a trip. User double-clicks to import.',
      parameters: {
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
  },
  {
    type: 'function',
    function: {
      name: 'play_sound_cue',
      description: 'Trigger a sound effect on the dashboard.',
      parameters: {
        type: 'object',
        properties: { cue: { type: 'string', enum: ['lock_on','success','alert','beep','error','boot'] } },
        required: ['cue'],
      },
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
        data   = await fetchEnhancedForecast(input.location, input.days || 3);
        coords = data.coordinates;
      } catch {
        display.log('TOOL', 'Open-Meteo failed, falling back to wttr.in', 'warning');
        data = await fetchWeather(input.location, input.days || 3);
        try { const g = await geocode(input.location); coords = { lat: g.lat, lon: g.lon }; } catch (_) {}
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
      if (['medium','high','critical'].includes(input.severity)) dash.alert(input.severity, input.summary);
      return result;
    }

    case 'write_monitoring_state': {
      const result = ipc.writeState(input);
      display.log('FS', `State updated → ${result.path}`, 'success');
      dash.state(input);
      return result;
    }

    case 'read_monitoring_state':
      return ipc.readState() || { message: 'No monitoring state found yet.' };

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
      display.log('VOICE', result.muted ? '(muted)' : `"${input.text.slice(0, 80)}"`, 'info');
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
        title: input.title, description: input.description,
        location: input.location, startDate: input.start_date, endDate: input.end_date,
      });
      display.log('CAL', `ICS saved → ${result.path}`, 'success');
      return result;
    }

    case 'play_sound_cue':
      dash.sound(input.cue);
      return { ok: true, cue: input.cue };

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// COMMAND HANDLER — Groq agentic loop
// ─────────────────────────────────────────────────────────────────────────────

async function handleCommand(text, source = 'shell') {
  if (isProcessing) {
    display.log('VOYAGER', 'Still processing previous command. Please wait.', 'warning');
    return;
  }
  isProcessing = true;

  const startTime = Date.now();
  display.log('USER', chalk.white(`▸ ${text}`) + chalk.gray(`  (${source})`), 'info');
  dash.agent('Orchestrator', 'active');
  dash.sound('beep');

  // Add user message to rolling history
  conversationHistory.push({ role: 'user', content: text });
  if (conversationHistory.length > MAX_HISTORY) conversationHistory.shift();

  // Full message array: system first, then history
  const messages = [
    { role: 'system', content: ORCHESTRATOR_SYSTEM },
    ...conversationHistory,
  ];

  try {
    // ── Agentic loop ────────────────────────────────────────────────────────
    while (true) {
      const response = await client.chat.completions.create({
        model:       MODEL,
        max_tokens:  4096,
        messages,
        tools:       TOOLS,
        tool_choice: 'auto',
      });

      // Track token usage
      if (response.usage) {
        memory.recordTokenUsage({
          input_tokens:  response.usage.prompt_tokens,
          output_tokens: response.usage.completion_tokens,
        });
        dash.tokens({
          input_tokens:  response.usage.prompt_tokens,
          output_tokens: response.usage.completion_tokens,
        });
      }

      const choice  = response.choices[0];
      const message = choice.message;

      // Print any text content
      if (message.content) {
        display.log('VOYAGER', message.content.trim(), 'info');
        dash.reply(message.content.trim());
      }

      // Done — no tool calls
      if (choice.finish_reason === 'stop' || !message.tool_calls?.length) {
        // Save assistant turn to history
        if (message.content) {
          conversationHistory.push({ role: 'assistant', content: message.content });
          if (conversationHistory.length > MAX_HISTORY) conversationHistory.shift();
        }
        break;
      }

      // Add assistant message (with tool_calls) to the running messages array
      messages.push({ role: 'assistant', content: message.content || '', tool_calls: message.tool_calls });

      // Execute each tool call
      for (const toolCall of message.tool_calls) {
        const name  = toolCall.function.name;
        let   input = {};
        try { input = JSON.parse(toolCall.function.arguments); } catch (_) {}

        display.toolCall(name, input);
        dash.toolCall(name, input);

        let result;
        try {
          result = await executeTool(name, input);
          display.toolResult(name, true);
          dash.toolResult(name, true, null);
        } catch (err) {
          result = { error: err.message };
          display.toolResult(name, false);
          display.log('TOOL', `${name} → ${err.message}`, 'alert');
          dash.toolResult(name, false, { error: err.message });
        }

        // Tool result goes back as a 'tool' role message
        messages.push({
          role:         'tool',
          tool_call_id: toolCall.id,
          content:      JSON.stringify(result).slice(0, 24000),
        });
      }
    }

    const duration = Date.now() - startTime;
    display.log('VOYAGER', chalk.green(`Done in ${(duration / 1000).toFixed(1)}s`), 'success');
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
