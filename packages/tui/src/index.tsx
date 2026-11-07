#!/usr/bin/env node
// mix-tui — terminal UI over the same gateway WS protocol.
// v0: session list + live transcript + prompt + approval hotkeys (a/d).
// All input flows through Ink's useInput (single source of truth).

import React, { useState, useEffect } from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';
import WebSocket from 'ws';

function App({ url }: { url: string }) {
  const { exit } = useApp();
  const [socket, setSocket] = useState<any>(null);
  const [sessions, setSessions] = useState<any[]>([]);
  const [cursor, setCursor] = useState(0);
  const [currentId, setCurrentId] = useState(null);
  const [lines, setLines] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const [approvals, setApprovals] = useState<any[]>([]);

  useEffect(() => {
    const ws = new WebSocket(url);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'sessions.refresh' })));
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'sessions') setSessions(msg.items);
      else if (msg.type === 'event') {
        const e = msg.event;
        if (e.type === 'message.delta') push(e.text);
        else if (e.type === 'message.completed') push('\n');
        else if (e.type === 'tool.started') push(`\n🔧 ${e.tool}\n`);
        else if (e.type === 'tool.completed') push(e.isError ? ' ⚠error\n' : ' ✓\n');
        else if (e.type === 'turn.completed') push('\n— turn 完成 —\n');
        else if (e.type === 'status' && e.detail) push(`\n[${e.status}] ${e.detail}\n`);
      } else if (msg.type === 'approval.request') {
        setApprovals((a) => [...a, msg.request]);
      } else if (msg.type === 'approval.resolved') {
        setApprovals((a) => a.filter((r) => r.requestId !== msg.requestId));
      } else if (msg.type === 'error') {
        push(`\n⚠ ${msg.message}\n`);
      }
    });
    setSocket(ws);
    return () => ws.close();
  }, [url]);

  const push = (text: string) => setLines((l) => [...l.slice(-300), text]);

  useInput((ch, key) => {
    if (key.escape) return exit();
    if (!currentId) {
      if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
      if (key.downArrow) setCursor((c) => Math.min(sessions.length - 1, c + 1));
      if (key.return && sessions[cursor]) {
        const id = sessions[cursor].gatewayId;
        setCurrentId(id);
        socket.send(JSON.stringify({ type: 'session.open', gatewayId: id }));
      }
      return;
    }
    // approvals first
    if (approvals[0] && (ch === 'a' || ch === 'd')) {
      socket.send(JSON.stringify({
        type: 'approval.resolve',
        requestId: approvals[0].requestId,
        optionId: ch === 'a' ? 'allow_once' : 'deny_once',
      }));
      return;
    }
    if (key.return) {
      if (input.trim()) {
        push(`\n> ${input}\n`);
        socket.send(JSON.stringify({ type: 'session.prompt', gatewayId: currentId, text: input }));
        setInput('');
      }
      return;
    }
    if (key.backspace || key.delete) return setInput((v) => v.slice(0, -1));
    if (key.ctrl && ch === 'c') return exit();
    if (ch && !key.ctrl && !key.meta) setInput((v) => v + ch);
  });

  return (
    <Box flexDirection="column" gap={1}>
      <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
        <Text bold color="cyan">
          Mix — coding agent sessions{currentId ? ` → ${currentId}` : ''} (Esc 退出)
        </Text>
        {!currentId && sessions.slice(0, 14).map((s, i) => (
          <Text key={s.gatewayId} color={i === cursor ? 'black' : undefined} backgroundColor={i === cursor ? 'cyan' : undefined}>
            {` ${s.agent.padEnd(8)} ${String(s.title).slice(0, 58)}`}
          </Text>
        ))}
        {currentId && lines.map((l, i) => <Text key={i}>{l}</Text>)}
      </Box>
      {approvals.map((r) => (
        <Box key={r.requestId} borderStyle="round" borderColor="yellow" paddingX={1}>
          <Text color="yellow">🔐 {r.tool} — [a]允许 / [d]拒绝 {JSON.stringify(r.input).slice(0, 56)}</Text>
        </Box>
      ))}
      {currentId && (
        <Box>
          <Text color="green">{'> '}</Text>
          <Text>{input}</Text>
          <Text color="gray">_(Enter 发送)</Text>
        </Box>
      )}
    </Box>
  );
}

render(<App url={process.argv[2] ?? 'ws://127.0.0.1:7688'} />);
