#!/usr/bin/env node
// Summarizes logs/events.jsonl: calls this week, per-tool counts + error rate, and
// p50/p95 latency per pipeline stage. Run via `npm run stats`.
import fs from 'node:fs';
import { logFilePath } from './logger.js';

function percentile(sortedNums, p) {
  if (sortedNums.length === 0) return null;
  const idx = Math.min(sortedNums.length - 1, Math.floor((p / 100) * sortedNums.length));
  return sortedNums[idx];
}

function summarize(nums) {
  const sorted = [...nums].filter((n) => typeof n === 'number').sort((a, b) => a - b);
  return { count: sorted.length, p50: percentile(sorted, 50), p95: percentile(sorted, 95) };
}

function main() {
  const file = logFilePath();
  if (!fs.existsSync(file)) {
    console.log('No log file yet — run a conversation first.');
    return;
  }
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const events = lines.map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  }).filter(Boolean);

  const turns = events.filter((e) => e.type === 'turn');
  const sessionStarts = events.filter((e) => e.type === 'session_start');
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const turnsThisWeek = turns.filter((e) => new Date(e.ts).getTime() >= weekAgo);

  console.log(`Sessions: ${sessionStarts.length}`);
  console.log(`Turns total: ${turns.length}   Turns this week: ${turnsThisWeek.length}\n`);

  const byTool = new Map();
  for (const turn of turns) {
    for (const call of turn.toolCalls || []) {
      const entry = byTool.get(call.name) || { count: 0, errors: 0, latencies: [] };
      entry.count += 1;
      if (!call.ok) entry.errors += 1;
      if (typeof call.latencyMs === 'number') entry.latencies.push(call.latencyMs);
      byTool.set(call.name, entry);
    }
  }

  console.log('Tool calls (what people asked for):');
  for (const [name, entry] of byTool) {
    const lat = summarize(entry.latencies);
    const errRate = entry.count ? ((entry.errors / entry.count) * 100).toFixed(0) : 0;
    console.log(`  ${name}: ${entry.count} calls, ${errRate}% errored, p50=${lat.p50}ms p95=${lat.p95}ms`);
  }

  console.log('\nPer-turn latency (ms):');
  for (const stage of ['sttMs', 'llmDecideMs', 'ttsFirstChunkMs', 'totalMs']) {
    const values = turns.map((t) => t.timings?.[stage]).filter((n) => typeof n === 'number');
    const s = summarize(values);
    console.log(`  ${stage}: n=${s.count} p50=${s.p50}ms p95=${s.p95}ms`);
  }
}

main();
