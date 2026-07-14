import { createRefreshScheduler } from './refresh-scheduler.js';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
let state = null;
let activeExecutionId = null;
const outputCache = new Map(); // execution id -> { output, status }
let promoteMessageId = null;
const selectedRecipientIds = new Set();
const boardFilters = { text: '', agentId: '', closed: false, archived: false };
const ROUTES = ['chat', 'board', 'runs', 'workspace'];

const esc = (value = '') => String(value).replace(/[&<>'"]/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
})[character]);

const relativeTime = (iso) => {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 10) return 'now';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
};

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) }
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `Request failed: ${response.status}`);
  return body;
}

function toast(message, isError = false) {
  const element = $('#toast');
  element.textContent = message;
  element.className = `toast show${isError ? ' error' : ''}`;
  clearTimeout(element.timer);
  element.timer = setTimeout(() => { element.className = 'toast'; }, 2600);
}

// ---------- routing ----------

function currentRoute() {
  const route = (location.hash.replace(/^#\//, '') || 'chat').split('/')[0];
  return ROUTES.includes(route) ? route : 'chat';
}

function renderRoute() {
  const route = currentRoute();
  ROUTES.forEach((name) => $(`#page-${name}`).classList.toggle('active', name === route));
  $$('.main-nav a').forEach((link) => link.classList.toggle('active', link.dataset.route === route));
  if (route === 'chat') scrollFeed(true);
}

// ---------- data ----------

async function refresh({ keepScroll = true } = {}) {
  const feed = $('#feed');
  const nearBottom = !state || feed.scrollHeight - feed.scrollTop - feed.clientHeight < 100;
  state = await api('/api/state');
  render();
  if (currentRoute() === 'chat' && (!keepScroll || nearBottom)) scrollFeed();
}

function scrollFeed(onlyIfNearBottom = false) {
  const feed = $('#feed');
  if (onlyIfNearBottom && feed.scrollHeight - feed.scrollTop - feed.clientHeight >= 100) return;
  requestAnimationFrame(() => { feed.scrollTop = feed.scrollHeight; });
}

const eventRefresh = createRefreshScheduler(
  () => refresh(),
  { onError: (error) => toast(error.message, true) }
);

function initials(name) {
  return name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
}

// ---------- topbar ----------

function renderTopbar() {
  $('#roomName').textContent = state.room.name.toUpperCase();
  $('#pauseButton').textContent = state.room.paused ? 'Resume room' : 'Pause room';
  $('#pauseButton').classList.toggle('danger', !state.room.paused);
  const pendingTurns = state.chatTurns.filter((turn) => ['queued', 'active'].includes(turn.status)).length;
  const openTasks = state.tasks.filter((task) => !task.archivedAt
    && ['proposed', 'ready', 'waiting', 'active', 'blocked', 'review-required'].includes(task.status)).length;
  const runningExecutions = state.executions.filter((entry) => entry.status === 'running').length;
  const pendingApprovals = state.approvals.filter((entry) => entry.status === 'pending').length;
  const badge = (selector, value, alert = false) => {
    const element = $(selector);
    element.textContent = value;
    element.classList.toggle('alert', alert && value > 0);
  };
  badge('#navChat', pendingTurns);
  badge('#navBoard', openTasks);
  badge('#navRuns', runningExecutions);
  badge('#navWorkspace', state.workspace.status.length);
  badge('#approvalBadge', pendingApprovals, true);
}

// ---------- chat page ----------

function agentRoleBadges(agent) {
  const badges = [];
  if (state.room.coordinatorId === agent.id) badges.push('<span class="role-badge coordinator">★ coordinator</span>');
  for (const role of state.room.roles?.[agent.id] ?? []) badges.push(`<span class="role-badge">${esc(role)}</span>`);
  return badges.length ? `<div class="agent-roles">${badges.join('')}</div>` : '';
}

function renderAgents() {
  $('#agentList').innerHTML = state.agents.map((agent) => `
    <article class="agent-card ${esc(agent.activity)}">
      <div class="agent-top">
        <div class="avatar ${esc(agent.id)}">${esc(initials(agent.name))}</div>
        <div class="agent-name"><strong>${esc(agent.name)}</strong><span>${esc(agent.provider)} · ${esc(agent.version || 'not installed')}</span></div>
        <span class="status-pill ${esc(agent.connection)}">${agent.activity === 'running' ? 'working' : esc(agent.connection === 'verified' ? 'verified' : agent.status)}</span>
      </div>
      ${agentRoleBadges(agent)}
      <div class="agent-action-row">
        <div class="agent-action">${esc(agent.lastAction)}</div>
        <button class="agent-assign" data-assign-agent="${esc(agent.id)}" ${agent.status !== 'installed' ? 'disabled' : ''}>Assign task</button>
      </div>
    </article>`).join('');
  const running = state.agents.filter((agent) => agent.activity === 'running').length;
  const maximum = state.room.limits.maxConcurrentRuns;
  $('#concurrency').textContent = `${running} / ${maximum}`;
  $('#concurrencyMeter').style.width = `${Math.min(100, running / maximum * 100)}%`;
  const taskAgent = $('#taskAgent');
  const previousAgent = taskAgent.value;
  taskAgent.innerHTML = state.agents.map((agent) => `<option value="${esc(agent.id)}" ${agent.status !== 'installed' ? 'disabled' : ''}>${esc(agent.name)} · ${esc(agent.connection === 'verified' ? 'verified' : agent.status)}</option>`).join('');
  if (previousAgent) taskAgent.value = previousAgent;
}

function renderRecipients() {
  const installed = state.agents.filter((agent) => agent.status === 'installed');
  const availableIds = new Set(installed.map((agent) => agent.id));
  for (const id of selectedRecipientIds) {
    if (!availableIds.has(id)) selectedRecipientIds.delete(id);
  }
  const everyoneActive = installed.length > 0 && installed.every((agent) => selectedRecipientIds.has(agent.id));
  $('#recipientList').innerHTML = [
    `<button type="button" class="recipient-chip ${selectedRecipientIds.size ? '' : 'active'}" data-recipient="room" aria-pressed="${selectedRecipientIds.size === 0}">No one</button>`,
    `<button type="button" class="recipient-chip ${everyoneActive ? 'active' : ''}" data-recipient="everyone" aria-pressed="${everyoneActive}" ${installed.length ? '' : 'disabled'}>Everyone</button>`,
    ...state.agents.map((agent) => `<button type="button" class="recipient-chip ${selectedRecipientIds.has(agent.id) ? 'active' : ''}" data-recipient="${esc(agent.id)}" aria-pressed="${selectedRecipientIds.has(agent.id)}" ${agent.status !== 'installed' ? 'disabled' : ''}>${esc(agent.name)}</button>`)
  ].join('');
  const selectedNames = state.agents.filter((agent) => selectedRecipientIds.has(agent.id)).map((agent) => agent.name);
  const coordinator = state.room.coordinatorId
    ? state.agents.find((agent) => agent.id === state.room.coordinatorId) : null;
  $('#recipientHint').textContent = selectedNames.length
    ? `Visible to the room · ${selectedNames.join(', ')} will be asked to reply (read-only chat)`
    : `Visible to the room · no reply requested${coordinator ? ` · tip: ask ★${coordinator.name} to plan work` : ''}`;
}

function turnByMessage(message) {
  if (!message.chatTurnId) return null;
  return state.chatTurns.find((turn) => turn.id === message.chatTurnId) || null;
}

function renderFeed() {
  const messages = state.messages;
  $('#feed').innerHTML = messages.length ? messages.map((message) => {
    const sourceClass = message.source === 'user' ? 'user' : message.source === 'system' ? 'system' : message.source;
    const chip = ['message', 'system'].includes(message.type) ? '' : `<span class="type-chip">${esc(message.type)}</span>`;
    const promotable = message.type === 'message' && message.source !== 'system';
    const turn = turnByMessage(message);
    const retryable = message.type === 'blocker' && turn && ['failed', 'interrupted', 'cancelled'].includes(turn.status)
      && !state.chatTurns.some((candidate) => candidate.retryOf === turn.id);
    const actions = [
      promotable ? `<button class="message-action" data-promote="${esc(message.id)}" title="Promote to task">→ Task</button>` : '',
      retryable ? `<button class="message-action retry" data-retry-turn="${esc(turn.id)}">Retry reply</button>` : ''
    ].filter(Boolean).join('');
    return `<article class="message ${message.source === 'system' ? 'system-message' : ''}">
      <div class="message-avatar ${esc(sourceClass)}">${message.source === 'user' ? 'YOU' : esc(initials(message.sourceName))}</div>
      <div class="message-main">
        <div class="message-head"><strong>${esc(message.sourceName)}</strong>${chip}<span class="message-time">${relativeTime(message.createdAt)}</span>${actions ? `<span class="message-actions">${actions}</span>` : ''}</div>
        <div class="message-body">${esc(message.content)}</div>
      </div>
    </article>`;
  }).join('') : '<div class="empty"><div><strong>The room is quiet.</strong>Say something — replies stay conversation. Work starts on the Board.</div></div>';
}

function renderTurnStrip() {
  const pending = state.chatTurns.filter((turn) => ['queued', 'active'].includes(turn.status));
  const strip = $('#turnStrip');
  if (!pending.length) { strip.innerHTML = ''; strip.hidden = true; return; }
  strip.hidden = false;
  strip.innerHTML = pending.map((turn) => {
    const agent = state.agents.find((entry) => entry.id === turn.agentId);
    const label = turn.status === 'active' ? 'replying…' : 'queued';
    return `<span class="turn-chip ${esc(turn.status)}"><i class="pulse"></i>${esc(agent?.name || turn.agentId)} · ${label}
      <button data-cancel-turn="${esc(turn.id)}" title="Cancel this reply" aria-label="Cancel reply from ${esc(agent?.name || turn.agentId)}">×</button></span>`;
  }).join('');
}

// ---------- board page ----------

const LANES = [
  { key: 'inbox', title: 'Inbox', statuses: ['proposed'] },
  { key: 'ready', title: 'Ready', statuses: ['ready', 'waiting'] },
  { key: 'progress', title: 'In Progress', statuses: ['active'] },
  { key: 'blocked', title: 'Blocked', statuses: ['blocked'] },
  { key: 'review', title: 'Review', statuses: ['review-required'] },
  { key: 'done', title: 'Done', statuses: ['completed'] }
];
const CLOSED_STATUSES = ['failed', 'cancelled', 'rejected'];

function legacyChatTasks() {
  return state.tasks.filter((task) => task.origin === 'message'
    && ['completed', ...CLOSED_STATUSES].includes(task.status) && !task.archivedAt);
}

function visibleTasks() {
  return state.tasks.filter((task) => {
    if (task.archivedAt && !boardFilters.archived) return false;
    if (boardFilters.agentId && task.agentId !== boardFilters.agentId) return false;
    if (boardFilters.text) {
      const haystack = `${task.title}\n${task.objective}`.toLowerCase();
      if (!haystack.includes(boardFilters.text.toLowerCase())) return false;
    }
    return true;
  });
}

function laneLabel(status) {
  return (LANES.find((lane) => lane.statuses.includes(status)) || { title: 'Closed' }).title;
}

function taskMenuItems(task) {
  const items = [];
  if (!task.archivedAt) {
    if (task.status === 'proposed') {
      items.push(`<button role="menuitem" data-mark-ready="${esc(task.id)}">Mark ready</button>`,
        `<button role="menuitem" data-dismiss="${esc(task.id)}">Dismiss</button>`);
    }
    if (task.status === 'review-required') {
      items.push(`<button role="menuitem" data-review="${esc(task.id)}" data-accepted="true">Accept</button>`,
        `<button role="menuitem" data-review="${esc(task.id)}" data-accepted="false">Reject</button>`);
    }
    if (task.status === 'active') items.push(`<button role="menuitem" data-cancel="${esc(task.id)}">Interrupt</button>`);
    if (task.status === 'blocked') items.push(`<button role="menuitem" data-requeue="${esc(task.id)}">Requeue</button>`);
    if (['completed', ...CLOSED_STATUSES].includes(task.status)) {
      items.push(`<button role="menuitem" data-archive="${esc(task.id)}">Archive</button>`);
    }
  } else {
    items.push(`<button role="menuitem" data-unarchive="${esc(task.id)}">Unarchive</button>`);
  }
  items.push(`<button role="menuitem" data-copy-title="${esc(task.id)}">Copy title</button>`);
  return items.join('');
}

function taskCard(task) {
  const agent = state.agents.find((entry) => entry.id === task.agentId);
  const priority = task.priority && task.priority !== 'none' ? `<span class="chip priority-${esc(task.priority)}">${esc(task.priority)}</span>` : '';
  const access = `<span class="chip access-${task.accessMode === 'workspace-write' ? 'write' : 'read'}">${task.accessMode === 'workspace-write' ? 'write' : 'read'}</span>`;
  const proposerName = task.origin === 'coordinator'
    ? (state.agents.find((entry) => entry.id === task.proposedBy)?.name ?? task.proposedBy) : null;
  const origin = task.origin === 'coordinator'
    ? `<span class="chip origin" title="Proposed by the Coordinator${task.source ? `: ${esc(task.source.content.slice(0, 300))}` : ''}">plan · ${esc(proposerName ?? '')}</span>`
    : task.source ? `<span class="chip origin" title="Promoted from: ${esc(task.source.content.slice(0, 300))}">from chat</span>`
    : task.origin === 'message' ? '<span class="chip origin">legacy chat</span>' : '';
  const dependencies = task.dependencies?.length ? (() => {
    const summary = task.dependencies.map((depId) => {
      const dep = state.tasks.find((entry) => entry.id === depId);
      return dep ? `${dep.title} · ${dep.status}` : `${depId} · missing`;
    }).join('\n');
    return `<span class="chip deps" title="${esc(summary)}">deps ${task.dependencies.length}</span>`;
  })() : '';
  const archivedChip = task.archivedAt ? '<span class="chip archived">archived</span>' : '';
  const status = task.status === 'waiting' ? 'awaiting approval'
    : task.status === 'review-required' ? 'needs review'
    : task.status;
  const blocker = task.status === 'blocked' && task.blocker ? `<div class="task-blocker">${esc(task.blocker)}</div>` : '';
  const actions = [];
  if (!task.archivedAt) {
    if (task.status === 'proposed') {
      actions.push(`<button class="tiny-button accept" data-mark-ready="${esc(task.id)}">Mark ready</button>`,
        `<button class="tiny-button reject" data-dismiss="${esc(task.id)}">Dismiss</button>`);
    }
    if (task.status === 'review-required') {
      actions.push(`<button class="tiny-button accept" data-review="${esc(task.id)}" data-accepted="true">Accept</button>`,
        `<button class="tiny-button reject" data-review="${esc(task.id)}" data-accepted="false">Reject</button>`);
    }
    if (task.status === 'active') actions.push(`<button class="tiny-button reject" data-cancel="${esc(task.id)}">Interrupt</button>`);
    if (task.status === 'blocked') actions.push(`<button class="tiny-button accept" data-requeue="${esc(task.id)}">Requeue</button>`);
    if (['completed', ...CLOSED_STATUSES].includes(task.status)) {
      actions.push(`<button class="tiny-button" data-archive="${esc(task.id)}">Archive</button>`);
    }
  } else {
    actions.push(`<button class="tiny-button" data-unarchive="${esc(task.id)}">Unarchive</button>`);
  }
  return `<article class="task-card" tabindex="0" aria-label="${esc(task.title)}, ${esc(laneLabel(task.status))}, ${esc(agent?.name || task.agentId)}">
    <button class="task-menu-button" data-task-menu="${esc(task.id)}" aria-label="Task actions" aria-haspopup="true" aria-expanded="false">⋯</button>
    <div class="task-menu" role="menu" hidden>${taskMenuItems(task)}</div>
    <div class="task-chips">${priority}${access}${origin}${dependencies}${archivedChip}</div>
    <h3>${esc(task.title)}</h3><p>${esc(task.objective)}</p>
    <div class="task-meta"><span>${esc(agent?.name || task.agentId)}</span><span>${esc(status)}</span></div>
    ${blocker}
    ${actions.length ? `<div class="task-actions">${actions.join('')}</div>` : ''}
  </article>`;
}

function renderBoard() {
  const tasks = visibleTasks();
  const lanes = [...LANES];
  if (boardFilters.closed || boardFilters.archived) lanes.push({ key: 'closed', title: 'Closed', statuses: CLOSED_STATUSES });
  $('#taskBoard').innerHTML = lanes.map((lane) => {
    const laneTasks = tasks.filter((task) => lane.statuses.includes(task.status)
      && (lane.key === 'closed' || !task.archivedAt || boardFilters.archived));
    return `<section class="task-lane" aria-label="${esc(lane.title)}">
      <div class="lane-head"><span>${esc(lane.title)}</span><span>${laneTasks.length}</span></div>
      ${laneTasks.map(taskCard).join('') || '<div class="blank-state">No tasks</div>'}
    </section>`;
  }).join('');
  const open = state.tasks.filter((task) => !task.archivedAt && !CLOSED_STATUSES.includes(task.status) && task.status !== 'completed').length;
  $('#boardSummary').textContent = `${open} open · ${state.tasks.filter((task) => task.status === 'completed' && !task.archivedAt).length} done · ${state.tasks.filter((task) => task.archivedAt).length} archived`;
  const legacyCount = legacyChatTasks().length;
  const legacyButton = $('#archiveLegacyButton');
  legacyButton.hidden = legacyCount === 0;
  legacyButton.textContent = `Archive legacy chat ×${legacyCount}`;
  const agentSelect = $('#boardAgent');
  const previous = agentSelect.value;
  agentSelect.innerHTML = ['<option value="">All agents</option>',
    ...state.agents.map((agent) => `<option value="${esc(agent.id)}">${esc(agent.name)}</option>`)].join('');
  agentSelect.value = previous;
}

// ---------- runs page ----------

function formatOutputSize(characters) {
  if (characters < 1024) return `${characters} B`;
  if (characters < 1024 * 1024) return `${Math.round(characters / 1024)} KB`;
  return `${(characters / (1024 * 1024)).toFixed(1)} MB`;
}

async function loadRunOutput(execution) {
  const cached = outputCache.get(execution.id);
  // Terminal output is immutable: once cached with a terminal status, never re-fetch.
  if (cached && cached.status !== 'running' && execution.status !== 'running') return;
  try {
    const body = await api(`/api/executions/${execution.id}/output`);
    outputCache.set(execution.id, { output: body.output, status: body.status });
    if (activeExecutionId !== execution.id) return; // stale response; user moved on
    const output = $('#consoleOutput');
    output.textContent = body.output || 'Process started; waiting for output…';
    output.scrollTop = output.scrollHeight;
  } catch {
    // Keep the outputTail placeholder; the next refresh pass retries.
  }
}

function renderRuns() {
  const total = state.executionsTotal ?? state.executions.length;
  $('#runCount').textContent = total;
  if (!activeExecutionId && state.executions.length) activeExecutionId = state.executions[0].id;
  const active = state.executions.find((entry) => entry.id === activeExecutionId) || state.executions[0];
  const truncationNote = total > state.executions.length
    ? `<div class="blank-state">Showing latest ${state.executions.length} of ${total} runs</div>` : '';
  $('#runList').innerHTML = state.executions.length ? state.executions.map((execution) => `
    <button class="run-item ${execution.id === active?.id ? 'active' : ''} status-${esc(execution.status)}" data-execution="${esc(execution.id)}">
      <strong>${esc(execution.agentId || 'command')}</strong>
      <span>${esc(execution.kind || 'agent')} · ${esc(execution.status)}</span>
      <span class="run-time">${relativeTime(execution.startedAt)}</span>
    </button>`).join('') + truncationNote : '<div class="blank-state">Real executions appear here after chat replies, tasks, or approved commands.</div>';
  if (active) {
    activeExecutionId = active.id;
    const cancel = active.status === 'running' ? `<button class="tiny-button reject" data-cancel-execution="${esc(active.id)}">Cancel run</button>` : '';
    const size = active.outputSize ?? 0;
    $('#runMeta').innerHTML = `
      <div class="run-meta-row"><span class="chip">${esc(active.kind || 'agent')}</span><span class="chip status-${esc(active.status)}">${esc(active.status)}</span>${active.exitCode === null || active.exitCode === undefined ? '' : `<span class="chip">exit ${esc(active.exitCode)}</span>`}<span class="chip">${esc(formatOutputSize(size))} captured</span>${cancel}</div>
      <div class="run-meta-purpose">${esc(active.purpose || '')}</div>
      <div class="run-meta-cmd">${esc(active.command)}<br><span>${esc(active.cwd)}</span></div>`;
    const cached = outputCache.get(active.id);
    $('#consoleOutput').textContent = (cached ? cached.output : active.outputTail) || 'Process started; waiting for output…';
    const output = $('#consoleOutput');
    output.scrollTop = output.scrollHeight;
    // Fetch full output only while the Runs page is actually visible — otherwise a
    // streaming run would make every refresh (from any page) re-download its log.
    if (currentRoute() === 'runs') loadRunOutput(active);
  } else {
    $('#runMeta').innerHTML = '';
    $('#consoleOutput').textContent = 'No executions yet.';
  }
}

// ---------- workspace page ----------

function renderWorkspace() {
  $('#workspacePath').textContent = state.room.workspace;
  $('#workspacePath').title = state.room.workspace;
  const gitKnown = typeof state.workspace.git === 'boolean';
  $('#wsGit').textContent = gitKnown ? (state.workspace.git ? 'Git' : 'Not Git') : '—';
  $('#wsBranch').textContent = state.workspace.branch || (gitKnown && !state.workspace.git ? 'n/a' : '—');
  $('#fileCount').textContent = state.workspace.status.length;
  $('#lineCount').textContent = state.workspace.diff ? state.workspace.diff.split('\n').length : 0;
  $('#fileList').innerHTML = state.workspace.status.length ? state.workspace.status.map((line) => `
    <div class="file-row"><span class="file-status">${esc(line.slice(0, 2).trim() || '?')}</span><span class="file-name">${esc(line.slice(3))}</span></div>`).join('')
    : `<div class="blank-state">${gitKnown && !state.workspace.git ? 'Not a Git workspace — change tracking is unavailable here.' : 'Working tree is clean'}</div>`;
  $('#diffOutput').textContent = state.workspace.diff
    || (gitKnown && !state.workspace.git ? 'Not a Git workspace.' : 'No tracked diff. Untracked file contents are not displayed until Git tracks them.');
}

// ---------- approvals drawer ----------

function renderApprovals() {
  const pending = state.approvals.filter((entry) => entry.status === 'pending');
  $('#approvals').innerHTML = pending.length ? pending.map((approval) => `
    <article class="approval-card">
      <h3>${esc(approval.title)}</h3><p>${esc(approval.detail)}</p>
      <div class="approval-command">${esc(approval.command)}<br><span>${esc(approval.cwd)}</span></div>
      <div class="approval-actions"><button class="tiny-button reject" data-approval="${esc(approval.id)}" data-decision="denied">Deny</button><button class="tiny-button accept" data-approval="${esc(approval.id)}" data-decision="approved">Approve</button></div>
    </article>`).join('') : '<div class="blank-state">No actions are waiting.<br>Nothing runs with write or command authority until you approve it.</div>';
  renderAutopilotStatus();
}

// Status chip and usage line follow live state; form fields are only populated
// when the drawer opens or after a save, so edits are never clobbered mid-typing.
function renderAutopilotStatus() {
  const policy = state.policy;
  const chip = $('#autopilotChip');
  chip.textContent = policy.enabled ? 'on' : 'off';
  chip.classList.toggle('on', policy.enabled);
  const used = state.approvals.filter((entry) => entry.decidedBy === 'autopilot' && entry.status === 'auto-approved'
    && Date.parse(entry.decidedAt) > Date.now() - 3_600_000).length;
  $('#autopilotUsage').textContent = `${used} of ${policy.maxAutoApprovalsPerHour} auto-approvals used this hour`;
}

function populatePolicyForm() {
  const policy = state.policy;
  $('#policyEnabled').checked = policy.enabled;
  $('#policyWrites').value = policy.autoApproveWrites;
  $('#policyAllowlist').value = policy.commandAllowlist.join('\n');
  $('#policyAutoAccept').checked = policy.autoAcceptReviews;
  $('#policyRetry').checked = policy.autoRetry.enabled;
  $('#policyRetryMax').value = policy.autoRetry.maxAttempts;
  $('#policyRateCap').value = policy.maxAutoApprovalsPerHour;
}

$('#policyForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const body = {
    enabled: $('#policyEnabled').checked,
    autoApproveWrites: $('#policyWrites').value,
    commandAllowlist: $('#policyAllowlist').value.split('\n').map((line) => line.trim()).filter(Boolean),
    autoAcceptReviews: $('#policyAutoAccept').checked,
    autoRetry: { enabled: $('#policyRetry').checked, maxAttempts: Number($('#policyRetryMax').value) },
    maxAutoApprovalsPerHour: Number($('#policyRateCap').value)
  };
  try {
    await api('/api/policy', { method: 'POST', body: JSON.stringify(body) });
    toast('Autopilot policy saved');
    await refresh();
    populatePolicyForm();
  } catch (error) { toast(error.message, true); }
});

