'use strict';
const fetch   = require('node-fetch');
const chalk   = require('chalk');

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

// ─────────────────────────────────────────────────────────────────────────────
// API SETUP — Gemini Free Tier (primary) with Groq fallback
// ─────────────────────────────────────────────────────────────────────────────
const GEMINI_KEY  = process.env.GEMINI_API_KEY;
const GROQ_KEY    = process.env.GROQ_API_KEY;
const GROQ_MODEL  = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
// Gemini 2.0 Flash — free tier, extremely capable
const GEMINI_MODEL = 'gemini-2.0-flash';

const conversationHistory = [];
const MAX_HISTORY = 20;
let isProcessing = false;

// ─────────────────────────────────────────────────────────────────────────────
// GEMINI API CALL (free tier via REST)
// ─────────────────────────────────────────────────────────────────────────────
async function callGemini(messages, tools) {
  if (!GEMINI_KEY || GEMINI_KEY === 'YOUR_GEMINI_API_KEY_HERE') {
    throw new Error('GEMINI_API_KEY not set. Get a free key at https://aistudio.google.com/apikey');
  }

  // Convert OpenAI-style messages to Gemini format
  const systemMsg = messages.find(m => m.role === 'system');
  const chatMsgs  = messages.filter(m => m.role !== 'system');

  const contents = chatMsgs.map(m => {
    if (m.role === 'tool') {
      return {
        role: 'user',
        parts: [{ text: `Tool result: ${m.content}` }]
      };
    }
    if (m.role === 'assistant') {
      const parts = [];
      if (m.content) parts.push({ text: m.content });
      if (m.tool_calls) {
        m.tool_calls.forEach(tc => {
          let args = {};
          try { args = JSON.parse(tc.function.arguments); } catch(_) {}
          parts.push({ functionCall: { name: tc.function.name, args } });
        });
      }
      return { role: 'model', parts: parts.length ? parts : [{ text: '' }] };
    }
    return { role: 'user', parts: [{ text: m.content }] };
  });

  // Gemini function declarations
  const functionDeclarations = tools.map(t => ({
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters
  }));

  const body = {
    system_instruction: { parts: [{ text: systemMsg?.content || '' }] },
    contents,
    tools: [{ functionDeclarations }],
    generationConfig: { maxOutputTokens: 4096, temperature: 0.3 }
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`;
  const res  = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  const candidate = data.candidates?.[0];
  if (!candidate) throw new Error('No response from Gemini');

  // Convert Gemini response to OpenAI-like format
  const content = candidate.content;
  let textContent = '';
  const toolCalls = [];

  (content?.parts || []).forEach((part, i) => {
    if (part.text) textContent += part.text;
    if (part.functionCall) {
      toolCalls.push({
        id: `call_${i}_${Date.now()}`,
        type: 'function',
        function: {
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args || {})
        }
      });
    }
  });

  const finishReason = candidate.finishReason === 'STOP' ? 'stop' : 'tool_calls';

  return {
    choices: [{
      message: {
        role: 'assistant',
        content: textContent || null,
        tool_calls: toolCalls.length ? toolCalls : undefined
      },
      finish_reason: toolCalls.length ? 'tool_calls' : finishReason
    }],
    usage: {
      prompt_tokens:     data.usageMetadata?.promptTokenCount || 0,
      completion_tokens: data.usageMetadata?.candidatesTokenCount || 0
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GROQ FALLBACK
// ─────────────────────────────────────────────────────────────────────────────
async function callGroq(messages, tools) {
  if (!GROQ_KEY) throw new Error('No GROQ_API_KEY set');
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
    body: JSON.stringify({
      model: GROQ_MODEL,
      max_tokens: 4096,
      messages,
      tools,
      tool_choice: 'auto'
    })
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Groq API error ${res.status}: ${err}`);
  }
  return res.json();
}

