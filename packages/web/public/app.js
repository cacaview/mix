// Mix web client — vanilla JS over the gateway WS protocol (no build step).

const ws = new WebSocket(`ws://${location.host}`);
let sessions = [];
let currentId = null;
let pendingApprovals = new Map();

const $ = (sel) => document.querySelector(sel);
const listEl = $('#session-list');
const transcriptEl = $('#transcript');
const approvalsEl = $('#approvals');
const promptEl = $('#prompt');

function send(msg) { ws.send(JSON.stringify(msg)); }

function agentColor(agent) {
  return { claude: '#d97757', codex: '#4da3ff', opencode: '#3ecf8e', mock: '#a78bfa' }[agent] ?? '#888';
}

function renderSessions() {
  listEl.innerHTML = '';
  for (const s of sessions) {
    const li = document.createElement('li');
    li.className = s.gatewayId === currentId ? 'selected' : '';
    const when = new Date(s.updatedAtMs).toLocaleString();
    li.innerHTML = `
      <div class="agent" style="color:${agentColor(s.agent)}">${s.agent}${s.active ? ' <span class="badge-active">●</span>' : ''}</div>
      <div class="title">${escapeHtml(s.title || s.nativeId)}</div>
      <div class="meta">${when}</div>`;
    li.onclick = () => openSession(s.gatewayId);
    listEl.appendChild(li);
  }
}

function escapeHtml(t) {
  return String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function appendMsg(className, text) {
  const div = document.createElement('div');
  div.className = `msg ${className}`;
  div.textContent = text;
  transcriptEl.appendChild(div);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
  return div;
}

function openSession(gatewayId) {
  currentId = gatewayId;
  transcriptEl.innerHTML = '';
  renderSessions();
  send({ type: 'session.open', gatewayId });
}

function renderApproval(req) {
  const div = document.createElement('div');
  div.className = 'approval';
  div.dataset.requestId = req.requestId;
  div.innerHTML = `
    <div>🔐 工具审批:<span class="tool-name">${escapeHtml(req.tool)}</span> <span style="color:var(--dim)">(${escapeHtml(req.sessionId)})</span></div>
    <pre>${escapeHtml(JSON.stringify(req.input, null, 2))}</pre>
    <div class="actions">
      <button class="allow">允许一次</button>
      <button class="deny">拒绝</button>
    </div>`;
  div.querySelector('.allow').onclick = () => resolveApproval(req.requestId, 'allow_once');
  div.querySelector('.deny').onclick = () => resolveApproval(req.requestId, 'deny_once');
  approvalsEl.appendChild(div);
}

function resolveApproval(requestId, optionId) {
  send({ type: 'approval.resolve', requestId, optionId });
  pendingApprovals.delete(requestId);
  approvalsEl.querySelector(`[data-request-id="${requestId}"]`)?.remove();
}

function handleEvent(gatewayId, e) {
  if (gatewayId !== currentId) return;
  switch (e.type) {
    case 'message.delta': {
      if (e.role === 'assistant') {
        if (!handleEvent._cur || handleEvent._done) {
          handleEvent._cur = appendMsg('assistant', '');
          handleEvent._done = false;
        }
        handleEvent._cur.textContent += e.text;
        transcriptEl.scrollTop = transcriptEl.scrollHeight;
      }
      break;
    }
    case 'message.completed':
      if (handleEvent._cur && !handleEvent._done) { handleEvent._done = true; }
      else appendMsg('assistant', e.text ?? '');
      break;
    case 'reasoning.delta': appendMsg('reasoning', e.text); break;
    case 'tool.started': {
      const div = appendMsg('tool', '');
      div.innerHTML = `<span class="tool-name">🔧 ${escapeHtml(e.tool)}</span> ${escapeHtml(JSON.stringify(e.input ?? {}).slice(0, 300))}`;
      break;
    }
    case 'tool.completed': appendMsg('tool', `↳ ${e.isError ? 'error: ' : ''}${JSON.stringify(e.output ?? '').slice(0, 500)}`); break;
    case 'turn.completed': appendMsg('status-line', e.error ? `⚠ ${e.error}` : '— turn 完成 —'); break;
    case 'status': if (e.detail) appendMsg('status-line', `[${e.status}] ${e.detail}`); break;
  }
}

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  switch (msg.type) {
    case 'sessions': sessions = msg.items; renderSessions(); break;
    case 'session.opened':
      if (msg.session.gatewayId === currentId) {
        appendMsg('status-line', `已连接 ${msg.session.gatewayId} (${msg.session.agent})`);
      }
      break;
    case 'event': handleEvent(msg.gatewayId, msg.event); break;
    case 'approval.request':
      pendingApprovals.set(msg.request.requestId, msg.request);
      renderApproval(msg.request);
      break;
    case 'approval.resolved':
      pendingApprovals.delete(msg.requestId);
      approvalsEl.querySelector(`[data-request-id="${msg.requestId}"]`)?.remove();
      break;
    case 'error': appendMsg('status-line', `⚠ ${msg.message}`); break;
  }
};

$('#composer').onsubmit = (ev) => {
  ev.preventDefault();
  const text = promptEl.value.trim();
  if (!text || !currentId) return;
  appendMsg('user', text);
  send({ type: 'session.prompt', gatewayId: currentId, text });
  promptEl.value = '';
  handleEvent._done = true; handleEvent._cur = null;
};

$('#interrupt').onclick = () => currentId && send({ type: 'session.interrupt', gatewayId: currentId });
$('#refresh').onclick = () => send({ type: 'sessions.refresh' });
$('#new-mock').onclick = () => send({ type: 'session.mock.create', title: `Mock ${new Date().toLocaleTimeString()}` });