function render() {
  renderTopbar();
  renderAgents(); renderRecipients(); renderFeed(); renderTurnStrip();
  renderBoard(); renderRuns(); renderWorkspace(); renderApprovals();
}

// ---------- composer ----------

$('#composer').addEventListener('submit', async (event) => {
  event.preventDefault();
  const content = $('#messageInput').value.trim();
  if (!content) return;
  const button = $('#composer .send-button');
  if (button.disabled) return;
  button.disabled = true;
  $('#messageInput').value = '';
  try {
    const result = await api('/api/messages', {
      method: 'POST',
      body: JSON.stringify({ content, agentIds: [...selectedRecipientIds] })
    });
    toast(result.chatTurnsCreated
      ? `Message sent · ${result.chatTurnsCreated} repl${result.chatTurnsCreated > 1 ? 'ies' : 'y'} requested`
      : 'Message added to room');
    await refresh({ keepScroll: false });
  } catch (error) {
    $('#messageInput').value = content;
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
});

$('#messageInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('#composer').requestSubmit(); }
});

// ---------- task dialog (create + promote) ----------

const OPEN_TASK_STATUSES = ['proposed', 'ready', 'waiting', 'active', 'blocked', 'review-required'];

function openTaskDialog({ agentId = null, promoteFrom = null } = {}) {
  const form = $('#taskForm');
  form.reset();
  const openTasks = state.tasks.filter((task) => !task.archivedAt && OPEN_TASK_STATUSES.includes(task.status));
  $('#taskDependencies').innerHTML = openTasks.map((task) => {
    const agent = state.agents.find((entry) => entry.id === task.agentId);
    return `<option value="${esc(task.id)}">${esc(task.title)} · ${esc(agent?.name || task.agentId)}</option>`;
  }).join('');
  $('#taskDependenciesLabel').hidden = !openTasks.length;
  promoteMessageId = promoteFrom?.id || null;
  $('#promoteSource').hidden = !promoteFrom;
  if (promoteFrom) {
    $('#promoteSourceText').textContent = `${promoteFrom.sourceName}: ${promoteFrom.content.slice(0, 280)}${promoteFrom.content.length > 280 ? '…' : ''}`;
    form.elements.title.value = promoteFrom.content.split(/[.!?\n]/)[0].slice(0, 120).trim();
    form.elements.objective.value = promoteFrom.content;
    $('#taskDialogEyebrow').textContent = 'PROMOTE TO WORK';
    $('#taskDialogTitle').textContent = 'Promote message to task';
    $('#taskSubmit').textContent = 'Promote to task';
  } else {
    $('#taskDialogEyebrow').textContent = 'DELEGATE WORK';
    $('#taskDialogTitle').textContent = 'Create a task';
    $('#taskSubmit').textContent = 'Create task';
  }
  if (agentId) $('#taskAgent').value = agentId;
  $('#taskDialog').showModal();
}

