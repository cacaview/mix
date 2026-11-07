#!/usr/bin/env node
// Mix GUI — Electron shell.
// Three modes:
//   1) dev      — repo checkout found: auto-spawn `mix serve` and load it
//   2) remote   — ASG_URL (env) or saved config: load a remote gateway's UI
//                 (its gate.html handles tokens)
//   3) first run— local landing page asking for the server URL, saved to
//                 <userData>/mix-gui.json
const { spawn } = require('node:child_process');
const { app, BrowserWindow, shell } = require('electron');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const PORT = Number(process.env.ASG_PORT ?? 7688);
const configPath = () => path.join(app.getPath('userData'), 'mix-gui.json');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch { return {}; }
}
function saveConfig(cfg) {
  try { fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 1)); } catch { /* best effort */ }
}

function probe(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => { res.resume(); resolve(res.statusCode === 200 || res.statusCode === 302); });
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => { req.destroy(); resolve(false); });
  });
}

function repoRoot() {
  // Dev checkout: <repo>/packages/gui/src/main.js
  const candidate = path.join(__dirname, '..', '..', '..');
  if (fs.existsSync(path.join(candidate, 'packages', 'cli', 'src', 'index.ts'))) return candidate;
  return null;
}

async function spawnLocalGateway(root, port) {
  const child = spawn('npx', ['tsx', path.join('packages', 'cli', 'src', 'index.ts'), 'serve', '--port', String(port)], {
    cwd: root,
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', (d) => console.log(`[mix-gateway] ${d}`.trimEnd()));
  child.stderr.on('data', (d) => console.error(`[mix-gateway] ${d}`.trimEnd()));
  child.on('exit', (code) => { if (code && code !== 0) console.error(`[mix-gui] gateway exited (${code})`); });
  const url = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 120; i++) {
    if (await probe(url)) return { child, url };
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('local gateway did not come up on port ' + port);
}

async function resolveTarget() {
  // 1) explicit env override
  if (process.env.ASG_URL) return { url: process.env.ASG_URL, child: null };
  // 2) saved remote config
  const cfg = loadConfig();
  if (cfg.serverUrl && await probe(cfg.serverUrl)) return { url: cfg.serverUrl, child: null };
  // 3) dev checkout: spawn local gateway
  const root = repoRoot();
  if (root) {
    if (await probe(`http://127.0.0.1:${PORT}/`)) return { url: `http://127.0.0.1:${PORT}/`, child: null };
    return spawnLocalGateway(root, PORT);
  }
  return null;
}

let gatewayChild = null;

function landingPage(win) {
  const html = `<!doctype html><html><body style="background:#101418;color:#dbe4ee;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
  <div style="background:#171d24;border:1px solid #2a3340;border-radius:12px;padding:32px;width:min(460px,90vw)">
    <h1 style="font-size:18px;margin:0 0 6px">Mix</h1>
    <p style="color:#7d8b9c;font-size:13px;margin:0 0 18px">连接到一台运行 mix serve 的机器(例:http://192.168.1.20:7688 或 https://mix.example.com)</p>
    <input id="u" placeholder="服务器地址" style="width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #2a3340;background:#101418;color:#dbe4ee" />
    <button id="go" style="margin-top:12px;width:100%;padding:10px;border-radius:8px;border:1px solid #4da3ff;background:#24406b;color:#dbe4ee;cursor:pointer">连接</button>
    <div id="err" style="color:#f2555a;font-size:12px;margin-top:10px;min-height:16px"></div>
  </div>
  <script>
    document.getElementById('go').onclick = () => {
      const u = document.getElementById('u').value.trim();
      if (!u) { document.getElementById('err').textContent = '请输入地址'; return; }
      window.location.href = 'http://mix.local/__set_server?target=' + encodeURIComponent(u);
    };
  <\/script></body></html>`;
  win.webContents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  win.webContents.on('will-navigate', (event, url) => {
    const m = /__set_server\?target=(.+)$/.exec(url);
    if (m) {
      event.preventDefault();
      const target = decodeURIComponent(m[1]);
      saveConfig({ serverUrl: target });
      win.loadURL(target).catch(() => {
        saveConfig({});
        win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<h1 style="color:#f2555a">连接失败</h1>'));
      });
    }
  });
}

async function createWindow() {
  const target = await resolveTarget();
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'Mix',
    backgroundColor: '#101418',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  if (!target) landingPage(win);
  else {
    gatewayChild = target.child;
    await win.loadURL(target.url);
  }
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  if (gatewayChild) {
    try { gatewayChild.kill(); } catch { /* already gone */ }
  }
  app.quit();
});
