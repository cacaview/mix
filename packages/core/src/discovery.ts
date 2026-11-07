// Session discovery: scan native session stores into a unified index.
//
// Evidence base (investigation):
// - Claude: ~/.claude/projects/<munged-cwd>/<session-id>.jsonl (exp04 — file
//   created even when API fails; JSONL typed records with parentUuid chain).
// - Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl + session_index.jsonl
//   (exp02 — thread/list scans these; entry.path field proves the layout).

import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { SessionRef } from './types.ts';

async function readFirstLines(file: string, n: number): Promise<string[]> {
  const handle = await import('node:fs/promises').then((fs) => fs.open(file, 'r'));
  try {
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).toString('utf8').split('\n').slice(0, n);
  } finally {
    await handle.close();
  }
}

/** Claude Code sessions: newest jsonl per directory under ~/.claude/projects. */
export async function discoverClaudeSessions(limitPerDir = 50): Promise<SessionRef[]> {
  const root = path.join(homedir(), '.claude', 'projects');
  const out: SessionRef[] = [];
  let dirs: string[];
  try {
    dirs = await readdir(root);
  } catch {
    return out;
  }
  for (const dir of dirs) {
    const abs = path.join(root, dir);
    let files: string[];
    try {
      files = (await readdir(abs)).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    const withMtime = await Promise.all(
      files.map(async (f) => {
        const full = path.join(abs, f);
        try {
          return { full, mtime: (await stat(full)).mtimeMs };
        } catch {
          return null;
        }
      }),
    );
    const valid = withMtime.filter((x): x is { full: string; mtime: number } => x !== null);
    valid.sort((a, b) => b.mtime - a.mtime);
    for (const { full, mtime } of valid.slice(0, limitPerDir)) {
      const sessionId = path.basename(full, '.jsonl');
      let title = sessionId;
      let cwd = dir;
      try {
        const lines = await readFirstLines(full, 12);
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const rec = JSON.parse(line);
            if (rec.cwd) cwd = rec.cwd;
            if (rec.type === 'user' && typeof rec.message?.content === 'string') {
              title = rec.message.content.slice(0, 80);
              break;
            }
            if (rec.type === 'user' && Array.isArray(rec.message?.content)) {
              const text = rec.message.content.find((c: any) => c.type === 'text')?.text;
              if (text) {
                title = String(text).slice(0, 80);
                break;
              }
            }
          } catch {
            /* skip */
          }
        }
      } catch {
        /* keep defaults */
      }
      out.push({
        gatewayId: `claude:${sessionId}`,
        agent: 'claude',
        nativeId: sessionId,
        title,
        cwd,
        updatedAtMs: mtime,
        active: false,
      });
    }
  }
  out.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  return out;
}

/** Codex sessions via `codex app-server` thread/list (spawn one-shot). */
export async function discoverCodexSessions(codexPath = 'codex'): Promise<SessionRef[]> {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    const child = spawn(codexPath, ['app-server'], { shell: process.platform === 'win32', stdio: ['pipe', 'pipe', 'ignore'] });
    const out: SessionRef[] = [];
    let buf = '';
    const finish = () => {
      try { child.kill(); } catch { /* ignore */ }
      resolve(out);
    };
    const timer = setTimeout(finish, 15_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1 && msg.result) {
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'thread/list', params: {} }) + '\n');
        } else if (msg.id === 2 && msg.result) {
          for (const t of msg.result.data ?? []) {
            out.push({
              gatewayId: `codex:${t.id}`,
              agent: 'codex',
              nativeId: t.id,
              title: t.name || t.preview?.slice(0, 80) || t.id,
              cwd: t.cwd ?? '',
              updatedAtMs: (t.updatedAt ?? 0) * 1000,
              active: t.status?.type === 'active',
              externallyOwned: t.status?.type === 'active',
            });
          }
          clearTimeout(timer);
          finish();
        } else if (msg.id === 1 && msg.error) {
          clearTimeout(timer);
          finish();
        }
      }
    });
    child.on('error', () => { clearTimeout(timer); finish(); });
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { clientInfo: { name: 'mix', title: 'ASG', version: '0.1.0' } },
    }) + '\n');
  });
}
