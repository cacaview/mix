# Mix

**一个控制面,驱动所有 coding agent 会话。** Claude Code、Codex、OpenCode 的原生会话,从任何客户端(gui/web/tui/cli,以及 Codex 原生客户端)打开、观察、接力——会话始终运行在原 Runtime,审批转发给人。

- 调查与可行性依据:`../investigation/`(结论 Conditional Go,全部源码/实测级证据)
- 远程控制缺口与计划:[docs/GAPS-REMOTE.md](docs/GAPS-REMOTE.md)

## 快速开始

```bash
npm install
npm run dev            # 网关 + web UI(7688)+ Codex 门面(7689)
npx tsx packages/cli/src/index.ts ls        # 列出全部 Agent 会话
npm start -w packages/gui                   # 桌面 GUI(自动拉起网关)
npx tsx packages/tui/src/index.tsx          # TUI
codex resume --remote ws://127.0.0.1:7689   # 原生 Codex 客户端接入门面
```

## 架构

```
客户端: gui(Electron) / web / tui(Ink) / cli ──┐
Codex 原生客户端 --remote ──→ 门面(facade)──────┤→ 网关 Gateway
                                                │    ├─ 审批 broker(广播,先答先得)
                                                │    ├─ 驱动: claude(c stream-json)/ codex(app-server)/ opencode(HTTP) / mock
                                                │    └─ 发现: ~/.claude/projects + codex thread/list + opencode /session
```

原则:每会话单驱动=单写者(杜绝并发 resume 分叉);驱动把原生协议归一化为 `SessionEvent` 流;会话永不离开原 Runtime。

## 已实机验证(2026-11-07)

- Claude Code:审批转发 deny/allow(真实模型)、跨进程接力
- Codex:resume + 实时事件;原生 `codex resume --remote` 拉取混合列表
- OpenCode 1.19.5:发现→open→prompt 全链路
- 审批链路 e2e(deny 阻断写文件 / allow 精确产出)

## 测试

```bash
npm run typecheck
npm run test:e2e          # 审批链路(mock)
npm run test:facade       # 门面(需 DEEPSEEK_API_KEY)
npm run test:opencode     # 需本机 opencode serve
```
