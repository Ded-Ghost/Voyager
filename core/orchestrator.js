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
// API SETUP — OpenRouter (primary) with Groq fallback
// ─────────────────────────────────────────────────────────────────────────────
// Sanitize keys: people often paste with quotes, spaces, or trailing newlines
function cleanKey(k) {
  return (k || '').trim().replace(/^["']|["']$/g, '').replace(/\s+/g, '');
}
const OPENROUTER_KEY = cleanKey(process.env.OPENROUTER_API_KEY);
const GROQ_KEY       = cleanKey(process.env.GROQ_API_KEY);
const GROQ_MODEL     = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

// Model selection — OpenRouter's free-tier lineup rotates constantly (models get
// pulled to paid-only or replaced within days), so hardcoding model IDs is fragile.
// Strategy:
//  - If OPENROUTER_MODEL is pinned in .env, use ONLY that (no discovery).
//  - Otherwise, query OpenRouter's /models endpoint at runtime, filter for models
//    that are currently FREE *and* advertise tool/function-calling support, and
//    try them in priority order. Cached for 15 min, refreshed early on failure.
const STATIC_FALLBACK_MODELS = [
  'meta-llama/llama-3.3-70b-instruct:free',
  'meta-llama/llama-3.1-70b-instruct:free',
  'google/gemini-2.0-flash-exp:free',
  'mistralai/mistral-small-3.1-24b-instruct:free',
  'qwen/qwen-2.5-72b-instruct:free',
  'google/gemma-3-27b-it:free',
];
// Rough "known good" ordering — models earlier in this list are preferred when
// multiple free+tool-capable options are discovered.
const MODEL_PRIORITY = [
  /llama-3\.3-70b/i, /llama-3\.1-70b/i, /gemini-2\.0-flash/i, /gemini.*flash/i,
  /mistral-small/i, /qwen-2\.5-72b/i, /deepseek/i, /gemma/i,
];

let modelChainCache  = null;   // array of model ids, most-recently-successful first
let modelChainAt     = 0;
let modelChainStale  = false;  // set true after a full-chain failure → refetch next time
const MODEL_CACHE_TTL = 15 * 60 * 1000;

async function fetchFreeToolModels() {
  const res = await fetch('https://openrouter.ai/api/v1/models', {
    headers: { 'Authorization': `Bearer ${OPENROUTER_KEY}` },
  });
  if (!res.ok) throw new Error(`models endpoint HTTP ${res.status}`);
  const data = await res.json();
  const free = (data.data || []).filter(m => {
    if (!m.id || !m.id.endsWith(':free')) return false;
    const sp = m.supported_parameters || [];
    return sp.includes('tools');
  });
  free.sort((a, b) => {
    const score = id => {
      for (let i = 0; i < MODEL_PRIORITY.length; i++) if (MODEL_PRIORITY[i].test(id)) return i;
      return MODEL_PRIORITY.length;
    };
    return score(a.id) - score(b.id);
  });
  return free.map(m => m.id);
}

async function getModelChain() {
  if (process.env.OPENROUTER_MODEL) return [process.env.OPENROUTER_MODEL.trim()];

  const now = Date.now();
  if (modelChainCache && !modelChainStale && (now - modelChainAt) < MODEL_CACHE_TTL) {
    return modelChainCache;
  }
  try {
    const ids = await fetchFreeToolModels();
    if (ids.length) {
      modelChainCache = ids.slice(0, 8);
      modelChainAt    = now;
      modelChainStale = false;
      display.log('API', `OpenRouter: ${ids.length} free tool-capable models available — trying top ${modelChainCache.length}`, 'info');
      return modelChainCache;
    }
    throw new Error('no free tool-capable models returned');
  } catch (e) {
    display.log('API', `Could not refresh OpenRouter free-model list (${e.message}) — using static fallback list`, 'warning');
    if (modelChainCache) return modelChainCache; // stale cache beats nothing
    return STATIC_FALLBACK_MODELS;
  }
}

function openrouterKeyMissing() {
  return !OPENROUTER_KEY || OPENROUTER_KEY === 'YOUR_OPENROUTER_API_KEY_HERE';
}

// A stray/placeholder GROQ_API_KEY (left in .env or inherited from shell env)
// must never silently swallow a real OpenRouter error.
function groqKeyUsable() {
  if (!GROQ_KEY) return false;
  if (/^(YOUR_|REPLACE_|<|xxxx)/i.test(GROQ_KEY)) return false;
  if (GROQ_KEY.length < 20) return false; // real Groq keys are long (gsk_... ~56 chars)
  return true;
}

function maskedGroqKey() {
  if (!GROQ_KEY) return '(not set)';
  return GROQ_KEY.length > 10 ? `${GROQ_KEY.slice(0,5)}...${GROQ_KEY.slice(-4)} (${GROQ_KEY.length} chars)` : '(too short)';
}

function maskedOpenRouterKey() {
  if (!OPENROUTER_KEY) return '(not set)';
  return OPENROUTER_KEY.length > 10 ? `${OPENROUTER_KEY.slice(0,7)}...${OPENROUTER_KEY.slice(-4)} (${OPENROUTER_KEY.length} chars)` : '(too short)';
}

// Dumped into error messages so a misconfigured env is never a silent mystery —
// shows exactly what THIS running process sees, which folder it's running from,
// and whether a .env file was actually found there.
function envDiagnostics() {
  const fs   = require('fs');
  const path = require('path');
  const envPath = path.join(process.cwd(), '.env');
  const envFound = fs.existsSync(envPath);
  return `[cwd=${process.cwd()} | .env found=${envFound} (${envPath}) | ` +
         `OPENROUTER_API_KEY=${maskedOpenRouterKey()} | GROQ_API_KEY=${maskedGroqKey()}]`;
}

const conversationHistory = [];
const MAX_HISTORY = 20;
let isProcessing = false;

// ─────────────────────────────────────────────────────────────────────────────
// OPENROUTER API CALL — OpenAI-compatible chat completions with tool calling
// ─────────────────────────────────────────────────────────────────────────────
async function callOpenRouter(messages, tools) {
  if (openrouterKeyMissing() && !GITHUB_TOKEN && !GROQ_KEY) {
    throw new Error('OPENROUTER_API_KEY not set. Get a free key at https://openrouter.ai/keys');
  }

  const chain = await getModelChain();
  const attempts = []; // human-readable per-model failure reasons, for debugging

  for (let i = 0; i < chain.length; i++) {
    const model = chain[i];

    const doFetch = () => fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${OPENROUTER_KEY}`,
        // Optional but recommended by OpenRouter — identifies your app
        'HTTP-Referer':  'http://localhost:7777',
        'X-Title':       'VOYAGER India',
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        temperature: 0.3,
        messages,
        tools,
        tool_choice: 'auto',
      }),
    });

    let res = await doFetch();

    // Free-tier rate limit — wait briefly and retry the same model once
    if (res.status === 429) {
      display.log('API', `OpenRouter rate limit on ${model} — waiting 4s and retrying...`, 'warning');
      await new Promise(r => setTimeout(r, 4000));
      res = await doFetch();
    }

    if (res.ok) {
      const data = await res.json();
      // Some free models occasionally return an error payload with HTTP 200
      if (data.error) {
        const detail = JSON.stringify(data.error).slice(0, 200);
        attempts.push(`${model}: ${detail}`);
        display.log('API', `${model} errored (${detail.slice(0, 90)}), trying next free model...`, 'warning');
        if (data.error.code === 404 || /unavailable for free/i.test(JSON.stringify(data.error))) modelChainStale = true;
        continue;
      }
      if (!data.choices?.length) {
        attempts.push(`${model}: empty choices`);
        continue;
      }
      // Worked — bump this model to the front so future calls try it first
      if (modelChainCache) modelChainCache = [model, ...modelChainCache.filter(m => m !== model)];
      return data; // already OpenAI format — no conversion needed
    }

    const bodyText = await res.text();

    // Auth errors won't be fixed by trying another model — fail fast with clear guidance
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `OpenRouter rejected your API key (HTTP ${res.status}). ` +
        `Fix: 1) Go to https://openrouter.ai/keys  2) Create a key (starts with sk-or-...)  ` +
        `3) Paste it as OPENROUTER_API_KEY in .env (no quotes, no spaces)  4) Restart. ` +
        `Detail: ${bodyText.slice(0, 200)}`
      );
    }

    attempts.push(`${model}: HTTP ${res.status} ${bodyText.slice(0, 150)}`);
    if (res.status === 404 || res.status === 400) modelChainStale = true; // this id may be gone — refetch list next time
    display.log('API', `${model} unavailable (HTTP ${res.status}), trying next free model...`, 'warning');
  }

  modelChainStale = true; // full failure → refetch the free-model list on the next call
  throw new Error(
    `All ${chain.length} free OpenRouter models tried failed for this request ` +
    `(NOT a key problem if 'testkey' passed — the free lineup just rotated). ` +
    `Attempts — ${attempts.join(' | ')}`
  );
}

