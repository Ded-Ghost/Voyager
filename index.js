#!/usr/bin/env node
'use strict';
require('dotenv').config();

const chalk   = require('chalk');
const display = require('./core/display');
const ipc     = require('./core/ipc');
const memory  = require('./core/memory');

const [,, command, ...args] = process.argv;

// ─────────────────────────────────────────────────────────────────────────────
// Default: BOOT — launches dashboard + shell + orchestrator
// ─────────────────────────────────────────────────────────────────────────────

if (!command || command === 'boot' || command === 'start') {
  display.header();

  if (!process.env.ANTHROPIC_API_KEY) {
    display.fatalError('ANTHROPIC_API_KEY not set. Copy .env.example → .env and add your key.');
    process.exit(1);
  }

  const dash         = require('./core/dashboard');
  const shell        = require('./core/shell');
  const orchestrator = require('./core/orchestrator');
  const sys          = require('./tools/system-actions');

  // 1. Start the dashboard server
  const port = parseInt(process.env.DASHBOARD_PORT || '7777', 10);
  dash.start(port);

  // 2. Boot announcement
  setTimeout(() => {
    dash.sound('boot');
    dash.agent('Orchestrator', 'idle');
    dash.log('SYSTEM', 'VOYAGER online. Awaiting commands.', 'info');
  }, 600);

  // 3. Auto-open the dashboard in browser (best effort, non-blocking)
  if (process.env.AUTO_OPEN_DASHBOARD !== 'false') {
    setTimeout(() => {
      sys.openTarget(`http://localhost:${port}`).catch(() => {});
    }, 1200);
  }

  // 4. Start the interactive shell
  display.log('SYSTEM', chalk.cyan(`Dashboard: http://localhost:${port}`), 'success');
  display.log('SYSTEM', chalk.cyan(`Shell active. Type commands in plain English.`), 'success');
  display.log('SYSTEM', chalk.gray(`Try: "monitor Tokyo next week"   or   /help for built-ins`), 'info');

  shell.start();

  // 5. Spoken boot greeting (if TTS enabled)
  if (sys.isTtsEnabled()) {
    setTimeout(() => sys.speak('Voyager online. Standing by.').catch(() => {}), 800);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Other commands
// ─────────────────────────────────────────────────────────────────────────────

else if (command === 'status') {
  display.header();
  const state  = ipc.readState();
  const alerts = ipc.readAlerts();
  const signal = ipc.readSignal();

  if (!state) display.log('STATUS', 'No monitoring state. Run VOYAGER and command a destination.', 'warning');
  else {
    display.log('STATUS', `Destination : ${state.destination}`, 'info');
    display.log('STATUS', `Status      : ${state.status}`, state.status === 'alert' ? 'alert' : 'success');
    display.log('STATUS', `Summary     : ${state.conditions_summary || 'N/A'}`, 'info');
    display.log('STATUS', `Last update : ${state.lastUpdated}`, 'info');
  }
  display.separator();
  display.log('ALERTS', `Total logged: ${alerts.length}`, 'info');
  if (signal) {
    display.log('IPC', chalk.red('⚠  Pending disruption signal'), 'alert');
    display.log('IPC', `Type: ${signal.disruption_type} | Severity: ${signal.severity}`, 'alert');
  }
}

else if (command === 'metrics') {
  display.header();
  const m = memory.getMetricsSummary();
  if (!m) display.log('METRICS', 'No metrics yet.', 'warning');
  else {
    display.log('METRICS', `API calls      : ${m.apiCalls}`, 'info');
    display.log('METRICS', `Input tokens   : ${m.totals.input.toLocaleString()}`, 'info');
    display.log('METRICS', `Output tokens  : ${m.totals.output.toLocaleString()}`, 'info');
    display.log('METRICS', `Estimated cost : $${m.estimatedCostUsd}`, 'data');
  }
}

else {
  display.header();
  console.log(chalk.cyan('  Usage:\n'));
  console.log('  ' + chalk.bold.white('node index.js'.padEnd(20)) + chalk.gray('Launch VOYAGER (dashboard + shell)'));
  console.log('  ' + chalk.bold('node index.js status') + chalk.gray('   Print current state'));
  console.log('  ' + chalk.bold('node index.js metrics') + chalk.gray('  Show token usage & cost\n'));
  console.log(chalk.gray('  Once running, type commands in plain English at the VOYAGER ▸ prompt'));
  console.log(chalk.gray('  or use the command bar in the dashboard at http://localhost:7777\n'));
}
