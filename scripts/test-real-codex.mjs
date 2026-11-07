// E2E-real: discovery composition + real codex driver open (resume only, no turn).
const ws = new WebSocket('ws://127.0.0.1:7688');
ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'sessions.refresh' })));
ws.addEventListener('message', async (ev) => {
  const msg = JSON.parse(String(ev.data));
  if (msg.type === 'sessions') {
    const byAgent = {};
    for (const s of msg.items) byAgent[s.agent] = (byAgent[s.agent] ?? 0) + 1;
    console.log('[discovery] breakdown:', JSON.stringify(byAgent));
    for (const s of msg.items.slice(0, 6)) {
      console.log(`  ${s.agent.padEnd(7)} ${String(s.title).slice(0, 60).padEnd(62)} active=${s.active}`);
    }
    // open the newest codex session (resume only — no turn started)
    const codex = msg.items.find((s) => s.agent === 'codex');
    if (!codex) { console.log('[real] no codex session found; done'); process.exit(0); }
    console.log('[real] opening codex session (resume-only):', codex.gatewayId);
    ws.send(JSON.stringify({ type: 'session.open', gatewayId: codex.gatewayId }));
    setTimeout(() => {
      console.log('[real] codex driver stayed open for 20s without errors — resume OK');
      process.exit(0);
    }, 20000);
  } else if (msg.type === 'session.opened') {
    console.log('[real] opened:', msg.session.gatewayId);
  } else if (msg.type === 'event' && msg.event.type === 'status') {
    console.log('[real] status:', JSON.stringify(msg.event));
  } else if (msg.type === 'error') {
    console.log('[real] ERROR:', msg.message);
    process.exit(1);
  }
});
setTimeout(() => { console.log('[real] TIMEOUT'); process.exit(2); }, 40000);