$('#taskForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const payload = Object.fromEntries(new FormData(formElement));
  // FormData collapses a multi-select to one value — read the selection explicitly.
  payload.dependencies = [...$('#taskDependencies').selectedOptions].map((option) => option.value);
  try {
    if (promoteMessageId) await api(`/api/messages/${promoteMessageId}/promote`, { method: 'POST', body: JSON.stringify(payload) });
    else await api('/api/tasks', { method: 'POST', body: JSON.stringify(payload) });
    $('#taskDialog').close(); formElement.reset();
    toast(promoteMessageId ? 'Message promoted to task' : 'Task created');
    promoteMessageId = null;
    if (currentRoute() !== 'board') location.hash = '#/board';
    await refresh();
  } catch (error) { toast(error.message, true); }
});

// ---------- roles dialog ----------

const SPECIALIST_ROLES = ['architect', 'implementer', 'researcher', 'reviewer', 'tester', 'security', 'docs', 'critic'];

function openRolesDialog() {
  const coordinatorSelect = $('#coordinatorSelect');
  coordinatorSelect.innerHTML = ['<option value="">Human coordinated — you run the room</option>',
    ...state.agents.map((agent) => `<option value="${esc(agent.id)}" ${agent.status !== 'installed' ? 'disabled' : ''}>${esc(agent.name)}${agent.status !== 'installed' ? ' · unavailable' : ''}</option>`)
  ].join('');
  coordinatorSelect.value = state.room.coordinatorId ?? '';
  $('#rolesGrid').innerHTML = state.agents.map((agent) => `
    <div class="roles-row">
      <strong>${esc(agent.name)}</strong>
      <div class="roles-options">${SPECIALIST_ROLES.map((role) => `
        <label class="check"><input type="checkbox" data-role-agent="${esc(agent.id)}" value="${esc(role)}"
          ${(state.room.roles?.[agent.id] ?? []).includes(role) ? 'checked' : ''}> ${esc(role)}</label>`).join('')}
      </div>
    </div>`).join('');
  $('#rolesDialog').showModal();
}

