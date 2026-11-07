import { WebSocket } from 'ws';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Gateway, serveFacade } from '../packages/core/src/index.ts';

const KEY = process.env.DEEPSEEK_API_KEY;
const workDir = mkdtempSync(path.join(tmpdir(), 'mix-ts-'));
const configDir = mkdtempSync(path.join(tmpdir(), 'mix-ts-cfg-'));
const gateway = new Gateway({
  claudeEnv: {
    ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', ANTHROPIC_AUTH_TOKEN: KEY,
    ANTHROPIC_MODEL: 'deepseek-chat', ANTHROPIC_SMALL_FAST_MODEL: 'deepseek-chat',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-chat', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-chat',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-chat',
    CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1',
  },
});
const facade = serveFacade(gateway, { port: 7792, token: 'ttt' });

let nextId = 1;
const pending = new Map();
const notes = [];
let gotTurnCompleted = null, gotReply = null;
const ws = new WebSocket('ws://127.0.0.1:7792?token=ttt');
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(String(ev.data));
  if (msg.id !== undefined && pending.has(msg.id)) {
    const p = pending.get(msg.id); pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
  } else if (msg.method) {
    notes.push(msg.method);
    if (msg.method === 'item/completed') gotReply = JSON.stringify(msg.params?.item?.content ?? []);
    if (msg.method === 'turn/completed') gotTurnCompleted = msg.params;
  }
});
const call = (m, p) => new Promise((res, rej) => {
  const id = nextId++; pending.set(id, { resolve: res, reject: rej });
  ws.send(JSON.stringify({ jsonrpc: '2.0', id, method: m, params: p }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + m)); } }, 90_000);
});
ws.addEventListener('open', async () => {
  try {
    await call('initialize', { clientInfo: { name: 'mix-probe', title: 'probe', version: '0.0.1' } });
    const started = await call('thread/start', { cwd: workDir, title: 'remote new chat' });
    const threadId = started?.thread?.id;
    console.log('[1] thread/start ->', threadId, '(claude:', String(threadId).startsWith('claude:') + ')');
    await call('turn/start', { threadId, input: [{ type: 'text', text: 'Reply with exactly: REMOTE-NEW-OK' }] });
    const t0 = Date.now();
    while (Date.now() - t0 < 100_000 && !gotTurnCompleted) await new Promise(r => setTimeout(r, 500));
    const ok = String(threadId).startsWith('claude:') && /REMOTE-NEW-OK/.test(gotReply ?? '') && Boolean(gotTurnCompleted);
    console.log('[2] reply:', (gotReply ?? '').slice(0, 120));
    console.log('\n=== THREAD/START + AUTH RESULT ===');
    console.log('new chat = claude session:', String(threadId).startsWith('claude:'));
    console.log('turn completed with expected reply:', ok);
    console.log('notifications:', [...new Set(notes)].join(', '));
    console.log('VERDICT:', ok ? 'PASS' : 'FAIL');
    process.exit(ok ? 0 : 1);
  } catch (e) { console.log('FATAL:', e.message); process.exit(1); }
});
setTimeout(() => { console.log('TIMEOUT'); process.exit(3); }, 140_000);
