import { esc } from './markdown.js';

// Per-agent heartbeat (Board card 8b061edd): show each agent's last-activity
// time and idle duration in the participant rail, with a visible stale
// indicator once idleness passes a threshold. Renders entirely client-side
// from data already on /api/state — chat messages (source), runs (agentId),
// and chat turns (agentId) — no new server routes.

// Mirrors the idle watchdog's default idle interval (src/lib/idle-watchdog.js).
export const DEFAULT_STALE_MINUTES = 15;

const LEVELS = new Set(['running', 'idle', 'stale', 'none']);

const parseTime = (iso) => {
  const at = Date.parse(iso ?? '');
  return Number.isFinite(at) ? at : null;
};

/** Human-readable idle duration: 45s, 4m, 3h 12m, 1d 4h. */
export function formatIdleDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

/**
 * One pass over the room state: newest recorded signal per source id.
 * Returns Map id -> { at (epoch ms), iso, kind }. Records with a missing id
 * or an unparsable timestamp are skipped rather than guessed at.
 */
export function lastActivityByAgent(state) {
  const newest = new Map();
  const consider = (agentId, iso, kind) => {
    if (!agentId) return;
    const at = parseTime(iso);
    if (at === null) return;
    const current = newest.get(agentId);
    if (!current || at > current.at) newest.set(agentId, { at, iso, kind });
  };
  for (const message of state?.messages ?? []) consider(message.source, message.createdAt, 'chat message');
  for (const turn of state?.chatTurns ?? []) consider(turn.agentId, turn.updatedAt ?? turn.createdAt, 'chat turn');
  for (const run of state?.executions ?? []) consider(run.agentId, run.finishedAt ?? run.startedAt, 'run');
  return newest;
}

/**
 * Heartbeat state for one agent: { level, text, title, idleSeconds,
 * lastActivityAt }. Levels: running (working right now) · idle (last signal
 * within the threshold) · stale (idle past the threshold) · none (no
 * recorded signal — shown honestly instead of inventing a timestamp).
 */
export function heartbeatEntry(agent, activity, { now = Date.now(), staleMinutes = DEFAULT_STALE_MINUTES } = {}) {
  const last = activity?.get?.(agent?.id) ?? null;
  const lastNote = last ? `Last signal ${last.iso} (${last.kind})` : 'No message, run, or chat turn recorded yet';
  if (agent?.activity === 'running') {
    return { level: 'running', text: 'working now', idleSeconds: 0, lastActivityAt: last?.iso ?? null, title: `Running right now · ${lastNote}` };
  }
  if (!last) {
    return { level: 'none', text: 'no recorded activity', idleSeconds: null, lastActivityAt: null, title: lastNote };
  }
  const idleSeconds = Math.max(0, Math.floor((now - last.at) / 1000));
  const duration = formatIdleDuration(idleSeconds);
  const stale = idleSeconds > staleMinutes * 60;
  return {
    level: stale ? 'stale' : 'idle',
    text: stale ? `stale · idle ${duration}` : `last active ${duration} ago`,
    idleSeconds,
    lastActivityAt: last.iso,
    title: `${lastNote} · idle ${duration} · marked stale after ${staleMinutes}m idle${stale ? ' — exceeded' : ''}`
  };
}

/** Heartbeat row markup for an agent card. */
export function heartbeatMarkup(agent, activity, options) {
  const entry = heartbeatEntry(agent, activity, options);
  const level = LEVELS.has(entry.level) ? entry.level : 'none';
  return `<div class="agent-heartbeat ${level}" title="${esc(entry.title)}"><i class="hb-dot"></i><span>${esc(entry.text)}</span></div>`;
}
