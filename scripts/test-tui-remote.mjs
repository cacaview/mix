// Real Codex TUI --remote test: spawns the facade, then opens a REAL console
// window running `codex --remote ws://127.0.0.1:PORT`. The facade logs every
// incoming method; we verify the TUI actually connected and spoke the
// app-server protocol. The window auto-closes after the probe.
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Unique port per run — leaked prior probes can't collide.
const PORT = 7740 + (Date.now() % 40);
const workDir = mkdtempSync(path.join(tmpdir(), 'asg-tui-'));

// Server script lives inside the repo so `tsx/esm` resolves from prototype/node_modules.
const serverScript = path.join(process.cwd(), 'scripts', '_tui-serve.tmp.mjs');
writeFileSync(serverScript, `
import { register } from 'tsx/esm/api';
await register();
const { pathToFileURL } = await import('node:url');
const coreUrl = pathToFileURL('${process.cwd().replace(/\\/g, '/')}/packages/core/src/index.ts').href;
const { Gateway, serveFacade } = await import(coreUrl);
const gateway = new Gateway();
await gateway.refreshSessions();
const facade = serveFacade(gateway, { port: ${PORT} });
console.error('[serve] facade ready');
process.on('exit', () => facade.close());
`);

const server = spawn('npx', ['tsx', serverScript], { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
await new Promise((r) => setTimeout(r, 12000));
if (!serverLog.includes('facade ready')) { console.log('server failed:\n' + serverLog); process.exit(1); }

// Open a REAL console session running codex TUI against the facade.
// TUI needs a real console on BOTH stdin and stdout, so no redirection —
// the facade-side method log is the evidence.
const inner = `codex resume --remote ws://127.0.0.1:${PORT}`;
const child = spawn('powershell.exe', ['-NoProfile', '-Command',
  `Start-Process cmd -ArgumentList '/c', '${inner.replace(/'/g, "''")}' -WindowStyle Hidden`],
  { shell: false, detached: false, stdio: 'ignore' });
void child;

console.log('[probe] console window launched; waiting for TUI traffic…');
await new Promise((r) => setTimeout(r, 25000));

console.log('=== facade log tail ===');
console.log(serverLog.split('\n').slice(-30).join('\n'));

const sawConnect = serverLog.includes('client connected');
const sawInit = /initialize/.test(serverLog);
const sawList = /thread\/list/.test(serverLog);

console.log('\n=== M4b TUI PROBE RESULT ===');
console.log('TUI connected to facade:', sawConnect);
console.log('TUI sent initialize:', sawInit);
console.log('TUI sent thread/list:', sawList);
console.log('VERDICT:', sawConnect && sawInit ? 'PASS ✅ (TUI speaks facade protocol)' : 'PARTIAL/FAIL ❌');
try { execSync(`taskkill /T /F /PID ${server.pid}`); } catch { try { server.kill(); } catch {} }
process.exit(sawConnect && sawInit ? 0 : 1);