$('#rolesButton').addEventListener('click', openRolesDialog);

$('#rolesForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const roles = {};
  $$('#rolesGrid input[type=checkbox]:checked').forEach((box) => {
    (roles[box.dataset.roleAgent] ??= []).push(box.value);
  });
  try {
    await api('/api/roles', {
      method: 'POST',
      body: JSON.stringify({ coordinatorId: $('#coordinatorSelect').value || null, roles })
    });
    $('#rolesDialog').close();
    toast('Roles updated');
    await refresh();
  } catch (error) { toast(error.message, true); }
});

// ---------- other forms ----------

$('#commandForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  try {
    await api('/api/commands', { method: 'POST', body: JSON.stringify(Object.fromEntries(form)) });
    formElement.reset(); toast('Command sent to Approval Center'); await refresh();
    openApprovals(true);
  } catch (error) { toast(error.message, true); }
});

$('#workspaceForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    await api('/api/workspace', { method: 'POST', body: JSON.stringify(Object.fromEntries(form)) });
    $('#workspaceDialog').close(); toast('Workspace opened'); await refresh();
  } catch (error) { toast(error.message, true); }
});

// ---------- board filters ----------

$('#boardSearch').addEventListener('input', (event) => { boardFilters.text = event.target.value; renderBoard(); });
$('#boardAgent').addEventListener('change', (event) => { boardFilters.agentId = event.target.value; renderBoard(); });
$('#boardClosed').addEventListener('change', (event) => { boardFilters.closed = event.target.checked; renderBoard(); });
$('#boardArchived').addEventListener('change', (event) => { boardFilters.archived = event.target.checked; renderBoard(); });

