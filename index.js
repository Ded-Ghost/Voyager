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

  // First thing, always — so a "works in one terminal, not another" mismatch is obvious.
  {
    const fs = require('fs');
    const envPath = require('path').join(process.cwd(), '.env');
    const envFound = fs.existsSync(envPath);
    display.log('ENV', chalk.gray(`Running from: ${process.cwd()}`), 'info');
    display.log('ENV', envFound ? chalk.gray(`.env found: ${envPath}`) : chalk.red(`.env NOT FOUND at ${envPath} — run this command from the voyager-agents folder!`), envFound ? 'info' : 'alert');
  }

  const hasOpenRouter = process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_API_KEY !== 'YOUR_OPENROUTER_API_KEY_HERE';
  const hasGroq       = !!process.env.GROQ_API_KEY;
  if (!hasOpenRouter && !hasGroq) {
    display.fatalError('No AI API key set. Get a FREE OpenRouter key at https://openrouter.ai/keys\nThen set OPENROUTER_API_KEY in .env');
    process.exit(1);
  }
  if (hasOpenRouter) {
    const k = process.env.OPENROUTER_API_KEY.trim();
    const masked = k.length > 10 ? `${k.slice(0,7)}...${k.slice(-4)} (${k.length} chars)` : '(too short — check .env)';
    display.log('API', chalk.green(`OpenRouter key found — verifying... [${masked}]`), 'info');
  } else {
    display.log('API', chalk.red(`OPENROUTER_API_KEY not set or empty — this process will use Groq (if configured) or fail.`), 'alert');
  }

  // Surface whether a Groq fallback key is present, and where it came from —
  // helps catch a stray key left over in the shell environment that .env can't override.
  if (hasGroq) {
    const gk = process.env.GROQ_API_KEY.trim();
    const gmasked = gk.length > 10 ? `${gk.slice(0,5)}...${gk.slice(-4)} (${gk.length} chars)` : '(too short)';
    const inEnvFile = (() => {
      try {
        const fs = require('fs');
        const envPath = require('path').join(process.cwd(), '.env');
        const content = fs.readFileSync(envPath, 'utf8');
        const line = content.split('\n').find(l => l.trim().startsWith('GROQ_API_KEY='));
        return line && line.split('=')[1]?.trim();
      } catch (_) { return null; }
    })();
    if (!inEnvFile) {
      display.log('API', chalk.yellow(`GROQ_API_KEY ${gmasked} is set as a FALLBACK, but is NOT in your .env file — it's coming from your shell environment. If you didn't intend to use Groq, run: unset GROQ_API_KEY (then restart).`), 'warning');
    } else {
      display.log('API', chalk.cyan(`Groq fallback key configured: ${gmasked}`), 'info');
    }
  }

  const dash         = require('./core/dashboard');
  const shell        = require('./core/shell');
  const orchestrator = require('./core/orchestrator');
  const sys          = require('./tools/system-actions');

  // Verify the OpenRouter key in the background and report clearly
  if (hasOpenRouter) {
    orchestrator.verifyOpenRouter().then(r => {
      if (r.ok) {
        display.log('API', chalk.green(`✓ OpenRouter key VALID — using model: ${r.model} (FREE)`), 'success');
        dash.log('SYSTEM', `OpenRouter connected (${r.model})`, 'success');
      } else {
        display.log('API', chalk.red(`✗ OpenRouter key FAILED: ${r.reason}`), 'alert');
        dash.log('SYSTEM', `OpenRouter key failed: ${r.reason}`, 'alert');
        if (hasGroq) display.log('API', chalk.yellow('Will fall back to Groq for commands.'), 'warning');
      }
    }).catch(() => {});
  }

  // 1. Start the dashboard server
  const port = parseInt(process.env.DASHBOARD_PORT || '7777', 10);
  dash.start(port);

  // 2. Boot announcement
  setTimeout(() => {
    dash.sound('boot');
    dash.agent('Orchestrator', 'idle');
    dash.log('SYSTEM', 'VOYAGER India online. Awaiting commands.', 'info');
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
  display.log('SYSTEM', chalk.gray(`Try: "monitor Mumbai next week"  or  "check air quality Delhi"  or  /help`), 'info');

  shell.start();
}

// ─────────────────────────────────────────────────────────────────────────────
// Other commands
// ─────────────────────────────────────────────────────────────────────────────

else if (command === 'testkey') {
  display.header();
  display.log('TEST', 'Verifying OPENROUTER_API_KEY from .env ...', 'info');
  const { verifyOpenRouter } = require('./core/orchestrator');
  verifyOpenRouter().then(r => {
    if (r.ok) {
      display.log('TEST', chalk.green(`✓ KEY WORKS — model: ${r.model}. You're good to go: npm start`), 'success');
    } else {
      display.log('TEST', chalk.red(`✗ KEY FAILED`), 'alert');
      display.log('TEST', chalk.red(r.reason), 'alert');
      console.log(chalk.yellow('\n  How to fix:'));
      console.log(chalk.white('  1. Open https://openrouter.ai/keys'));
      console.log(chalk.white('  2. Click "Create Key" (key starts with sk-or-...)'));
      console.log(chalk.white('  3. In .env set:  OPENROUTER_API_KEY=sk-or-...   (no quotes, no spaces)'));
      console.log(chalk.white('  4. Run:  node index.js testkey\n'));
    }
    process.exit(r.ok ? 0 : 1);
  });
}

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

else if (command === 'models') {
  display.header();
  display.log('MODELS', 'Querying OpenRouter for currently free, tool-capable models...', 'info');
  const { getModelChain } = require('./core/orchestrator');
  getModelChain().then(chain => {
    if (!chain.length) {
      display.log('MODELS', 'No models returned — check OPENROUTER_API_KEY.', 'alert');
    } else {
      display.log('MODELS', `${chain.length} model(s) in the current chain (tried in this order):`, 'success');
      chain.forEach((m, i) => display.log('MODELS', `  ${i + 1}. ${m}`, 'info'));
    }
    process.exit(0);
  }).catch(e => {
    display.log('MODELS', `Error: ${e.message}`, 'alert');
    process.exit(1);
  });
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
  console.log('  ' + chalk.bold('node index.js models') + chalk.gray('   List currently free, tool-capable OpenRouter models'));
  console.log('  ' + chalk.bold('node index.js metrics') + chalk.gray('  Show token usage & cost\n'));
  console.log(chalk.gray('  Once running, type commands in plain English at the VOYAGER ▸ prompt'));
  console.log(chalk.gray('  or use the command bar in the dashboard at http://localhost:7777\n'));
}

// Keep the cloud background process alive permanently
setInterval(() => {}, 1000 * 60 * 60);