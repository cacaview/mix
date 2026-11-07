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

## 二轮推进(2026-11-07 晚,已完成)

- ✅ **审批策略配置化**:`serve --approval-policy interactive|allow|deny --approval-timeout-ms N`(scripts/test-approval-policy.mjs PASS)
- ✅ **发现层自动刷新**:serve 监听 claude/codex 会话存储(800ms 去抖),--no-watch 关闭
- ✅ **openSession 并发锁**:同会话首次 open 合并为单飞
- ✅ **systemd 常驻**:deploy/mix.service + /opt/mix.env(token 600);服务器 systemctl enable --now,跨机回归 PASS

## 剩余缺口(更新)

### P1 — 公网直连
1. **TLS**:当前依赖 SSH 隧道;裸 IP 无 LE 证书,需域名 + TLS 反代(Caddy → wss),后端保持 loopback+token。
2. **服务器 codex 上游**:未装(降级模式正常);如需服务器上原生 codex 会话,`npm i -g @openai/codex` + 登录即可。

### P2 — 产品化(2026-11-07 三轮)

- ✅ **web 静态层鉴权**:配置 token 后 HTTP 层同样受保护(gate.html + cookie;curl 实测 302→gate→进入)
- ✅ **通用 ACP 驱动**(packages/core/src/agents/acp.ts):任意 ACP v1 stdio Agent 一键接入 —— Gemini CLI(--experimental-acp)、Qwen Code、Pi/OMP、Claude(官方 claude-agent-acp 适配器实测);**ACP Agent 审批转发**(session/request_permission → broker)实机 PASS(deny 阻断写入)
- ✅ GUI 三形态:dev 自拉起 / 远程客户端(ASG_URL 或保存配置)/ 首次连接页;electron-builder 配置就绪
- ⏳ GUI 安装包产出(nsis)进行中
- ⏳ 其余 Agent 驱动按 docs/03 清单扩展(ACP 驱动已覆盖其中 ACP 生态成员)