$('#archiveLegacyButton').addEventListener('click', async () => {
  const count = legacyChatTasks().length;
  if (!count) return;
  if (!confirm(`Archive ${count} legacy chat task${count === 1 ? '' : 's'}? This is reversible via the Archived filter.`)) return;
  try {
    const result = await api('/api/tasks/archive-legacy', { method: 'POST', body: '{}' });
    toast(`${result.archived} legacy chat tasks archived`);
    await refresh();
  } catch (error) { toast(error.message, true); }
});

// ---------- approvals drawer ----------

function openApprovals(open) {
  const drawer = $('#approvalsDrawer');
  const shouldOpen = open ?? drawer.hidden;
  const wasOpen = !drawer.hidden;
  if (shouldOpen && drawer.hidden && state) populatePolicyForm();
  drawer.hidden = !shouldOpen;
  $('#approvalsButton').setAttribute('aria-expanded', String(shouldOpen));
  if (shouldOpen) ($('#closeApprovals') || drawer).focus();
  else if (wasOpen) $('#approvalsButton').focus();
}

$('#approvalsButton').addEventListener('click', () => openApprovals());
$('#closeApprovals').addEventListener('click', () => openApprovals(false));

// ---------- task overflow menus ----------

function closeTaskMenus(focusToggle = false) {
  $$('.task-menu:not([hidden])').forEach((menu) => {
    menu.hidden = true;
    const toggle = menu.previousElementSibling;
    toggle?.setAttribute('aria-expanded', 'false');
    if (focusToggle) toggle?.focus();
  });
}