const GITHUB_TOKEN = cleanKey(process.env.GITHUB_TOKEN);

async function callGitHubModels(messages, tools) {
  if (!GITHUB_TOKEN) throw new Error('No GITHUB_TOKEN set');
  const res = await fetch('https://models.inference.ai.azure.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 4096,
      messages,
      tools,
      tool_choice: 'auto'
    })
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub Models API error ${res.status}: ${err}`);
  }
  return res.json();
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
  {
    type: 'function',
    function: {
      name: 'run_itinerary_swarm',
      description: 'Generate a validated multi-modal (flight+rail) itinerary for an India trip using the dedicated planning swarm. Use this when the user asks to plan, book, or build a trip/itinerary between two or more cities.',
      parameters: {
        type: 'object',
        properties: {
          user_prompt: { type: 'string', description: 'The full natural-language trip request, verbatim' },
        },
        required: ['user_prompt'],
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

    case 'run_itinerary_swarm': {
      display.log('SWARM', 'Calling itinerary planning swarm (Groq)...', 'info');
      dash.emit('agent_activated', { agent: 'itinerary_planner', status: 'active' });

      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 60000);
      let res;
      try {
        //res = await fetch('http://localhost:8000/run-swarm', 
        // CHANGE THIS LINE:
        const backendUrl = process.env.VITE_API_URL || process.env.API_URL || 'https://voyager-backend-n16e.onrender.com';
        res = await fetch(`${backendUrl}/run-swarm`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_prompt: input.user_prompt }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(t);
      }
      if (!res.ok) throw new Error(`Swarm API error: HTTP ${res.status}`);
      const data = await res.json();

      dash.emit('itinerary_result', data);
      dash.emit('agent_activated', { agent: 'itinerary_planner', status: data.is_validated ? 'idle' : 'standby' });
      display.log('SWARM', data.is_validated ? '✓ Itinerary validated' : '⚠ Validation issues', data.is_validated ? 'success' : 'warning');

      return data;
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// COMMAND HANDLER — agentic loop with OpenRouter (free) / Groq fallback
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

      // Try OpenRouter first (free models), fall back to Groq only if it has a real,
      // usable key — a stray/placeholder GROQ_API_KEY must never hide the real error.
      let usingGroqAsPrimary = false;
      try {
        if (GITHUB_TOKEN) {
          response = await callGitHubModels(messages, TOOLS);
        } else if (groqKeyUsable()) {
          usingGroqAsPrimary = true;
          display.log('WARN', `OPENROUTER_API_KEY appears empty/missing to this process — using Groq (${maskedGroqKey()}) instead. ${envDiagnostics()}`, 'warning');
          response = await callGroq(messages, TOOLS);
        } else {
          throw new Error(`OPENROUTER_API_KEY not set and no usable GROQ_API_KEY fallback. ${envDiagnostics()}`);
        }
      } catch (apiErr) {
        if (usingGroqAsPrimary) {
          // Groq was used as primary (because OpenRouter key looked missing) and it ALSO failed.
          throw new Error(
            `OPENROUTER_API_KEY is empty/missing to this process, so Groq was used instead — and Groq failed too: ` +
            `${apiErr.message}. ${envDiagnostics()}`
          );
        }
        if (groqKeyUsable() && !apiErr.message.includes('Groq')) {
          display.log('WARN', `OpenRouter failed — full reason: ${apiErr.message}`, 'warning');
          display.log('WARN', `Trying Groq fallback (GROQ_API_KEY ${maskedGroqKey()})...`, 'warning');
          try {
            response = await callGroq(messages, TOOLS);
          } catch (groqErr) {
            // Combine both so neither error gets silently swallowed
            throw new Error(
              `OpenRouter failed: ${apiErr.message} | ` +
              `Groq fallback (key ${maskedGroqKey()}) also failed: ${groqErr.message}`
            );
          }
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
    // Provide clear actionable error messages — only for ACTUAL key problems,
    // not generic errors that happen to contain "401" somewhere in a JSON body.
    if (msg.startsWith('OPENROUTER_API_KEY not set') || msg.startsWith('OpenRouter rejected your API key')) {
      const helpMsg = 'API key error. Get a FREE OpenRouter key at https://openrouter.ai/keys → paste it as OPENROUTER_API_KEY in your .env file → restart.';
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

// ─────────────────────────────────────────────────────────────────────────────
// KEY SELF-TEST — minimal ping to verify the OpenRouter key works
// ─────────────────────────────────────────────────────────────────────────────
async function verifyOpenRouter() {
  if (openrouterKeyMissing() && !GITHUB_TOKEN && !GROQ_KEY) {
    return { ok: false, reason: 'OPENROUTER_API_KEY not set in .env. Get one free: https://openrouter.ai/keys' };
  }
  let chain;
  try {
    chain = await getModelChain();
  } catch (_) {
    chain = STATIC_FALLBACK_MODELS;
  }

  let lastReason = '';
  for (const model of chain) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${OPENROUTER_KEY}`,
          'HTTP-Referer':  'http://localhost:7777',
          'X-Title':       'VOYAGER India',
        },
        body: JSON.stringify({
          model,
          max_tokens: 5,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      });
      if (res.ok) {
        const data = await res.json();
        if (!data.error) return { ok: true, model, chainSize: chain.length };
        lastReason = JSON.stringify(data.error).slice(0, 150);
        continue; // model-level error → try next
      }
      const txt = await res.text();
      if (res.status === 401 || res.status === 403) {
        return { ok: false, reason: `Key rejected (HTTP ${res.status}). Generate a fresh key at https://openrouter.ai/keys (starts with sk-or-...) and paste it into .env with no quotes/spaces. Detail: ${txt.slice(0, 150)}` };
      }
      if (res.status === 404 || res.status === 400) { lastReason = `Model ${model} unavailable`; continue; }
      if (res.status === 429) { lastReason = 'Rate limited — key is valid, just busy. Try again in a minute.'; return { ok: true, model, warning: lastReason }; }
      return { ok: false, reason: `HTTP ${res.status}: ${txt.slice(0, 150)}` };
    } catch (e) {
      return { ok: false, reason: `Network error: ${e.message}` };
    }
  }
  return { ok: false, reason: `No free model in the chain (${chain.length} tried) responded. Last: ${lastReason}` };
}

module.exports = { handleCommand, TOOLS, verifyOpenRouter, getModelChain };
