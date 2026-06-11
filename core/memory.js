'use strict';
const fs   = require('fs');
const path = require('path');

const DATA_DIR    = path.join(process.cwd(), 'data');
const MEMORY_FILE = path.join(DATA_DIR, 'agent-memory.json');
const METRICS_FILE = path.join(DATA_DIR, 'token-metrics.json');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadMemory() {
  ensureDir();
  if (!fs.existsSync(MEMORY_FILE)) {
    return { runs: 0, lastSnapshots: {}, changeHistory: [], firstSeen: new Date().toISOString() };
  }
  try { return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8')); }
  catch (_) { return { runs: 0, lastSnapshots: {}, changeHistory: [], firstSeen: new Date().toISOString() }; }
}

function saveMemory(mem) {
  ensureDir();
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(mem, null, 2));
}

/**
 * Compare current weather snapshot to the previous one for the same destination.
 * Returns array of significant changes the agent should be aware of.
 */
function detectChanges(destination, currentSnapshot) {
  const memory = loadMemory();
  const previous = memory.lastSnapshots[destination];
  const changes = [];

  if (!previous) {
    changes.push({ type: 'first_observation', detail: `First monitoring run for ${destination}.` });
  } else {
    // Compare day-by-day forecasts
    const prevDays = previous.forecast || [];
    const currDays = currentSnapshot.forecast || [];
    currDays.forEach((curr, i) => {
      const prev = prevDays.find(p => p.date === curr.date);
      if (!prev) return;

      const rainDelta = curr.maxChanceOfRain - prev.maxChanceOfRain;
      if (Math.abs(rainDelta) >= 20) {
        changes.push({
          type: 'rain_change',
          day: `Day ${i + 1} (${curr.date})`,
          detail: `Rain probability shifted ${rainDelta > 0 ? '+' : ''}${rainDelta}% (was ${prev.maxChanceOfRain}%, now ${curr.maxChanceOfRain}%).`,
          severity: Math.abs(rainDelta) >= 40 ? 'high' : 'medium',
        });
      }

      if (curr.maxTempC !== undefined && prev.maxTempC !== undefined) {
        const tempDelta = curr.maxTempC - prev.maxTempC;
        if (Math.abs(tempDelta) >= 5) {
          changes.push({
            type: 'temperature_change',
            day: `Day ${i + 1} (${curr.date})`,
            detail: `Max temp shifted ${tempDelta > 0 ? '+' : ''}${tempDelta}°C (was ${prev.maxTempC}°C, now ${curr.maxTempC}°C).`,
            severity: 'low',
          });
        }
      }

      if (curr.isSevere && !prev.isSevere) {
        changes.push({
          type: 'severity_escalation',
          day: `Day ${i + 1} (${curr.date})`,
          detail: `Conditions escalated to severe: ${curr.description}`,
          severity: 'critical',
        });
      } else if (!curr.isSevere && prev.isSevere) {
        changes.push({
          type: 'severity_clearing',
          day: `Day ${i + 1} (${curr.date})`,
          detail: `Severe conditions cleared. Now: ${curr.description}`,
          severity: 'low',
        });
      }
    });
  }

  // Persist this snapshot
  memory.runs += 1;
  memory.lastSnapshots[destination] = {
    forecast: currentSnapshot.forecast,
    fetchedAt: currentSnapshot.fetchedAt,
  };
  if (changes.length > 0) {
    memory.changeHistory.push({
      destination,
      timestamp: new Date().toISOString(),
      changes,
    });
    if (memory.changeHistory.length > 100) memory.changeHistory.shift();
  }
  saveMemory(memory);

  return { changes, totalRuns: memory.runs, previousObserved: !!previous };
}

/**
 * Track Claude API token usage across runs for contest metrics.
 */
function recordTokenUsage(usage) {
  ensureDir();
  let metrics = { runs: [], totals: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 } };
  if (fs.existsSync(METRICS_FILE)) {
    try { metrics = JSON.parse(fs.readFileSync(METRICS_FILE, 'utf8')); } catch (_) {}
  }

  const entry = {
    timestamp: new Date().toISOString(),
    inputTokens: usage.input_tokens || 0,
    outputTokens: usage.output_tokens || 0,
    cacheReadTokens: usage.cache_read_input_tokens || 0,
    cacheCreateTokens: usage.cache_creation_input_tokens || 0,
  };
  metrics.runs.push(entry);
  if (metrics.runs.length > 200) metrics.runs.shift();

  metrics.totals.input       += entry.inputTokens;
  metrics.totals.output      += entry.outputTokens;
  metrics.totals.cacheRead   += entry.cacheReadTokens;
  metrics.totals.cacheCreate += entry.cacheCreateTokens;

  fs.writeFileSync(METRICS_FILE, JSON.stringify(metrics, null, 2));
  return entry;
}

function getMetricsSummary() {
  if (!fs.existsSync(METRICS_FILE)) return null;
  try {
    const m = JSON.parse(fs.readFileSync(METRICS_FILE, 'utf8'));
    // Opus 4 pricing approximation — for display only.
    const INPUT_PER_M = 15;
    const OUTPUT_PER_M = 75;
    const estCost = (m.totals.input * INPUT_PER_M + m.totals.output * OUTPUT_PER_M) / 1_000_000;
    return { ...m, estimatedCostUsd: estCost.toFixed(4), apiCalls: m.runs.length };
  } catch (_) { return null; }
}

module.exports = { loadMemory, saveMemory, detectChanges, recordTokenUsage, getMetricsSummary };