document.addEventListener('keydown', (event) => {
  const openMenu = document.querySelector('.task-menu:not([hidden])');
  if (openMenu) {
    if (event.key === 'Escape') { event.preventDefault(); closeTaskMenus(true); }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const items = [...openMenu.querySelectorAll('button')];
      const index = items.indexOf(document.activeElement);
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const next = index === -1 ? (step === 1 ? 0 : items.length - 1) : (index + step + items.length) % items.length;
      items[next]?.focus();
    }
    return;
  }
  if (event.key === 'Escape' && !$('#approvalsDrawer').hidden && !document.querySelector('dialog[open]')) {
    openApprovals(false);
  }
});

// ---------- delegated clicks ----------

document.addEventListener('click', async (event) => {
  if (!event.target.closest('.task-menu-button')) closeTaskMenus();
  const button = event.target.closest('button');
  if (!button) return;
  try {
    if (button.dataset.taskMenu) {
      const menu = button.nextElementSibling;
      const willOpen = menu.hidden;
      closeTaskMenus();
      if (willOpen) {
        menu.hidden = false;
        button.setAttribute('aria-expanded', 'true');
        menu.querySelector('button')?.focus();
      }
    }
    if (button.dataset.markReady) {
      await api(`/api/tasks/${button.dataset.markReady}/transitions`, { method: 'POST', body: JSON.stringify({ to: 'ready' }) });
      toast('Task marked ready'); await refresh();
    }
    if (button.dataset.dismiss) {
      await api(`/api/tasks/${button.dataset.dismiss}/transitions`, { method: 'POST', body: JSON.stringify({ to: 'rejected' }) });
      toast('Proposal dismissed'); await refresh();
    }
    if (button.dataset.copyTitle) {
      const task = state.tasks.find((entry) => entry.id === button.dataset.copyTitle);
      if (task) { await navigator.clipboard.writeText(task.title); toast('Task title copied'); }
    }
    if (button.dataset.recipient) {
      const installed = state.agents.filter((agent) => agent.status === 'installed').map((agent) => agent.id);
      if (button.dataset.recipient === 'room') selectedRecipientIds.clear();
      else if (button.dataset.recipient === 'everyone') {
        const everyoneActive = installed.length && installed.every((id) => selectedRecipientIds.has(id));
        selectedRecipientIds.clear();
        if (!everyoneActive) installed.forEach((id) => selectedRecipientIds.add(id));
      } else if (selectedRecipientIds.has(button.dataset.recipient)) selectedRecipientIds.delete(button.dataset.recipient);
      else selectedRecipientIds.add(button.dataset.recipient);
      renderRecipients();
    }
    if (button.dataset.assignAgent) openTaskDialog({ agentId: button.dataset.assignAgent });
    if (button.dataset.promote) {
      const message = state.messages.find((entry) => entry.id === button.dataset.promote);
      if (message) openTaskDialog({ promoteFrom: message });
    }
    if (button.dataset.close) $(`#${button.dataset.close}`).close();
    if (button.dataset.approval) {
      await api(`/api/approvals/${button.dataset.approval}`, { method: 'POST', body: JSON.stringify({ decision: button.dataset.decision }) });
      toast(`Action ${button.dataset.decision}`); await refresh();
    }
    if (button.dataset.cancel) {
      await api(`/api/tasks/${button.dataset.cancel}/cancel`, { method: 'POST', body: '{}' }); toast('Interrupt requested');
    }
    if (button.dataset.cancelTurn) {
      await api(`/api/chat-turns/${button.dataset.cancelTurn}/cancel`, { method: 'POST', body: '{}' });
      toast('Reply cancelled'); await refresh();
    }
    if (button.dataset.retryTurn) {
      await api(`/api/chat-turns/${button.dataset.retryTurn}/retry`, { method: 'POST', body: '{}' });
      toast('Reply retried'); await refresh();
    }
    if (button.dataset.cancelExecution) {
      await api(`/api/executions/${button.dataset.cancelExecution}/cancel`, { method: 'POST', body: '{}' });
      toast('Cancel requested');
    }
    if (button.dataset.requeue) {
      await api(`/api/tasks/${button.dataset.requeue}/requeue`, { method: 'POST', body: '{}' });
      toast('Task requeued'); await refresh();
    }
    if (button.dataset.archive) {
      await api(`/api/tasks/${button.dataset.archive}/archive`, { method: 'POST', body: '{}' });
      toast('Task archived'); await refresh();
    }
    if (button.dataset.unarchive) {
      await api(`/api/tasks/${button.dataset.unarchive}/unarchive`, { method: 'POST', body: '{}' });
      toast('Task unarchived'); await refresh();
    }
    if (button.dataset.review) {
      await api(`/api/tasks/${button.dataset.review}/review`, { method: 'POST', body: JSON.stringify({ accepted: button.dataset.accepted === 'true' }) });
      toast(button.dataset.accepted === 'true' ? 'Task accepted' : 'Task rejected'); await refresh();
    }
    if (button.dataset.execution) { activeExecutionId = button.dataset.execution; renderRuns(); }
  } catch (error) { toast(error.message, true); }
});

