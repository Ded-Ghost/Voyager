'use strict';
const { exec, execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const platform = os.platform();
const escape   = s => String(s).replace(/'/g, "'\\''").replace(/"/g, '\\"');

// ─── TTS ────────────────────────────────────────────────────────────────────
let ttsEnabled = process.env.TTS_ENABLED !== 'false';

function setTtsEnabled(on) { ttsEnabled = !!on; return ttsEnabled; }
function isTtsEnabled() { return ttsEnabled; }

function speak(text) {
  if (!ttsEnabled || !text) return Promise.resolve({ ok: false, muted: true });
  const safe = escape(text).slice(0, 400);
  let cmd;
  if (platform === 'darwin') {
    cmd = `say "${safe}"`;
  } else if (platform === 'win32') {
    cmd = `powershell -NoProfile -Command "Add-Type -AssemblyName System.Speech; ` +
          `$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ` +
          `$s.Rate = 1; $s.Speak('${safe}')"`;
  } else {
    // Try spd-say first (modern Linux), then espeak as fallback
    cmd = `spd-say "${safe}" 2>/dev/null || espeak "${safe}" 2>/dev/null`;
  }
  return new Promise((resolve) => {
    exec(cmd, { timeout: 30000 }, (err) => {
      resolve({ ok: !err, platform, spoken: text.slice(0, 100), muted: false });
    });
  });
}

// ─── CLIPBOARD ──────────────────────────────────────────────────────────────
function writeClipboard(text) {
  return new Promise((resolve, reject) => {
    let cmd, input = text;
    if (platform === 'darwin')        cmd = 'pbcopy';
    else if (platform === 'win32')    cmd = 'clip';
    else                              cmd = 'xclip -selection clipboard 2>/dev/null || xsel --clipboard --input 2>/dev/null || wl-copy 2>/dev/null';
    const child = exec(cmd, (err) => err ? reject(err) : resolve({ ok: true, platform, bytes: text.length }));
    child.stdin.write(input);
    child.stdin.end();
  });
}

function readClipboard() {
  return new Promise((resolve, reject) => {
    let cmd;
    if (platform === 'darwin')        cmd = 'pbpaste';
    else if (platform === 'win32')    cmd = 'powershell -NoProfile -Command "Get-Clipboard"';
    else                              cmd = 'xclip -selection clipboard -o 2>/dev/null || xsel --clipboard --output 2>/dev/null || wl-paste 2>/dev/null';
    exec(cmd, { timeout: 5000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve({ ok: true, platform, content: (stdout || '').trim() });
    });
  });
}

// ─── OPEN FILE / FOLDER / APP / URL ────────────────────────────────────────
function openTarget(target) {
  return new Promise((resolve, reject) => {
    let cmd;
    if (platform === 'darwin')        cmd = `open "${escape(target)}"`;
    else if (platform === 'win32')    cmd = `start "" "${target.replace(/"/g, '""')}"`;
    else                              cmd = `xdg-open "${escape(target)}"`;
    exec(cmd, { timeout: 8000 }, (err) => {
      if (err) reject(err);
      else resolve({ ok: true, platform, opened: target });
    });
  });
}

// ─── .ICS CALENDAR ──────────────────────────────────────────────────────────
function generateIcs({ title, description, location, startDate, endDate, filename }) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const fmt = d => d.replace(/-/g, '');

  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//VOYAGER//Travel Intelligence//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:voyager-${Date.now()}@local`,
    `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${fmt(startDate)}`,
    `DTEND;VALUE=DATE:${fmt(endDate)}`,
    `SUMMARY:${title}`,
    `DESCRIPTION:${(description || '').replace(/\n/g, '\\n')}`,
    `LOCATION:${location || ''}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  const outDir = path.join(process.cwd(), 'data', 'calendars');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, filename || `trip-${Date.now()}.ics`);
  fs.writeFileSync(file, ics);
  return { ok: true, path: file, bytes: ics.length };
}

module.exports = {
  speak, setTtsEnabled, isTtsEnabled,
  writeClipboard, readClipboard,
  openTarget,
  generateIcs,
  platform,
};
