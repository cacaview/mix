// M4 E2E: Codex App Server facade.
//  1) initialize
//  2) thread/list → merged list (claude:* refs + upstream codex UUID threads)
//  3) thread/resume on a codex thread → proxied upstream (real app-server child)
//  4) create claude session (DeepSeek) → thread/resume via facade → turn/start
//     → expect turn/started + item/* + turn/completed notifications
// Usage: node test-facade.mjs (env DEEPSEEK_API_KEY required)

import { WebSocket } from 'ws';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Gateway, serveGateway, serveFacade } from '../packages/core/src/index.ts';

const KEY = process.env.DEEPSEEK_API_KEY;
if (!KEY) { console.error('DEEPSEEK_API_KEY not set'); process.exit(2); }

const workDir = mkdtempSync(path.join(tmpdir(), 'asg-facade-'));
const configDir = mkdtempSync(path.join(tmpdir(), 'asg-facade-cfg-'));
const gateway = new Gateway({
  claudeEnv: {
    ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
    ANTHROPIC_AUTH_TOKEN: KEY,
    ANTHROPIC_MODEL: 'deepseek-chat',
    ANTHROPIC_SMALL_FAST_MODEL: 'deepseek-chat',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-chat',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-chat',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-chat',
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
  },
});
serveGateway(gateway, { port: 7797 });
const facade = serveFacade(gateway, { port: 7796 });
console.log('[facade-test] facade on ws://127.0.0.1:7796, gateway on 7797');

// Create a REAL claude session (fresh uuid, resume:false on first open).
// The facade flow afterwards exercises thread/resume + turn/start on it.

const ws = new WebSocket('ws://127.0.0.1:7796');
let nextId = 1;
const pending = new Map();
const notes = [];
let gotItemCompleted = null;
let gotTurnCompleted = null;

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(String(ev.data));
  if (msg.id !== undefined && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
  } else if (msg.method) {
    notes.push(msg.method);
    if (msg.method === 'item/completed') gotItemCompleted = msg.params;
    if (msg.method === 'turn/completed') gotTurnCompleted = msg.params;
    console.log(`[notif] ${msg.method} ${JSON.stringify(msg.params ?? {}).slice(0, 140)}`);
  }
});

function call(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout ' + method)); } }, 90_000);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

ws.addEventListener('open', async () => {
  try {
    await call('initialize', { clientInfo: { name: 'facade-probe', title: 'probe', version: '0.0.1' } });
    console.log('[1] initialize OK');

    const ref = await gateway.createClaudeSession(workDir, 'Facade E2E');
    console.log('[0] real claude session created:', ref.gatewayId);

    // Seed upstream discovery: refresh sessions so codex threads are indexed.
    await gateway.refreshSessions();

    const list = await call('thread/list', {});
    const ids = (list?.data ?? []).map((t) => t.id);
    const claudeCount = ids.filter((i) => i.startsWith('claude:')).length;
    const codexCount = ids.filter((i) => !i.startsWith('claude:')).length;
    console.log(`[2] thread/list: ${ids.length} threads (claude:${claudeCount}, codex:${codexCount})`);
    console.log('    claude ids present:', ids.filter((i) => i.startsWith('claude:')).join(', ') || 'NONE');

    // 3) resume a real codex thread via upstream proxy
    const codexId = ids.find((i) => !i.startsWith('claude:'));
    let upstreamProxyOk = false;
    if (codexId) {
      try {
        await call('thread/resume', { threadId: codexId });
        upstreamProxyOk = true;
        console.log(`[3] upstream proxy thread/resume OK (${codexId.slice(0, 18)}…)`);
      } catch (e) { console.log('[3] upstream proxy FAIL:', e.message.slice(0, 120)); }
    } else {
      console.log('[3] no codex thread available (upstream list empty)');
      upstreamProxyOk = true; // nothing to prove; not a failure of the facade
    }

    // 4) claude thread through the facade
    await call('thread/resume', { threadId: ref.gatewayId });
    console.log('[4a] facade thread/resume claude OK');
    await call('turn/start', { threadId: ref.gatewayId, input: [{ type: 'text', text: 'Reply with exactly: FACADE-OK' }] });
    console.log('[4b] turn/start accepted; waiting for notifications…');

    const t0 = Date.now();
    while (Date.now() - t0 < 100000 && !gotTurnCompleted) await sleep(500);

    const sawTurnStarted = notes.includes('turn/started');
    const sawStatusActive = notes.includes('thread/status/changed');
    const assistantText = JSON.stringify(gotItemCompleted ?? {});
    const replyOk = /FACADE-OK/.test(assistantText);

    console.log('\n=== M4 FACADE RESULT ===');
    console.log('merged thread/list (claude + codex):', claudeCount >= 1 && codexCount >= 1);
    console.log('upstream codex resume proxied:', upstreamProxyOk);
    console.log('turn/started notification:', sawTurnStarted);
    console.log('thread/status/changed notification:', sawStatusActive);
    console.log('assistant item/completed with expected reply:', replyOk);
    console.log('turn/completed notification:', Boolean(gotTurnCompleted));
    const pass = claudeCount >= 1 && codexCount >= 1 && upstreamProxyOk && sawTurnStarted && replyOk && Boolean(gotTurnCompleted);
    console.log('VERDICT:', pass ? 'PASS ✅' : 'FAIL ❌');
    process.exit(pass ? 0 : 1);
  } catch (e) {
    console.log('[facade-test] FATAL:', e.message);
    process.exit(1);
  }
});

setTimeout(() => { console.log('[facade-test] TIMEOUT'); process.exit(3); }, 140000);