// ---------- global buttons ----------

$('#newTaskButton').addEventListener('click', () => openTaskDialog());
$('#changeWorkspace').addEventListener('click', () => { $('#workspaceForm input').value = state.room.workspace; $('#workspaceDialog').showModal(); });
$('#workspacePath').addEventListener('click', () => $('#changeWorkspace').click());
$('#refreshButton').addEventListener('click', async () => { try { await api('/api/workspace/refresh', { method: 'POST', body: '{}' }); await refresh(); toast('Workspace refreshed'); } catch (error) { toast(error.message, true); } });
$('#scanButton').addEventListener('click', async () => {
  try { await api('/api/agents/scan', { method: 'POST', body: '{}' }); await refresh(); toast('Agent availability rescanned'); }
  catch (error) { toast(error.message, true); }
});
$('#pauseButton').addEventListener('click', async () => {
  try { await api(`/api/room/${state.room.paused ? 'resume' : 'pause'}`, { method: 'POST', body: '{}' }); await refresh(); toast(state.room.paused ? 'Room paused' : 'Room resumed'); } catch (error) { toast(error.message, true); }
});

// ---------- boot ----------

window.addEventListener('hashchange', renderRoute);
renderRoute();

const events = new EventSource('/api/events');
events.onmessage = () => eventRefresh.schedule();
events.onerror = () => toast('Live event stream reconnecting…', true);

refresh({ keepScroll: false }).catch((error) => toast(error.message, true));
setInterval(() => { if (state && currentRoute() === 'chat') renderFeed(); }, 30_000);
