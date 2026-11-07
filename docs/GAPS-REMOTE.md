# Mix 远程控制能力:现状与缺口

- 目标场景:A 电脑的 Codex 原生客户端新建聊天 → 控制电脑 B 上的 Claude Code(会话始终在 B 的原 Runtime 执行)。
- 更新:2026-11-07(第二轮)。依据:exp-01~06 + test-thread-start / test-remote / test-tui-remote 实测。

## 已实现并实机验证 ✅

| 能力 | 证据 |
|---|---|
| 协议链路:Codex 原生客户端 → 门面 → 驱动 Claude | 真实 `codex resume --remote` 探针:initialize/account/read/**thread/list** 全命中门面(scripts/test-tui-remote.mjs) |
| 在 Codex 客户端**新建聊天** → Claude 会话 | 门面 `thread/start` → `gateway.createClaudeSession()`;回复 "REMOTE-NEW-OK"(scripts/test-thread-start.mjs) |
| 在 Codex 客户端继续/驱动 Claude 会话 | thread/resume(claude:\*)+ turn/start 全通知流 + 精确回复(scripts/test-facade.mjs) |
| **Bearer token 鉴权** | 无 token 握手被拒(401);带 token Accept(cli/e2e 验证;`Authorization: Bearer` 与 `?token=` 双通道,兼容 codex `--remote-auth-token-env`) |
| **跨机控制(云服务器)** | 本机 → SSH 隧道 → <SERVER_IP> 门面 → 服务器 claude 执行 → "CROSS-MACHINE-OK" 回传(scripts/test-remote.mjs);原生 TUI 经隧道 initialize/thread/list 命中服务器日志 |
| 审批远程应答 | 审批经网关 WS 广播,任意连接的客户端先答先得(test-e2e/test-claude-deepseek) |
| 会话保持原 Runtime | 门面转发而非伪造迁移 |
| 无 codex 环境优雅降级 | 服务器无 codex:门面仅服务 gateway 托管线程,不崩溃(2026-11-07 修复) |

## 测试服务器部署档案(<SERVER_IP>,Debian 13)

- Node 22.14.0(`/opt/node-v22.14.0-linux-x64`,软链 /usr/local/bin)npm=npmmirror
- 仓库:/opt/mix(git bundle 传输,HEAD=571149b);claude CLI 2.1.319(DeepSeek env 于 /root/.claude/settings.json)
- 工作区:/opt/mix-workspace;首会话 SID <SESSION_ID>
- 启动:`cd /opt/mix && ASG_TOKEN=<TEST_TOKEN> setsid nohup npx tsx packages/cli/src/index.ts serve --port 7688 --host 127.0.0.1 --token $ASG_TOKEN > mix.log 2>&1 < /dev/null &`
- 访问(本机):`ssh -i <SSH_KEY> -N -L 17689:127.0.0.1:7689 -L 17688:127.0.0.1:7688 root@<SERVER_IP>`
- 本机验证:`codex resume --remote ws://127.0.0.1:17689 --remote-auth-token-env`(token 见上)

## P0 缺口处置(2026-11-07 全部关闭)

1. ~~绑定地址硬编码~~ → `mix serve --host`(非回环拒绝无 token 启动)
2. ~~无鉴权~~ → auth.ts 门(网关+门面),web 端 401 后弹 token 输入重连
3. ~~thread/start 未映射~~ → 新建聊天=新建 Claude 会话

## 剩余缺口(更新)

### P1 — 公网直连
1. **TLS**:当前依赖 SSH 隧道;公网裸端口方案需 TLS 反代(Caddy/Nginx → wss)后端仍 loopback+token。
2. **服务器 codex 上游**:未装(降级模式正常);如需服务器上原生 codex 会话,`npm i -g @openai/codex` + 登录即可。
3. **进程常驻**:服务器用 setsid+nohup;建议 systemd unit(自动重启/开机自启)。

### P2 — 产品化
4. 审批策略配置化(interactive/allow/deny + 超时)。
5. 发现层文件监听自动刷新;openSession 并发锁;GUI 打包(electron-builder)。
6. 远程客户端跨平台分发(codex 之外,web UI 已可远程打开 `http://B:7688?token=…` 但 HTTP 静态层未鉴权,仅 WS 层鉴权 —— 公网部署时须反代整站加防护)。
