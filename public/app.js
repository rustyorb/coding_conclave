const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
let state = null;
let activeExecutionId = null;
let refreshTimer = null;

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

async function refresh({ keepScroll = true } = {}) {
  const feed = $('#feed');
  const nearBottom = !state || feed.scrollHeight - feed.scrollTop - feed.clientHeight < 100;
  state = await api('/api/state');
  render();
  if (!keepScroll || nearBottom) requestAnimationFrame(() => { feed.scrollTop = feed.scrollHeight; });
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refresh().catch((error) => toast(error.message, true)), 90);
}

function initials(name) {
  return name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
}

function renderAgents() {
  $('#agentList').innerHTML = state.agents.map((agent) => `
    <article class="agent-card ${esc(agent.activity)}">
      <div class="agent-top">
        <div class="avatar ${esc(agent.id)}">${esc(initials(agent.name))}</div>
        <div class="agent-name"><strong>${esc(agent.name)}</strong><span>${esc(agent.provider)} · ${esc(agent.version || 'not installed')}</span></div>
        <span class="status-pill ${esc(agent.connection)}">${agent.activity === 'running' ? 'working' : esc(agent.connection === 'verified' ? 'verified' : agent.status)}</span>
      </div>
      <div class="agent-action">${esc(agent.lastAction)}</div>
    </article>`).join('');
  $('#taskAgent').innerHTML = state.agents.map((agent) => `<option value="${esc(agent.id)}" ${agent.status !== 'installed' ? 'disabled' : ''}>${esc(agent.name)} · ${esc(agent.connection === 'verified' ? 'verified' : agent.status)}</option>`).join('');
  const running = state.agents.filter((agent) => agent.activity === 'running').length;
  const maximum = state.room.limits.maxConcurrentRuns;
  $('#concurrency').textContent = `${running} / ${maximum}`;
  $('#concurrencyMeter').style.width = `${Math.min(100, running / maximum * 100)}%`;
}

function renderFeed() {
  $('#messageCount').textContent = state.messages.length;
  $('#feed').innerHTML = state.messages.length ? state.messages.map((message) => {
    const sourceClass = message.source === 'user' ? 'user' : message.source === 'system' ? 'system' : message.source;
    const chip = ['message', 'system'].includes(message.type) ? '' : `<span class="type-chip">${esc(message.type)}</span>`;
    return `<article class="message ${message.source === 'system' ? 'system-message' : ''}">
      <div class="message-avatar ${esc(sourceClass)}">${message.source === 'user' ? 'YOU' : esc(initials(message.sourceName))}</div>
      <div><div class="message-head"><strong>${esc(message.sourceName)}</strong>${chip}<span class="message-time">${relativeTime(message.createdAt)}</span></div><div class="message-body">${esc(message.content)}</div></div>
    </article>`;
  }).join('') : '<div class="empty"><div><strong>The room is quiet.</strong>Start a task or address an installed agent.</div></div>';
}

function taskLane(title, statuses) {
  const tasks = state.tasks.filter((task) => statuses.includes(task.status));
  return `<section class="task-lane"><div class="lane-head"><span>${title}</span><span>${tasks.length}</span></div>${tasks.map((task) => {
    const agent = state.agents.find((entry) => entry.id === task.agentId);
    const review = task.status === 'review-required' ? `<div class="task-actions"><button class="tiny-button accept" data-review="${task.id}" data-accepted="true">Accept</button><button class="tiny-button reject" data-review="${task.id}" data-accepted="false">Reject</button></div>` : '';
    const cancel = task.status === 'active' ? `<div class="task-actions"><button class="tiny-button reject" data-cancel="${task.id}">Interrupt</button></div>` : '';
    return `<article class="task-card"><h3>${esc(task.title)}</h3><p>${esc(task.objective)}</p><div class="task-meta"><span>${esc(agent?.name || task.agentId)}</span><span>${esc(task.status)}</span></div>${review}${cancel}</article>`;
  }).join('') || '<div class="blank-state">No tasks</div>'}</section>`;
}

function renderTasks() {
  $('#taskCount').textContent = state.tasks.length;
  $('#taskBoard').innerHTML = [
    taskLane('Queued', ['proposed', 'ready', 'waiting']),
    taskLane('In motion', ['active', 'review-required']),
    taskLane('Resolved', ['completed', 'failed', 'cancelled', 'rejected', 'blocked'])
  ].join('');
}

function renderApprovals() {
  const pending = state.approvals.filter((entry) => entry.status === 'pending');
  $('#approvalCount').textContent = pending.length;
  $('#approvals').innerHTML = pending.length ? pending.map((approval) => `
    <article class="approval-card">
      <h3>${esc(approval.title)}</h3><p>${esc(approval.detail)}</p>
      <div class="approval-command">${esc(approval.command)}<br><span>${esc(approval.cwd)}</span></div>
      <div class="approval-actions"><button class="tiny-button reject" data-approval="${approval.id}" data-decision="denied">Deny</button><button class="tiny-button accept" data-approval="${approval.id}" data-decision="approved">Approve</button></div>
    </article>`).join('') : '<div class="blank-state">No actions are waiting.<br>You retain final control.</div>';
}

