'use strict';
const chalk = require('chalk');

const BANNER = `
╔═══════════════════════════════════════════════════════════════════╗
║   V O Y A G E R   —   Travel Intelligence System                  ║
║   Microsoft AI Build Challenge  │  Multi-Agent  v1.0              ║
╚═══════════════════════════════════════════════════════════════════╝`;

function header() {
  console.log(chalk.cyan(BANNER));
  console.log('');
}

function separator(char = '─', width = 70) {
  console.log(chalk.gray(char.repeat(width)));
}

function agentRow(name, status) {
  const icons = {
    active:     chalk.green('●'),
    monitoring: chalk.yellow('◉'),
    alert:      chalk.red('⚠'),
    thinking:   chalk.cyan('◌'),
    done:       chalk.green('✓'),
    idle:       chalk.gray('○'),
    error:      chalk.red('✗'),
  };
  const icon = icons[status] || chalk.gray('○');
  const label = chalk.bold(name.padEnd(36));
  const state = chalk.gray(status.toUpperCase());
  console.log(`  ${icon}  ${label} ${state}`);
}

function log(agent, message, level = 'info') {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const ts   = chalk.gray(`[${now}]`);
  const colors = {
    info:    chalk.cyan,
    success: chalk.green,
    warning: chalk.yellow,
    alert:   chalk.red,
    data:    chalk.blue,
    ipc:     chalk.magenta,
    tool:    chalk.blueBright,
  };
  const colorFn = colors[level] || chalk.white;
  const tag = chalk.bold(colorFn(`[${agent}]`));
  console.log(`${ts} ${tag} ${message}`);
}

function toolCall(name, input) {
  const short = JSON.stringify(input).slice(0, 60);
  log('TOOL', chalk.blueBright(`→ ${name}`) + chalk.gray(`(${short}...)`), 'tool');
}

function toolResult(name, success) {
  const mark = success ? chalk.green('✓') : chalk.red('✗');
  log('TOOL', `${mark} ${name}`, success ? 'success' : 'alert');
}

function weatherTable(data) {
  console.log('');
  separator();
  console.log(chalk.bold.cyan('  WEATHER INTELLIGENCE REPORT'));
  console.log(chalk.gray(`  Destination: ${data.location}`));
  console.log(chalk.gray(`  Current: ${data.current.tempC}°C — ${data.current.condition}`));
  separator();
  console.log(
    '  ' +
    chalk.bold('Day'.padEnd(8)) +
    chalk.bold('Condition'.padEnd(26)) +
    chalk.bold('Temp'.padEnd(14)) +
    chalk.bold('Rain%'.padEnd(10)) +
    chalk.bold('Wind km/h')
  );
  separator('·');
  data.forecast.forEach((day, i) => {
    const rainColor =
      day.maxChanceOfRain > 65 ? chalk.red :
      day.maxChanceOfRain > 30 ? chalk.yellow :
      chalk.green;
    console.log(
      '  ' +
      `Day ${i + 1}`.padEnd(8) +
      day.description.slice(0, 24).padEnd(26) +
      `${day.minTempC}–${day.maxTempC}°C`.padEnd(14) +
      rainColor(`${day.maxChanceOfRain}%`.padEnd(10)) +
      chalk.cyan(day.maxWindKmph)
    );
  });
  if (data.alerts.length > 0) {
    console.log('');
    console.log(chalk.bold.red('  ⚠  ACTIVE ALERTS:'));
    data.alerts.forEach(a =>
      console.log(`     ${chalk.red('•')} ${chalk.bold(a.day)}: ${a.detail}`)
    );
  }
  separator();
  console.log('');
}

function ipcSignal(path) {
  log('IPC', chalk.magenta(`Disruption signal written → ${path}`), 'ipc');
  log('IPC', chalk.magenta(`Re-Router Agent will activate automatically`), 'ipc');
}

function fatalError(msg) {
  console.log('');
  console.log(chalk.bold.red(`  FATAL: ${msg}`));
  console.log('');
}

module.exports = { header, separator, agentRow, log, toolCall, toolResult, weatherTable, ipcSignal, fatalError };
