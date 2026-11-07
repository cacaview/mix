// M2 E2E: REAL Claude Code driver + DeepSeek (Anthropic-compat endpoint).
// Verifies PoC-1 end-to-end on a live agent:
//   run 1 (deny): prompt asks claude to write a file -> canUseTool request ->
//                 gateway forwards to WS client -> client DENIES ->
//                 file must NOT exist.
//   run 2 (allow): same, client ALLOWS -> file must exist with expected text.
//
// Isolation: CLAUDE_CONFIG_DIR points at a fresh dir so the user's
// ~/.claude/settings.json (local proxy, model mapping) never applies.
// Key comes from env DEEPSEEK_API_KEY (never hardcoded).

import { WebSocket } from 'ws';
import { mkdirSync, existsSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Gateway, serveGateway } from '../packages/core/src/index.ts';

const KEY = process.env.DEEPSEEK_API_KEY;
if (!KEY) { console.error('DEEPSEEK_API_KEY not set'); process.exit(2); }

const workDir = mkdtempSync(path.join(tmpdir(), 'asg-claude-e2e-'));
const configDir = mkdtempSync(path.join(tmpdir(), 'asg-claude-cfg-'));
console.log('[e2e] workDir:', workDir);

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
const server = serveGateway(gateway, { port: 7799 });
console.log('[e2e] gateway on ws://127.0.0.1:7799');

const ws = new WebSocket('ws://127.0.0.1:7799');
const state = { sessionId: null, approval: null, denied: null, toolCompleted: null, turnCompleted: null, error: null };

ws.addEventListener('open', () => {
  console.log('[e2e] ws open; creating REAL claude session…');
  ws.send(JSON.stringify({ type: 'session.create', cwd: workDir, title: 'M2 DeepSeek approval test' }));
});

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(String(ev.data));
  switch (msg.type) {
    case 'session.opened':
      if (msg.session.agent !== 'claude') return;
      state.sessionId = msg.session.gatewayId;
      console.log('[e2e] claude session live:', msg.session.gatewayId);
      run(msg.session.gatewayId, 'deny');
      break;
    case 'approval.request':
      if (!state.approval) {
        state.approval = msg.request;
        console.log('[e2e] APPROVAL REQUEST:', msg.request.tool, JSON.stringify(msg.request.input).slice(0, 160));
        const decision = state.decision ?? 'deny_once';
        console.log('[e2e] resolving ->', decision);
        ws.send(JSON.stringify({ type: 'approval.resolve', requestId: msg.request.requestId, optionId: decision }));
      }
      break;
    case 'event': {
      const e = msg.event;
      if (e.type === 'tool.completed') state.toolCompleted = e;
      if (e.type === 'turn.completed') { state.turnCompleted = e; onTurnDone(); }
      if (e.type === 'status' && e.status === 'error' && e.detail) state.error = e.detail;
      break;
    }
    case 'error':
      state.error = msg.message;
      console.log('[e2e] gateway error:', msg.message);
      break;
  }
});

function run(gatewayId, decision) {
  state.approval = null; state.toolCompleted = null; state.turnCompleted = null; state.decision = decision;
  const text = decision === 'deny'
    ? '请用 Write 工具把字符串 hello-asg-deny 写入文件 note.txt。'
    : '请用 Write 工具把字符串 hello-asg-allow 写入文件 note.txt。';
  console.log(`\n[e2e] ===== RUN ${decision.toUpperCase()} =====`);
  ws.send(JSON.stringify({ type: 'session.prompt', gatewayId, text }));
}

function onTurnDone() {
  const decision = state.decision;
  const file = path.join(workDir, 'note.txt');
  const exists = existsSync(file);
  const content = exists ? readFileSync(file, 'utf8') : '';
  console.log(`[e2e] run(${decision}) turn completed. file exists=${exists} content=${JSON.stringify(content.slice(0, 60))}`);
  console.log('[e2e] tool.completed:', JSON.stringify(state.toolCompleted?.output ?? '').slice(0, 140));

  if (decision === 'deny') {
    state.denied = !exists;
    console.log('[e2e] deny verdict: file absent =', !exists, '(expected true)');
    // second run: allow
    setTimeout(() => run(state.sessionId, 'allow'), 800);
  } else {
    const allowedOk = exists && /hello-asg-allow/.test(content);
    console.log('\n=== M2 REAL-CLAUDE RESULT ===');
    console.log('approval request surfaced to client:', Boolean(state.approval));
    console.log('deny blocked the file write:', state.denied === true);
    console.log('allow produced the file:', allowedOk);
    const pass = Boolean(state.approval) && state.denied === true && allowedOk;
    console.log('VERDICT:', pass ? 'PASS ✅' : 'FAIL ❌');
    setTimeout(() => process.exit(pass ? 0 : 1), 400);
  }
}

setTimeout(() => {
  console.log('[e2e] TIMEOUT. state:', JSON.stringify({ ...state, approval: state.approval ? 'seen' : null }).slice(0, 400));
  process.exit(3);
}, 180000);
