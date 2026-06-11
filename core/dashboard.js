'use strict';
const http = require('http');
const fs   = require('fs');
const path = require('path');
const WebSocket = require('ws');

let wss = null;
const clients = new Set();
const eventLog = []; // last 200 events kept for late-joining clients

const commandHandlers = []; // callbacks for incoming user commands

function onCommand(handler) {
  commandHandlers.push(handler);
}

function start(port = 7777) {
  if (wss) return; // idempotent

  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];

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
