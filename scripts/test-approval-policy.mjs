// Approval policy verification (mock driver): allow/deny policies resolve
// without any client interaction; interactive still emits approval.request.
import { Gateway } from '../packages/core/src/index.ts';
import { randomUUID } from 'node:crypto';

const run = async (policy) => {
  const gateway = new Gateway({ approvalPolicy: policy });
  const id = `mock:${randomUUID()}`;
  gateway.upsertSession({ gatewayId: id, agent: 'mock', nativeId: id.slice(5), title: 'policy test', cwd: process.cwd(), updatedAtMs: Date.now(), active: false });
  const events = [];
  gateway.on('event', (_, e) => events.push(e));
  gateway.on('approval', () => events.push({ type: '_approval.emitted' }));
  await gateway.openSession(id);
  await gateway.prompt(id, 'please write a file now');
  const toolDone = events.find((e) => e.type === 'tool.completed');
  return { emitted: events.some((e) => e.type === '_approval.emitted'), output: String(toolDone?.output ?? '') };
};

const a = await run('allow');
const d = await run('deny');
console.log('policy=allow ->', a.output, '(client approval emitted:', a.emitted + ')');
console.log('policy=deny  ->', d.output, '(client approval emitted:', d.emitted + ')');
const pass = !a.emitted && /approved/.test(a.output) && !d.emitted && /denied/.test(d.output);
console.log('VERDICT:', pass ? 'PASS' : 'FAIL');
process.exit(pass ? 0 : 1);
