'use strict';
const http = require('http');
const fs   = require('fs');
const path = require('path');
const WebSocket = require('ws');
const fetch = require('node-fetch');

let wss = null;
const clients = new Set();
const eventLog = []; // last 200 events kept for late-joining clients

const commandHandlers = []; // callbacks for incoming user commands

function onCommand(handler) {
  commandHandlers.push(handler);
}

/* ─── Simple in-memory cache to conserve free-tier API quotas ───
 * AviationStack free tier = 100 req/month. IRCTC RapidAPI free tier is also limited.
 * Cache responses for 10 minutes per unique query. */
const apiCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;
function cacheGet(key) {
  const hit = apiCache.get(key);
  if (hit && (Date.now() - hit.ts) < CACHE_TTL_MS) return hit.data;
  return null;
}
function cacheSet(key, data) {
  apiCache.set(key, { data, ts: Date.now() });
}
function todayDDMMYYYY() {
  const d = new Date();
  // Use IST (UTC+5:30) for Indian rail schedules
  const ist = new Date(d.getTime() + (5.5 * 60 - d.getTimezoneOffset()) * 60000);
  const dd = String(ist.getDate()).padStart(2, '0');
  const mm = String(ist.getMonth() + 1).padStart(2, '0');
  const yyyy = ist.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

/* GET /api/flights?from=DEL&to=BOM
 * Proxies AviationStack /v1/flights (free tier = HTTP only, no HTTPS) */
async function handleFlights(req, res, query) {
  const from = (query.from || '').toUpperCase();
  const to   = (query.to || '').toUpperCase();
  if (!from || !to) { res.writeHead(400, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:'from and to required'})); return; }
  const key = process.env.AVIATIONSTACK_KEY;
  if (!key) { res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({flights:[], error:'AVIATIONSTACK_KEY not configured'})); return; }
  const cacheKey = `flights:${from}:${to}`;
  const cached = cacheGet(cacheKey);
  if (cached) { res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify(cached)); return; }
  try {
    const url = `http://api.aviationstack.com/v1/flights?access_key=${key}&dep_iata=${from}&arr_iata=${to}&limit=10`;
    const r = await fetch(url, { timeout: 10000 });
    const j = await r.json();
    if (j.error) {
      const out = { flights: [], error: j.error.message || j.error.code || 'AviationStack error' };
      res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify(out));
      return;
    }
    let flights = (j.data || []).map(f => ({
      airline: f.airline?.name || 'Unknown',
      airlineIata: (f.airline?.iata || '').toUpperCase(),
      flightNum: f.flight?.iata || f.flight?.number || '',
      status: f.flight_status || 'unknown',
      depScheduled: f.departure?.scheduled || null,
      depEstimated: f.departure?.estimated || null,
      depActual: f.departure?.actual || null,
      depDelay: f.departure?.delay ?? null,
      arrScheduled: f.arrival?.scheduled || null,
      arrEstimated: f.arrival?.estimated || null,
      arrDelay: f.arrival?.delay ?? null,
      terminal: f.departure?.terminal || null,
      gate: f.departure?.gate || null,
    }));

    // This is a DOMESTIC India app. AviationStack returns codeshares — the same
    // physical flight marketed by several (often international) carriers with
    // identical dep/arr times. Keep only Indian domestic operators, then dedupe
    // by departure+arrival signature so one flight isn't listed five times.
    const DOMESTIC_IATA = ['6E','AI','IX','UK','SG','QP','9I','S5','S9','I5','G8'];
    const DOMESTIC_NAME = /indigo|air india|spicejet|vistara|akasa|alliance air|star air|flybig|go ?first|airasia/i;
    const isDomestic = f => DOMESTIC_IATA.includes(f.airlineIata) || DOMESTIC_NAME.test(f.airline || '');
    const domestic = flights.filter(isDomestic);
    if (domestic.length) flights = domestic; // only narrow when we still have results
    const seen = new Set();
    flights = flights.filter(f => {
      const sig = `${f.depScheduled || ''}|${f.arrScheduled || ''}`;
      if (seen.has(sig)) return false;
      seen.add(sig);
      return true;
    });
    const out = { flights, fetchedAt: new Date().toISOString() };
    cacheSet(cacheKey, out);
    res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify(out));
  } catch (e) {
    res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({flights:[], error: e.message}));
  }
}

/* GET /api/trains?from=NDLS&to=BCT
 * Proxies IRCTC1 RapidAPI trainBetweenStations */
