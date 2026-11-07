#!/usr/bin/env node
// ASG GUI — Electron shell over the gateway web UI.
// Spawns the gateway server (CLI serve) if it isn't already listening, then
// opens a desktop window pointing at it. Same protocol, same UI, zero
// duplication — the web layer is the single source of the GUI's surface.

const { spawn } = require('node:child_process');
const { app, BrowserWindow, shell } = require('electron');
const http = require('node:http');
const path = require('node:path');

const PORT = Number(process.env.ASG_PORT ?? 7688);
const URL = `http://127.0.0.1:${PORT}/`;

function probe() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${PORT}/global/health`.replace('/global/health', '/'), (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1200, () => { req.destroy(); resolve(false); });
  });
}

async function ensureGateway() {
  if (await probe()) return null;
  // Spawn `npx tsx packages/cli/src/index.ts serve --port N` from the repo root.
  const repoRoot = path.join(__dirname, '..', '..', '..');
  const child = spawn('npx', ['tsx', path.join('packages', 'cli', 'src', 'index.ts'), 'serve', '--port', String(PORT)], {
    cwd: repoRoot,
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', (d) => console.log(`[asg-gateway] ${d}`.trimEnd()));
  child.stderr.on('data', (d) => console.error(`[asg-gateway] ${d}`.trimEnd()));
  child.on('exit', (code) => { if (code && code !== 0) console.error(`[asg-gui] gateway exited (${code})`); });
  // Wait for the web UI to answer.
  for (let i = 0; i < 60; i++) {
    if (await probe()) return child;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('gateway did not come up on port ' + PORT);
}

let gatewayChild = null;

async function createWindow() {
  gatewayChild = await ensureGateway();
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'Agent Session Gateway',
    backgroundColor: '#101418',
    webPreferences: { contextIsolation: true },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  await win.loadURL(URL);
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  // Leave the gateway running when launched externally; kill it when we own it.
  if (gatewayChild) {
    try { gatewayChild.kill(); } catch { /* already gone */ }
  }
  app.quit();
});
