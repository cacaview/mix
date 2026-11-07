// M2b: cross-process resume — open the SAME session id in a brand-new driver
// (new claude process) and ask what the file contains. The gateway's
// openSession(ref) path uses resume:true for discovered sessions.

import { WebSocket } from 'ws';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Gateway, serveGateway } from '../packages/core/src/index.ts';

const KEY = process.env.DEEPSEEK_API_KEY;
if (!KEY) { console.error('DEEPSEEK_API_KEY not set'); process.exit(2); }

const sessionId = process.argv[2];
const oldCfg = process.argv[3];
const cwd = process.argv[4];
if (!sessionId || !oldCfg || !cwd) { console.error('usage: node test-claude-resume.mjs <sessionId> <configDir> <cwd>'); process.exit(2); }
if (!existsSync(cwd)) { console.error('cwd does not exist:', cwd); process.exit(2); }
console.log('[resume] cwd:', cwd);

const gateway = new Gateway({
  claudeEnv: {
    ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
    ANTHROPIC_AUTH_TOKEN: KEY,
    ANTHROPIC_MODEL: 'deepseek-chat',
    ANTHROPIC_SMALL_FAST_MODEL: 'deepseek-chat',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-chat',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-chat',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-chat',
    CLAUDE_CONFIG_DIR: oldCfg,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
  },
});
const server = serveGateway(gateway, { port: 7798 });

const ws = new WebSocket('ws://127.0.0.1:7798');
let text = '';
ws.addEventListener('open', async () => {
  // Register the ref then open (resume:true path).
  gateway.upsertSession({
    gatewayId: `claude:${sessionId}`, agent: 'claude', nativeId: sessionId,
    title: 'resume test', cwd, updatedAtMs: Date.now(), active: false,
  });
  await gateway.openSession(`claude:${sessionId}`);
  console.log('[resume] driver resumed in NEW process; prompting…');
  ws.send(JSON.stringify({ type: 'session.prompt', gatewayId: `claude:${sessionId}`, text: 'note.txt 文件的内容是什么?只回复文件内容本身,不要其他文字。' }));
});
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(String(ev.data));
  if (msg.type === 'event' && msg.event.type === 'message.completed' && msg.event.role === 'assistant') {
    text += msg.event.text;
  } else if (msg.type === 'event' && msg.event.type === 'turn.completed') {
    const expected = 'hello-asg-allow';
    const ok = text.includes(expected);
    console.log('[resume] assistant said:', JSON.stringify(text.trim().slice(0, 200)));
    console.log('\n=== M2b RESUME RESULT ===');
    console.log(`new process remembers prior turn content (${expected}):`, ok);
    console.log('VERDICT:', ok ? 'PASS ✅' : 'FAIL ❌');
    process.exit(ok ? 0 : 1);
  } else if (msg.type === 'error') {
    console.log('[resume] error:', msg.message);
  }
});
setTimeout(() => { console.log('[resume] TIMEOUT'); process.exit(3); }, 120000);