// ─────────────────────────────────────────────────────────────────────────────
// TOOL DEFINITIONS
// ─────────────────────────────────────────────────────────────────────────────
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'fetch_weather',
      description: 'Fetch weather forecast for an Indian city. Covers monsoon, fog, cyclone conditions. Also highlights the city on the India map.',
      parameters: {
        type: 'object',
        properties: {
          location: { type: 'string', description: 'Indian city, e.g. "Mumbai, India" or "Delhi"' },
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
      description: 'Fetch real-time AQI data. Critical for Indian cities like Delhi (PM2.5 often hazardous). Returns AQI, PM2.5, PM10.',
      parameters: {
        type: 'object',
        properties: { location: { type: 'string', description: 'Indian city name' } },
        required: ['location'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_seismic_activity',
      description: 'Check for earthquakes and cyclone activity. For Indian coastal cities, also checks Bay of Bengal / Arabian Sea cyclone warnings.',
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
      description: 'Assess Indian domestic flight delay risk. Considers fog (Delhi winters), monsoon, and high-traffic routes (DEL-BOM, BLR-DEL, etc). Airlines: IndiGo, Air India, SpiceJet, Vistara, Akasa.',
      parameters: {
        type: 'object',
        properties: {
          destination:    { type: 'string', description: 'Indian city or airport code (e.g. DEL, BOM, BLR)' },
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
      description: 'Search local events in an Indian city. Covers festivals (Diwali, Holi, Navratri), IPL matches, Kumbh Mela, Republic Day parades, local melas.',
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
      description: 'Compare current conditions against previous monitoring runs. Detect worsening monsoon, rising AQI, new cyclone warnings.',
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
      description: 'Persist assessment to data/alerts.json.',
      parameters: {
        type: 'object',
        properties: {
          destination:  { type: 'string' },
          alert_type:   { type: 'string', enum: ['clear','rain_warning','storm_warning','flight_delay','wind_warning','air_quality','seismic','cyclone','event_note','fog_warning'] },
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
      description: 'Update current monitoring state.',
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
      description: 'Read current monitoring state.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_recent_alerts',
      description: 'Read recent alerts.',
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
      description: 'Activate the Dynamic Re-Router Agent when disruptions exceed thresholds. Re-Router coordinates with Itinerary Planner and Booking agents to find alternative Indian routes.',
      parameters: {
        type: 'object',
        properties: {
          disruption_type: { type: 'string', enum: ['rain_warning','cyclone','flight_delay','high_winds','extreme_weather','air_quality','seismic','fog_warning'] },
          severity:        { type: 'string', enum: ['medium','high','critical'] },
          destination:     { type: 'string' },
          travel_dates:    { type: 'string' },
          affected_days:   { type: 'array', items: { type: 'string' } },
          details:         { type: 'string' },
          alternative_routes: { type: 'string', description: 'Suggested Indian alternative routes, e.g. train Rajdhani instead of flight' },
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
      description: 'Send a desktop notification.',
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
      description: 'Speak text aloud. Keep under 2 sentences.',
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
      name: 'play_sound_cue',
      description: 'Trigger a dashboard sound effect.',
      parameters: {
        type: 'object',
        properties: { cue: { type: 'string', enum: ['lock_on','success','alert','beep','error','boot'] } },
        required: ['cue'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'highlight_india_city',
      description: 'Highlight a city on the India holographic map. Used when inspecting a city from the map.',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string', description: 'Indian city name' },
          state: { type: 'string', description: 'Indian state, optional' },
        },
        required: ['city'],
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
      // Append ", India" if not already there
      const loc = input.location.toLowerCase().includes('india') ? input.location : `${input.location}, India`;
      let data, coords;
      try {
        data   = await fetchEnhancedForecast(loc, input.days || 3);
        coords = data.coordinates;
      } catch {
        display.log('TOOL', 'Open-Meteo failed, falling back to wttr.in', 'warning');
        data = await fetchWeather(loc, input.days || 3);
        try { const g = await geocode(loc); coords = { lat: g.lat, lon: g.lon }; } catch (_) {}
      }
      dash.weather(data);
      if (coords) dash.lockOn(coords, data.location);
      // Also highlight city on India map
      dash.emit('india_city_highlight', { city: input.location.split(',')[0] });
      return data;
    }

    case 'fetch_air_quality': {
      const loc  = input.location.toLowerCase().includes('india') ? input.location : `${input.location}, India`;
      const data = await fetchAirQuality(loc);
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
      // Activate the new agent panels on dashboard
      dash.emit('agent_activated', { agent: 'weather_monitor', status: 'active' });
      dash.emit('agent_activated', { agent: 'rerouter', status: 'alert' });
      return { ...result, message: 'Dynamic Re-Router Agent activating. Checking alternative Indian routes (train/alternate flight).' };
    }

    case 'send_system_notification': {
      const result = await sendNotification(input.title, input.message, input.urgency || 'normal');
      display.log('SYS', `Notification: "${input.title}"`, result.ok ? 'success' : 'warning');
      return result;
    }

    case 'speak': {
      dash.speak(input.text);
      display.log('VOICE', `"${input.text.slice(0, 80)}"`, 'info');
      return { ok: true, spoken: input.text };
    }

    case 'set_voice': {
      const state = sys.setTtsEnabled(input.enabled);
      display.log('VOICE', `TTS ${state ? 'enabled' : 'muted'}`, 'info');
      return { enabled: state };
    }

    case 'play_sound_cue':
      dash.sound(input.cue);
      return { ok: true, cue: input.cue };

    case 'highlight_india_city':
      dash.emit('india_city_highlight', { city: input.city, state: input.state });
      display.log('MAP', `India map → ${input.city}`, 'info');
      return { ok: true, city: input.city };

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// COMMAND HANDLER — agentic loop with Gemini (free) / Groq fallback
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

  conversationHistory.push({ role: 'user', content: text });
  if (conversationHistory.length > MAX_HISTORY) conversationHistory.shift();

  const messages = [
    { role: 'system', content: ORCHESTRATOR_SYSTEM },
    ...conversationHistory,
  ];

  try {
    while (true) {
      let response;

      // Try Gemini first (free), fall back to Groq
      try {
        if (GEMINI_KEY && GEMINI_KEY !== 'YOUR_GEMINI_API_KEY_HERE') {
          response = await callGemini(messages, TOOLS);
        } else {
          display.log('WARN', 'No Gemini key — using Groq fallback', 'warning');
          response = await callGroq(messages, TOOLS);
        }
      } catch (apiErr) {
        if (GROQ_KEY && !apiErr.message.includes('Groq')) {
          display.log('WARN', `Gemini failed (${apiErr.message.slice(0,60)}), trying Groq...`, 'warning');
          response = await callGroq(messages, TOOLS);
        } else {
          throw apiErr;
        }
      }

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

      if (message.content) {
        display.log('VOYAGER', message.content.trim(), 'info');
        dash.reply(message.content.trim());
      }

      if (choice.finish_reason === 'stop' || !message.tool_calls?.length) {
        if (message.content) {
          conversationHistory.push({ role: 'assistant', content: message.content });
          if (conversationHistory.length > MAX_HISTORY) conversationHistory.shift();
        }
        break;
      }

      messages.push({ role: 'assistant', content: message.content || '', tool_calls: message.tool_calls });

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
    const msg = err.message || 'Unknown error';
    // Provide clear actionable error messages
    if (msg.includes('GEMINI_API_KEY not set') || msg.includes('invalid_api_key') || msg.includes('401')) {
      const helpMsg = 'API key error. Get a FREE Gemini key at https://aistudio.google.com/apikey → paste it as GEMINI_API_KEY in your .env file → restart.';
      display.log('VOYAGER', chalk.red(helpMsg), 'alert');
      dash.log('VOYAGER', helpMsg, 'alert');
      dash.reply(helpMsg);
    } else {
      display.log('VOYAGER', chalk.red(`Error: ${msg}`), 'alert');
      dash.log('VOYAGER', `Error: ${msg}`, 'alert');
    }
  } finally {
    isProcessing = false;
    dash.agent('Orchestrator', 'idle');
  }
}

module.exports = { handleCommand, TOOLS };
