// M3 E2E: OpenCode driver through the gateway (real opencode server + DeepSeek).
// Prereq: opencode serve on :4096 with the dsx provider configured (see
// investigation notes) and a session created.
// Usage: node test-opencode.mjs <opencodeSessionId>

import { Gateway } from '../packages/core/src/index.ts';

const sessionId = process.argv[2];
if (!sessionId) { console.error('usage: node test-opencode.mjs <opencodeSessionId>'); process.exit(2); }

const gateway = new Gateway({ opencodeUrl: 'http://127.0.0.1:4096' });
const events = [];
gateway.on('event', (id, e) => {
  events.push(e);
  if (e.type === 'message.completed') console.log(`[ev] ${e.role}: ${String(e.text).slice(0, 80)}`);
  else if (e.type !== 'status' || e.detail) console.log(`[ev] ${e.type}${e.detail ? ` (${String(e.detail).slice(0, 80)})` : ''}`);
});

console.log('[m3] discovering sessions…');
const all = await gateway.refreshSessions();
console.log('[m3] indexed:', all.map((s) => `${s.agent}:${s.nativeId.slice(0, 14)}`).join(', '));

const gatewayId = `opencode:${sessionId}`;
console.log('[m3] opening', gatewayId);
await gateway.openSession(gatewayId);
console.log('[m3] prompting…');
await gateway.prompt(gatewayId, 'Reply with exactly: GW-OC-OK');
await new Promise((r) => setTimeout(r, 800));

const text = events.filter((e) => e.type === 'message.completed' && e.role === 'assistant').map((e) => e.text).join('');
const sawTurn = events.some((e) => e.type === 'turn.started') && events.some((e) => e.type === 'turn.completed');
console.log('\n=== M3 OPENCODE RESULT ===');
console.log('discovery saw opencode session:', all.some((s) => s.gatewayId === gatewayId));
console.log('turn lifecycle events:', sawTurn);
console.log('assistant reply:', JSON.stringify(text));
console.log('reply correct:', text.includes('GW-OC-OK'));
const pass = sawTurn && text.includes('GW-OC-OK');
console.log('VERDICT:', pass ? 'PASS ✅' : 'FAIL ❌');
process.exit(pass ? 0 : 1);