function renderWorkspace() {
  $('#workspacePath').textContent = state.room.workspace;
  $('#workspacePath').title = state.room.workspace;
  $('#fileCount').textContent = state.workspace.status.length;
  $('#lineCount').textContent = state.workspace.diff ? state.workspace.diff.split('\n').length : 0;
  $('#fileList').innerHTML = state.workspace.status.length ? state.workspace.status.map((line) => `
    <div class="file-row"><span class="file-status">${esc(line.slice(0, 2).trim() || '?')}</span><span class="file-name">${esc(line.slice(3))}</span></div>`).join('') : '<div class="blank-state">Working tree is clean</div>';
  $('#diffOutput').textContent = state.workspace.diff || 'No tracked diff. Untracked file contents are not displayed until Git tracks them.';
}

function renderExecutions() {
  if (!activeExecutionId && state.executions.length) activeExecutionId = state.executions[0].id;
  const active = state.executions.find((entry) => entry.id === activeExecutionId) || state.executions[0];
  $('#executionTabs').innerHTML = state.executions.map((execution) => `<button class="execution-tab ${execution.id === active?.id ? 'active' : ''}" data-execution="${execution.id}">${esc(execution.agentId || 'command')} · ${esc(execution.status)}</button>`).join('');
  $('#consoleOutput').textContent = active ? `${active.command}\n\n${active.output || 'Process started; waiting for output…'}` : 'No executions yet.';
  const output = $('#consoleOutput');
  output.scrollTop = output.scrollHeight;
}

function renderHealth() {
  const installed = state.agents.filter((agent) => agent.status === 'installed').length;
  const verified = state.agents.filter((agent) => agent.connection === 'verified').length;
  const pending = state.approvals.filter((approval) => approval.status === 'pending').length;
  $('#roomHealth').innerHTML = `
    <div class="health-row"><span>Agent connectivity</span><strong>${verified}/${installed} verified</strong></div>
    <div class="health-row"><span>Room execution</span><strong>${state.room.paused ? 'paused' : 'live'}</strong></div>
    <div class="health-row"><span>Pending authority</span><strong>${pending}</strong></div>
    <div class="health-row"><span>Audit events</span><strong>${state.audit.length}</strong></div>`;
}

function render() {
  $('#roomName').textContent = state.room.name;
  $('#roomMode').textContent = state.room.mode.replace('-', ' ');
  $('#pauseButton').textContent = state.room.paused ? 'Resume room' : 'Pause room';
  $('#pauseButton').classList.toggle('danger', !state.room.paused);
  renderAgents(); renderFeed(); renderTasks(); renderApprovals(); renderWorkspace(); renderExecutions(); renderHealth();
}

$('#composer').addEventListener('submit', async (event) => {
  event.preventDefault();
  const content = $('#messageInput').value.trim();
  if (!content) return;
  $('#messageInput').value = '';
  try {
    const result = await api('/api/messages', { method: 'POST', body: JSON.stringify({ content, accessMode: $('#messageAccess').value }) });
    toast(result.tasksCreated ? `Message sent · ${result.tasksCreated} agent run${result.tasksCreated > 1 ? 's' : ''} routed` : 'Message added to room');
    await refresh({ keepScroll: false });
  } catch (error) { $('#messageInput').value = content; toast(error.message, true); }
});

$('#messageInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('#composer').requestSubmit(); }
});

$('#taskForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  try {
    await api('/api/tasks', { method: 'POST', body: JSON.stringify(Object.fromEntries(form)) });
    $('#taskDialog').close(); formElement.reset(); toast('Task created'); await refresh();
  } catch (error) { toast(error.message, true); }
});

$('#commandForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  try {
    await api('/api/commands', { method: 'POST', body: JSON.stringify(Object.fromEntries(form)) });
    formElement.reset(); $('#consoleDialog').close(); toast('Command sent to Approval Center'); await refresh();
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

document.addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  try {
    if (button.dataset.view) {
      $$('.tab').forEach((entry) => entry.classList.toggle('active', entry === button));
      $$('.view').forEach((entry) => entry.classList.remove('active'));
      $(`#${button.dataset.view}View`).classList.add('active');
    }
    if (button.dataset.close) $(`#${button.dataset.close}`).close();
    if (button.dataset.approval) {
      await api(`/api/approvals/${button.dataset.approval}`, { method: 'POST', body: JSON.stringify({ decision: button.dataset.decision }) });
      toast(`Action ${button.dataset.decision}`); await refresh();
    }
    if (button.dataset.cancel) {
      await api(`/api/tasks/${button.dataset.cancel}/cancel`, { method: 'POST', body: '{}' }); toast('Interrupt requested');
    }
    if (button.dataset.review) {
      await api(`/api/tasks/${button.dataset.review}/review`, { method: 'POST', body: JSON.stringify({ accepted: button.dataset.accepted === 'true' }) });
      toast(button.dataset.accepted === 'true' ? 'Task accepted' : 'Task rejected'); await refresh();
    }
    if (button.dataset.execution) { activeExecutionId = button.dataset.execution; renderExecutions(); }
  } catch (error) { toast(error.message, true); }
});

$('#newTaskButton').addEventListener('click', () => $('#taskDialog').showModal());
$('#consoleButton').addEventListener('click', () => { renderExecutions(); $('#consoleDialog').showModal(); });
$('#diffButton').addEventListener('click', () => $('#diffDialog').showModal());
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

const events = new EventSource('/api/events');
events.onmessage = () => scheduleRefresh();
events.onerror = () => toast('Live event stream reconnecting…', true);

refresh({ keepScroll: false }).catch((error) => toast(error.message, true));
setInterval(() => { if (state) renderFeed(); }, 30_000);
