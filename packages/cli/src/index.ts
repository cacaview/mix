#!/usr/bin/env node
// mix — CLI surface of the Mix.
//   mix serve            start the gateway (WS + web UI)
//   mix ls               list discovered sessions
//   mix attach <id>      attach a TTY chat to a session (read + prompt)
//   mix approve          list pending approvals; `mix approve <req> allow|deny`

import { Command } from 'commander';
import { Gateway, serveGateway } from '@mix/core';
import open from 'node:child_process';

const program = new Command();

function gatewayUrl(opts: { url?: string; token?: string }): string {
  const base = opts.url ?? 'ws://127.0.0.1:7688';
  return opts.token ? `${base}?token=${encodeURIComponent(opts.token)}` : base;
}

program.name('mix').description('Mix — one control plane for coding agent sessions').version('0.1.0');

program
  .command('serve')
  .description('Start the gateway server (WebSocket + built-in web UI)')
  .option('-p, --port <port>', 'port to listen on', '7688')
  .option('--host <host>', 'bind address (default 127.0.0.1; 0.0.0.0 for LAN/public)', '127.0.0.1')
  .option('--token <token>', 'bearer token required by remote clients')
  .option('--token-env <var>', 'read the bearer token from this environment variable')
  .option('--open', 'open the web UI in the default browser')
  .action(async (opts) => {
    const { isLoopbackHost } = await import('@mix/core');
    const token = opts.tokenEnv ? process.env[opts.tokenEnv] : opts.token;
    if (!isLoopbackHost(opts.host) && !token) {
      console.error('refusing to bind a non-loopback address without --token/--token-env');
      process.exit(1);
    }
    const gateway = new Gateway();
    console.log('discovering sessions…');
    const sessions = await gateway.refreshSessions();
    console.log(`  ${sessions.length} sessions indexed`);
    const { serveGateway, serveFacade } = await import('@mix/core');
    const server = serveGateway(gateway, { port: Number(opts.port), host: opts.host, token });
    const facadePort = Number(opts.port) + 1;
    const facade = serveFacade(gateway, { port: facadePort, host: opts.host, token });
    const displayHost = isLoopbackHost(opts.host) ? '127.0.0.1' : opts.host;
    console.log(`gateway listening on ws://${displayHost}:${server.port}${token ? ' (token required)' : ''}`);
    console.log(`web UI:          http://${displayHost}:${server.port}/`);
    console.log(`codex facade:    ws://${displayHost}:${facade.port}  (codex --remote target)`);
    if (opts.open) {
      const url = `http://127.0.0.1:${server.port}/`;
      if (process.platform === 'win32') open.exec(`start ${url}`);
      else open.exec(`xdg-open ${url}`);
    }
    const shutdown = async () => {
      console.log('\nshutting down…');
      await server.close();
      await facade.close();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
  });

program
  .command('ls')
  .description('List discovered sessions across all supported agents')
  .action(async () => {
    const gateway = new Gateway();
    const sessions = await gateway.refreshSessions();
    for (const s of sessions) {
      const flag = s.active ? '*' : ' ';
      console.log(`${flag} ${s.gatewayId.padEnd(50)} ${String(s.updatedAtMs).padEnd(16)} ${s.title}`);
    }
    console.log(`\n${sessions.length} sessions`);
  });

program
  .command('approve')
  .description('Resolve pending approvals')
  .argument('[requestId]', 'approval request id')
  .argument('[decision]', 'allow | deny')
  .option('-u, --url <url>', 'gateway URL', 'ws://127.0.0.1:7688')
  .option('-t, --token <token>', 'bearer token')
  .action(async (requestId, decision, opts) => {
    // CLI approval resolution goes through the same broker via a temporary connection.
    const { WebSocket } = await import('ws');
    const ws = new WebSocket(gatewayUrl(opts));
    ws.on('open', () => {
      if (requestId && decision) {
        const optionId = decision === 'allow' ? 'allow_once' : 'deny_once';
        ws.send(JSON.stringify({ type: 'approval.resolve', requestId, optionId }));
        console.log(`resolved ${requestId} -> ${optionId}`);
        setTimeout(() => process.exit(0), 500);
      } else {
        ws.send(JSON.stringify({ type: 'approval.list' }));
      }
    });
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'approval.snapshot') {
        for (const r of msg.requests) {
          console.log(`${r.requestId}  ${r.sessionId}  ${r.tool}  ${JSON.stringify(r.input).slice(0, 120)}`);
        }
        if (!msg.requests.length) console.log('(no pending approvals)');
        setTimeout(() => process.exit(0), 300);
      }
    });
  });

program
  .command('attach')
  .description('Attach to a session (live events + prompt from stdin)')
  .argument('<gatewayId>')
  .option('-u, --url <url>', 'gateway URL', 'ws://127.0.0.1:7688')
  .option('-t, --token <token>', 'bearer token')
  .action(async (gatewayId, opts) => {
    const { WebSocket } = await import('ws');
    const ws = new WebSocket(gatewayUrl(opts));
    const readline = await import('node:readline');
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'session.open', gatewayId }));
      process.stderr.write(`attached to ${gatewayId}; type a prompt, Ctrl-C to detach\n`);
    });
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'event' && msg.gatewayId === gatewayId) {
        const e = msg.event;
        if (e.type === 'message.delta') process.stdout.write(e.text);
        else if (e.type === 'message.completed') process.stdout.write((e.text ?? '') + '\n');
        else if (e.type === 'reasoning.delta') process.stderr.write(`[think] ${e.text}`);
        else if (e.type === 'tool.started') process.stderr.write(`\n[tool] ${e.tool}\n`);
        else if (e.type === 'tool.completed') process.stderr.write(`[tool done${e.isError ? ' (error)' : ''}]\n`);
        else if (e.type === 'turn.completed') process.stderr.write('\n[turn complete]\n');
        else if (e.type === 'status' && e.detail) process.stderr.write(`[status] ${e.detail}\n`);
      } else if (msg.type === 'approval.request') {
        process.stderr.write(`\n[APPROVAL] ${msg.request.tool} ${JSON.stringify(msg.request.input).slice(0, 200)}\n  run: mix approve ${msg.request.requestId} allow|deny\n`);
      } else if (msg.type === 'error') {
        process.stderr.write(`[error] ${msg.message}\n`);
      }
    });
    rl.on('line', (line) => {
      const text = line.trim();
      if (text) ws.send(JSON.stringify({ type: 'session.prompt', gatewayId, text }));
    });
    rl.on('close', () => process.exit(0));
  });

program.parseAsync();