async function handleTrains(req, res, query) {
  const from = (query.from || '').toUpperCase();
  const to   = (query.to || '').toUpperCase();
  if (!from || !to) { res.writeHead(400, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:'from and to required'})); return; }
  const key = process.env.IRCTC_RAPIDAPI_KEY;
  if (!key) { res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({trains:[], error:'IRCTC_RAPIDAPI_KEY not configured'})); return; }
  const date = todayDDMMYYYY();
  const cacheKey = `trains:${from}:${to}:${date}`;
  const cached = cacheGet(cacheKey);
  if (cached) { res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify(cached)); return; }
  try {
    const url = `https://irctc1.p.rapidapi.com/api/v3/trainBetweenStations?fromStationCode=${from}&toStationCode=${to}&dateOfJourney=${date}`;
    const r = await fetch(url, {
      timeout: 10000,
      headers: {
        'X-RapidAPI-Key': key,
        'X-RapidAPI-Host': 'irctc1.p.rapidapi.com',
      }
    });
    const j = await r.json();
    if (j.status === false) {
      const out = { trains: [], error: j.message || 'IRCTC API error' };
      res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify(out));
      return;
    }
    const trains = (j.data || []).map(t => ({
      number: t.train_number,
      name: t.train_name,
      depTime: t.from_std,
      arrTime: t.to_std,
      duration: t.duration,
      fromStation: t.from_station_name,
      toStation: t.to_station_name,
      runDays: t.run_days || null,
      classes: t.class_type || null,
    }));
    const out = { trains, date, fetchedAt: new Date().toISOString() };
    cacheSet(cacheKey, out);
    res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify(out));
  } catch (e) {
    res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({trains:[], error: e.message}));
  }
}

function start(port = 7777) {
  if (wss) return; // idempotent

  const server = http.createServer((req, res) => {
    const [urlPath, qs] = req.url.split('?');
    const url = urlPath;
    const query = {};
    if (qs) for (const pair of qs.split('&')) {
      const [k,v] = pair.split('=');
      query[decodeURIComponent(k)] = decodeURIComponent(v||'');
    }

    if (url === '/' || url === '/dashboard') {
      const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'dashboard.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
      return;
    }

    if (url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        uptime: process.uptime(),
        connectedClients: clients.size,
        eventsBuffered: eventLog.length,
      }));
      return;
    }

    if (url === '/api/flights') { handleFlights(req, res, query); return; }
    if (url === '/api/trains')  { handleTrains(req, res, query); return; }

    if (url === '/api/state') {
      try {
        const dataDir = path.join(process.cwd(), 'data');
        const state = fs.existsSync(path.join(dataDir, 'monitoring-state.json'))
          ? JSON.parse(fs.readFileSync(path.join(dataDir, 'monitoring-state.json'), 'utf8'))
          : null;
        const alerts = fs.existsSync(path.join(dataDir, 'alerts.json'))
          ? JSON.parse(fs.readFileSync(path.join(dataDir, 'alerts.json'), 'utf8'))
          : [];
        const metrics = require('./memory').getMetricsSummary();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ state, alerts: alerts.slice(-10), metrics }));
      } catch (e) {
        res.writeHead(500); res.end(e.message);
      }
      return;
    }

    res.writeHead(404); res.end('Not found');
  });

  wss = new WebSocket.Server({ server });

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.send(JSON.stringify({ type: 'replay', events: eventLog }));
    ws.send(JSON.stringify({ type: 'welcome', timestamp: new Date().toISOString() }));

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        // Dashboard → server: command from UI
        if (msg.type === 'command' && msg.text) {
          for (const handler of commandHandlers) {
            handler(msg.text, 'dashboard');
          }
        }
      } catch (_) {}
    });

    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });

  server.listen(port, () => {
    console.log(`\n  🌐 Dashboard online → http://localhost:${port}\n`);
  });

  return server;
}

function broadcast(event) {
  const enriched = { ...event, timestamp: new Date().toISOString() };
  eventLog.push(enriched);
  if (eventLog.length > 200) eventLog.shift();

  const message = JSON.stringify(enriched);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(message); } catch (_) {}
    }
  }
}

const dash = {
  start, onCommand,
  agent:       (name, status)        => broadcast({ type: 'agent_status', agent: name, status }),
  log:         (agent, message, level = 'info') => broadcast({ type: 'log', agent, message, level }),
  toolCall:    (name, input)         => broadcast({ type: 'tool_call', name, input }),
  toolResult:  (name, success, data) => broadcast({ type: 'tool_result', name, success, data }),
  weather:     (data)                => broadcast({ type: 'weather', data }),
  airQuality:  (data)                => broadcast({ type: 'air_quality', data }),
  earthquakes: (data)                => broadcast({ type: 'earthquakes', data }),
  alert:       (severity, message)   => broadcast({ type: 'alert', severity, message }),
  ipcSignal:   (path, payload)       => broadcast({ type: 'ipc_signal', path, payload }),
  tokens:      (usage)               => broadcast({ type: 'tokens', usage }),
  changes:     (deltas)              => broadcast({ type: 'changes', deltas }),
  thinking:    (text)                => broadcast({ type: 'thinking', text }),
  reply:       (text)                => broadcast({ type: 'reply', text }),
  cycleStart:  (destination, coords) => broadcast({ type: 'cycle_start', destination, coords }),
  cycleEnd:    (durationMs)          => broadcast({ type: 'cycle_end', durationMs }),
  state:       (state)               => broadcast({ type: 'state', state }),
  sound:       (cue)                 => broadcast({ type: 'sound', cue }),
  lockOn:      (coords, label)       => broadcast({ type: 'lock_on', coords, label }),
  speak:       (text)                => broadcast({ type: 'speak', text }),
  emit:        (type, data)          => broadcast({ type, ...data }),
};

module.exports = dash;
