// E2E: gateway WS protocol — mock session + approval forwarding (PoC-1).
// Run: node test-e2e.mjs  (expects gateway on ws://127.0.0.1:7688)

const url = 'ws://127.0.0.1:7688';
const ws = new WebSocket(url);
const events = [];
const approvals = [];
let sessionOpened = null;

ws.addEventListener('open', async () => {
  console.log('[ws] open');
  ws.send(JSON.stringify({ type: 'sessions.refresh' }));
  ws.send(JSON.stringify({ type: 'session.mock.create', title: 'E2E approval test' }));
});

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(String(ev.data));
  if (msg.type === 'sessions') {
    const mock = msg.items.find((s) => s.agent === 'mock' && s.title === 'E2E approval test');
    if (mock && !sessionOpened) {
      sessionOpened = mock.gatewayId;
      console.log('[e2e] opening mock session:', mock.gatewayId);
      ws.send(JSON.stringify({ type: 'session.open', gatewayId: mock.gatewayId }));
    }
  } else if (msg.type === 'session.opened' && msg.session.agent === 'mock') {
    console.log('[e2e] session opened, prompting (should trigger approval)…');
    ws.send(JSON.stringify({ type: 'session.prompt', gatewayId: msg.session.gatewayId, text: 'please write a file now' }));
  } else if (msg.type === 'approval.request') {
    approvals.push(msg.request);
    console.log('[e2e] APPROVAL REQUEST:', msg.request.tool, JSON.stringify(msg.request.input));
    // Deny it — the correct outcome must propagate back to the driver.
    setTimeout(() => {
      console.log('[e2e] resolving approval -> deny_once');
      ws.send(JSON.stringify({ type: 'approval.resolve', requestId: msg.request.requestId, optionId: 'deny_once' }));
    }, 300);
  } else if (msg.type === 'event') {
    events.push(msg.event);
    if (msg.event.type === 'tool.completed') {
      console.log('[e2e] tool.completed:', JSON.stringify(msg.event.output));
    }
    if (msg.event.type === 'turn.completed') {
      console.log('[e2e] turn completed.');
      finish();
    }
  } else if (msg.type === 'error') {
    console.log('[e2e] ERROR:', msg.message);
  }
});

function finish() {
  setTimeout(() => {
    const toolDone = events.find((e) => e.type === 'tool.completed');
    const denied = toolDone && toolDone.isError === true && /denied/i.test(String(toolDone.output ?? ''));
    console.log('\n=== E2E RESULT ===');
    console.log('approval request seen:', approvals.length === 1);
    console.log('denial propagated to driver:', denied);
    console.log('event timeline:', events.map((e) => e.type).join(' → '));
    process.exit(denied && approvals.length === 1 ? 0 : 1);
  }, 500);
}

setTimeout(() => { console.log('[e2e] TIMEOUT'); process.exit(2); }, 20000);
