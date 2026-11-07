// Server: one HTTP port serving both the WebSocket protocol and the built-in
// web UI (static, zero build step). Every client surface (web/tui/cli/gui)
// speaks the same WS protocol — see message catalogue below.
//
// client → server:
//   { type: 'sessions.list' | 'sessions.refresh' }
//   { type: 'session.open', gatewayId }
//   { type: 'session.prompt', gatewayId, text }
//   { type: 'session.interrupt', gatewayId }
//   { type: 'approval.list' }
//   { type: 'approval.resolve', requestId, optionId }
//   { type: 'session.mock.create', title? }
// server → client:
//   { type: 'sessions', items } | { type: 'event', gatewayId, event }
//   { type: 'approval.request', request } | { type: 'approval.snapshot'|'approval.resolved', ... }
//   { type: 'session.opened', session } | { type: 'error', message }

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import type { Gateway } from './gateway.ts';
import type { SessionRef } from './types.ts';

export interface WsGatewayOptions {
  port: number;
  host?: string;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(webRoot: string, req: IncomingMessage, res: ServerResponse): void {
  const urlPath = (req.url ?? '/').split('?')[0];
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  const abs = path.join(webRoot, rel);
  const target = existsSync(abs) && statSync(abs).isFile() ? abs : path.join(webRoot, 'index.html');
  const ext = path.extname(target);
  res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream' });
  createReadStream(target).pipe(res);
}

export function serveGateway(gateway: Gateway, opts: WsGatewayOptions): { close(): Promise<void>; port: number } {
  const webRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'public');
  const httpServer = createServer((req, res) => serveStatic(webRoot, req, res));
  const wss = new WebSocketServer({ server: httpServer });
  const clients = new Set<WebSocket>();

  const broadcast = (msg: unknown) => {
    const data = JSON.stringify(msg);
    for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(data);
  };

  gateway.on('event', (gatewayId, event) => broadcast({ type: 'event', gatewayId, event }));
  gateway.on('approval', (request) => broadcast({ type: 'approval.request', request }));
  gateway.on('sessionsChanged', () => broadcast({ type: 'sessions', items: gateway.listSessions() }));

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.send(JSON.stringify({ type: 'sessions', items: gateway.listSessions() }));
    ws.send(JSON.stringify({ type: 'approval.snapshot', requests: gateway.listApprovals() }));
    ws.on('message', async (raw) => {
      let msg: any;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      try {
        switch (msg.type) {
          case 'sessions.list':
            ws.send(JSON.stringify({ type: 'sessions', items: gateway.listSessions() }));
            break;
          case 'sessions.refresh':
            await gateway.refreshSessions();
            break;
          case 'session.open': {
            const ref = await gateway.openSession(msg.gatewayId);
            ws.send(JSON.stringify({ type: 'session.opened', session: ref }));
            break;
          }
          case 'session.prompt':
            await gateway.prompt(msg.gatewayId, msg.text);
            break;
          case 'session.interrupt':
            await gateway.interrupt(msg.gatewayId);
            break;
          case 'approval.list':
            ws.send(JSON.stringify({ type: 'approval.snapshot', requests: gateway.listApprovals() }));
            break;
          case 'approval.resolve':
            gateway.resolveApproval({ requestId: msg.requestId, optionId: msg.optionId });
            broadcast({ type: 'approval.resolved', requestId: msg.requestId });
            break;
          case 'session.create': {
            // New live session (currently claude); cwd comes from the client.
            const ref = await gateway.createClaudeSession(msg.cwd ?? process.cwd(), msg.title);
            ws.send(JSON.stringify({ type: 'session.opened', session: ref }));
            break;
          }
          case 'session.mock.create': {
            const id = `mock:${randomUUID()}`;
            gateway.upsertSession({
              gatewayId: id, agent: 'mock', nativeId: id.slice(5),
              title: msg.title ?? 'Mock session', cwd: process.cwd(),
              updatedAtMs: Date.now(), active: false,
            });
            break;
          }
          default:
            ws.send(JSON.stringify({ type: 'error', message: `unknown message type: ${msg.type}` }));
        }
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', message: err instanceof Error ? err.message : String(err) }));
      }
    });
    ws.on('close', () => clients.delete(ws));
  });

  const result = {
    port: opts.port,
    close: () => new Promise<void>((done) => {
      wss.close();
      httpServer.close(() => done());
    }),
  };
  httpServer.listen(opts.port, opts.host ?? '127.0.0.1');
  return result;
}

export type { SessionRef };
