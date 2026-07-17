import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_STALE_MINUTES,
  formatIdleDuration,
  heartbeatEntry,
  heartbeatMarkup,
  lastActivityByAgent
} from '../public/agent-heartbeat.js';

const NOW = Date.parse('2026-07-17T12:00:00.000Z');
const minutesAgo = (minutes) => new Date(NOW - minutes * 60_000).toISOString();

function roomState() {
  return {
    messages: [
      { source: 'codex', type: 'message', createdAt: minutesAgo(50) },
      { source: 'user', type: 'message', createdAt: minutesAgo(1) },
      { source: 'system', type: 'system', createdAt: minutesAgo(1) },
      { source: 'grok', type: 'message', createdAt: minutesAgo(4) }
    ],
    chatTurns: [
      { agentId: 'codex', status: 'completed', createdAt: minutesAgo(45), updatedAt: minutesAgo(40) }
    ],
    executions: [
      { agentId: 'codex', status: 'completed', startedAt: minutesAgo(30), finishedAt: minutesAgo(25) },
      { agentId: 'gemini', status: 'failed', startedAt: minutesAgo(600), finishedAt: minutesAgo(590) }
    ]
  };
}

test('lastActivityByAgent picks the newest signal across messages, turns, and runs', () => {
  const activity = lastActivityByAgent(roomState());
  // codex: message 50m, turn updated 40m, run finished 25m -> the run wins.
  assert.deepEqual(activity.get('codex'), { at: NOW - 25 * 60_000, iso: minutesAgo(25), kind: 'run' });
  assert.equal(activity.get('grok').kind, 'chat message');
  assert.equal(activity.get('gemini').iso, minutesAgo(590));
});

test('lastActivityByAgent skips missing ids and unparsable timestamps', () => {
  const activity = lastActivityByAgent({
    messages: [{ source: null, createdAt: minutesAgo(1) }],
    chatTurns: [{ agentId: 'codex', createdAt: '<img src=x onerror=alert(1)>' }],
    executions: [{ agentId: 'codex', startedAt: 'not a date', finishedAt: null }]
  });
  assert.equal(activity.size, 0);
});

test('a running agent shows working now regardless of how old its last signal is', () => {
  const activity = lastActivityByAgent(roomState());
  const entry = heartbeatEntry({ id: 'gemini', activity: 'running' }, activity, { now: NOW });
  assert.equal(entry.level, 'running');
  assert.equal(entry.text, 'working now');
  assert.equal(entry.idleSeconds, 0);
  assert.match(entry.title, /Running right now/);
});

test('idle within the threshold reports last-activity time and idle duration', () => {
  const activity = lastActivityByAgent(roomState());
  const entry = heartbeatEntry({ id: 'grok', activity: 'idle' }, activity, { now: NOW });
  assert.equal(entry.level, 'idle');
  assert.equal(entry.text, 'last active 4m ago');
  assert.equal(entry.idleSeconds, 4 * 60);
  assert.equal(entry.lastActivityAt, minutesAgo(4));
  assert.match(entry.title, new RegExp(`Last signal ${minutesAgo(4)} \\(chat message\\)`));
  assert.match(entry.title, new RegExp(`stale after ${DEFAULT_STALE_MINUTES}m idle`));
});

test('idle past the threshold flags stale; the boundary itself is not stale', () => {
  const activity = lastActivityByAgent(roomState());
  const stale = heartbeatEntry({ id: 'codex', activity: 'idle' }, activity, { now: NOW });
  assert.equal(stale.level, 'stale');
  assert.equal(stale.text, 'stale · idle 25m');
  assert.match(stale.title, /— exceeded/);

  const boundary = heartbeatEntry({ id: 'grok', activity: 'idle' }, activity, { now: NOW, staleMinutes: 4 });
  assert.equal(boundary.level, 'idle');
  const past = heartbeatEntry({ id: 'grok', activity: 'idle' }, activity, { now: NOW + 1000, staleMinutes: 4 });
  assert.equal(past.level, 'stale');
});

test('agents with no recorded signal render an honest none state', () => {
  const entry = heartbeatEntry({ id: 'ghost', activity: 'idle' }, lastActivityByAgent(roomState()), { now: NOW });
  assert.equal(entry.level, 'none');
  assert.equal(entry.text, 'no recorded activity');
  assert.equal(entry.lastActivityAt, null);
  assert.match(entry.title, /No message, run, or chat turn recorded yet/);
});

test('formatIdleDuration covers seconds through days', () => {
  assert.equal(formatIdleDuration(45), '45s');
  assert.equal(formatIdleDuration(4 * 60), '4m');
  assert.equal(formatIdleDuration(3 * 3600 + 12 * 60), '3h 12m');
  assert.equal(formatIdleDuration(2 * 3600), '2h');
  assert.equal(formatIdleDuration(26 * 3600), '1d 2h');
  assert.equal(formatIdleDuration(48 * 3600), '2d');
  assert.equal(formatIdleDuration(-5), '');
});

test('markup uses whitelisted level classes and escapes the tooltip', () => {
  const activity = lastActivityByAgent(roomState());
  const html = heartbeatMarkup({ id: 'grok', activity: '"><script>alert(1)</script>' }, activity, { now: NOW });
  assert.match(html, /class="agent-heartbeat idle"/);
  assert.doesNotMatch(html, /<script>/);
  const stale = heartbeatMarkup({ id: 'gemini', activity: 'idle' }, activity, { now: NOW });
  assert.match(stale, /class="agent-heartbeat stale"/);
  assert.match(stale, /title="[^"]*marked stale after 15m idle/);
});
