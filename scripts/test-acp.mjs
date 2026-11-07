// ACP driver e2e: spawns the official claude-agent-acp adapter (which wraps
// claude CLI underneath — DeepSeek env applies) and verifies:
//   1) new session via session/new
//   2) prompt -> reply through session/update chunks
//   3) approval forwarding: Write tool -> session/request_permission ->
//      gateway broker -> deny -> tool_call_update failed + file NOT created
// Usage: npx tsx scripts/test-acp.mjs  (needs DEEPSEEK_API_KEY)
import { Gateway } from '../packages/core/src/index.ts';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const KEY = process.env.DEEPSEEK_API_KEY;
if (!KEY) { console.error('DEEPSEEK_API_KEY not set'); process.exit(2); }

const workDir = mkdtempSync(path.join(tmpdir(), 'mix-acp-'));
const configDir = mkdtempSync(path.join(tmpdir(), 'mix-acp-cfg-'));
const gateway = new Gateway({
  claudeEnv: {
    ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', ANTHROPIC_AUTH_TOKEN: KEY,
    ANTHROPIC_MODEL: 'deepseek-chat', ANTHROPIC_SMALL_FAST_MODEL: 'deepseek-chat',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-chat', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-chat',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-chat',
    CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1',
  },
  acpAgents: [{ name: 'claude-acp', command: 'claude-agent-acp', args: [] }],
});

const events = [];
let sawPermissionRequest = false;
gateway.on('event', (id, e) => events.push(e));
gateway.on('approval', (req) => {
  sawPermissionRequest = true;
  console.log('[acp] APPROVAL REQUEST:', req.tool, JSON.stringify(req.input).slice(0, 140));
  gateway.resolveApproval({ requestId: req.requestId, optionId: 'deny_once' });
});

console.log('[1] creating ACP session (claude-agent-acp adapter)…');
const ref = await gateway.createAcpSession('claude-acp', workDir, 'ACP e2e');
console.log('    session:', ref.gatewayId, 'nativeId:', ref.nativeId.slice(0, 20));

console.log('[2] prompting (should trigger Write + permission request)…');
await gateway.prompt(ref.gatewayId, '请用 Write 工具把字符串 ACP-DENY 写入文件 note.txt。');
await new Promise((r) => setTimeout(r, 800));

const file = path.join(workDir, 'note.txt');
const reply = events.filter((e) => e.type === 'message.completed').map((e) => e.text).join(' ');
const toolDone = events.find((e) => e.type === 'tool.completed');
console.log('[3] assistant said:', JSON.stringify(reply.slice(0, 120)));
console.log('[4] tool.completed:', JSON.stringify(toolDone?.output ?? '').slice(0, 160));
console.log('    file exists:', existsSync(file), '(expected false — denied)');

const pass = ref.agent === 'acp' && sawPermissionRequest && !existsSync(file);
console.log('\n=== ACP DRIVER RESULT ===');
console.log('ACP session created + prompted:', ref.agent === 'acp');
console.log('permission request forwarded to broker:', sawPermissionRequest);
console.log('denial blocked the write:', !existsSync(file));
console.log('VERDICT:', pass ? 'PASS ✅' : 'FAIL ❌');
process.exit(pass ? 0 : 1);
