'use strict';
const readline = require('readline');
const chalk    = require('chalk');

const orchestrator = require('./orchestrator');
const dash         = require('./dashboard');

function start() {
  const rl = readline.createInterface({
    input:  process.stdin,
    output: process.stdout,
    prompt: chalk.cyan('\nVOYAGER ▸ '),
    historySize: 100,
    terminal: true,
  });

  // Wire the dashboard's command stream into the same handler
  dash.onCommand((text, source) => {
    process.stdout.write('\n'); // newline so the prompt doesn't get smeared
    orchestrator.handleCommand(text, source).then(() => rl.prompt());
  });

  rl.prompt();

  rl.on('line', async (raw) => {
    const text = raw.trim();
    if (!text) return rl.prompt();

    // Built-in slash commands
    if (text === '/exit' || text === '/quit' || text === 'exit' || text === 'quit') {
      console.log(chalk.cyan('\n  Shutting down VOYAGER. Travel safely.\n'));
      process.exit(0);
    }
    if (text === '/clear') {
      console.clear();
      return rl.prompt();
    }
    if (text === '/help') {
      console.log(chalk.gray('\n  Built-in: /clear  /exit  /help'));
      console.log(chalk.gray('  Or just type anything in plain English. Examples:'));
      console.log(chalk.white('    monitor Tokyo for next week'));
      console.log(chalk.white('    check the air quality in Delhi'));
      console.log(chalk.white('    any earthquakes near Istanbul'));
      console.log(chalk.white('    save Paris trip Jun 15-20 to calendar'));
      console.log(chalk.white('    open the alerts file'));
      console.log(chalk.white('    go quiet  /  speak again\n'));
      return rl.prompt();
    }

    // Route to orchestrator
    await orchestrator.handleCommand(text, 'shell');
    rl.prompt();
  });

  rl.on('close', () => {
    console.log(chalk.cyan('\n  VOYAGER offline.\n'));
    process.exit(0);
  });

  // Graceful Ctrl+C
  rl.on('SIGINT', () => {
    process.stdout.write('\n');
    console.log(chalk.yellow('  (Type "exit" or press Ctrl+C again to quit)'));
    rl.prompt();
    rl.once('SIGINT', () => process.exit(0));
  });
}

module.exports = { start };
