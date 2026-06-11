'use strict';
const fs   = require('fs');
const path = require('path');

const DATA_DIR      = path.join(process.cwd(), 'data');
const SIGNAL_FILE   = path.join(DATA_DIR, 'disruption-signal.json');
const STATE_FILE    = path.join(DATA_DIR, 'monitoring-state.json');
const ALERTS_FILE   = path.join(DATA_DIR, 'alerts.json');
const COORD_FILE    = path.join(DATA_DIR, 'coordination-log.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ── WRITE ──────────────────────────────────────────────────────────────────

function writeSignal(payload) {
  ensureDataDir();
  const signal = { ...payload, timestamp: new Date().toISOString(), version: 1 };
  fs.writeFileSync(SIGNAL_FILE, JSON.stringify(signal, null, 2));
  return { path: SIGNAL_FILE, signal };
}

function writeState(payload) {
  ensureDataDir();
  const state = { ...payload, lastUpdated: new Date().toISOString() };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  return { path: STATE_FILE };
}

function appendAlert(payload) {
  ensureDataDir();
  let alerts = [];
  try { alerts = JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf8')); } catch (_) {}
  alerts.push({ ...payload, timestamp: new Date().toISOString() });
  fs.writeFileSync(ALERTS_FILE, JSON.stringify(alerts, null, 2));
  return { path: ALERTS_FILE, totalAlerts: alerts.length };
}

function writeCoordinationLog(messages) {
  ensureDataDir();
  let log = [];
  try { log = JSON.parse(fs.readFileSync(COORD_FILE, 'utf8')); } catch (_) {}
  log.push({ messages, timestamp: new Date().toISOString() });
  fs.writeFileSync(COORD_FILE, JSON.stringify(log, null, 2));
  return { path: COORD_FILE };
}

// ── READ ───────────────────────────────────────────────────────────────────

function readSignal() {
  if (!fs.existsSync(SIGNAL_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(SIGNAL_FILE, 'utf8')); } catch (_) { return null; }
}

function readState() {
  if (!fs.existsSync(STATE_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (_) { return null; }
}

function readAlerts() {
  if (!fs.existsSync(ALERTS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf8')); } catch (_) { return []; }
}

// ── WATCH (for Re-Router activation) ──────────────────────────────────────

function watchForSignal(callback) {
  ensureDataDir();
  // Poll every 5 seconds since fs.watch can be unreliable across platforms
  let lastMtime = null;
  const interval = setInterval(() => {
    if (!fs.existsSync(SIGNAL_FILE)) return;
    const stat = fs.statSync(SIGNAL_FILE);
    const mtime = stat.mtimeMs;
    if (lastMtime !== null && mtime !== lastMtime) {
      const signal = readSignal();
      if (signal) callback(signal);
    }
    lastMtime = mtime;
  }, 5000);
  return interval; // call clearInterval(interval) to stop watching
}

// ── SAFE FILE READ (for local system files) ───────────────────────────────

const ALLOWED_DIRS = [
  DATA_DIR,
  path.join(process.cwd(), 'itineraries'),
  process.env.ITINERARY_DIR || '',
].filter(Boolean).map(d => path.resolve(d));

function safeRead(filePath) {
  const resolved = path.resolve(filePath);
  const allowed = ALLOWED_DIRS.some(d => resolved.startsWith(d));
  if (!allowed) {
    return { ok: false, error: `Access denied: ${filePath} is outside allowed directories.` };
  }
  if (!fs.existsSync(resolved)) {
    return { ok: false, error: `File not found: ${resolved}` };
  }
  try {
    const content = fs.readFileSync(resolved, 'utf8');
    return { ok: true, path: resolved, content };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function safeWrite(filePath, content) {
  const resolved = path.resolve(filePath);
  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(resolved, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  return { ok: true, path: resolved };
}

module.exports = {
  SIGNAL_FILE, STATE_FILE, ALERTS_FILE,
  writeSignal, writeState, appendAlert, writeCoordinationLog,
  readSignal, readState, readAlerts,
  watchForSignal,
  safeRead, safeWrite,
};
