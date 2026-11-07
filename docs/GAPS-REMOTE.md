# Mix 远程控制能力:现状与缺口

- 目标场景:A 电脑的 Codex 原生客户端新建聊天 → 控制电脑 B 上的 Claude Code(会话始终在 B 的原 Runtime 执行)。
- 日期:2026-11-07;依据:exp-01~06 实验与本仓库代码。

## 已实现并实机验证 ✅

| 能力 | 证据 |
|---|---|
| 协议链路:Codex 原生客户端 → 门面 → 驱动 Claude | 真实 `codex resume --remote` 探针:initialize/account/read/**thread/list** 全命中门面(scripts/test-tui-remote.mjs) |
| 在 Codex 客户端继续/驱动 Claude 会话 | thread/resume(claude:\*)+ turn/start 全通知流 + 精确回复(scripts/test-facade.mjs) |
| 审批远程应答 | 审批经网关 WS 广播,任意连接的客户端先答先得(test-e2e/test-claude-deepseek) |
| 会话保持原 Runtime | 门面转发而非伪造迁移 |
| 跨 Agent 统一列表 | claude + codex + opencode 混排(三驱动实机) |

## 缺口清单(按优先级)

### P0 — 跨机可用前必须
1. **绑定地址硬编码 127.0.0.1**:`serveGateway`/`serveFacade` host 默认本地。需 `--host` 参数暴露到 LAN,并保留默认本地的安全默认。
2. **无鉴权**:网关 WS(7688)、门面(7689)、web UI 全部裸奔。暴露网络 = 交出 shell。方案:Bearer token(与 Codex 原生 `--remote-auth-token-env` 对齐)+ web UI 首次配对码;门面校验 Authorization 头。
3. **门面缺 `thread/start` 映射**:现在 A 机 Codex"新建聊天"会落到上游 codex 而非 Claude。需映射到 `gateway.createClaudeSession()`(方法已存在,M2 已验证)。

### P1 — 公网部署(测试服务器 <SERVER_IP>)
4. **WAN 传输无 TLS**:LAN 明文 ws+token 可接受;公网必须 SSH 隧道或 TLS 反代(Caddy/Nginx + wss)。Codex 官方对其 app-server 亦如此建议。
5. **服务器侧部署件**:Node ≥22、claude/codex CLI 安装与登录、驱动依赖、防火墙放行端口、进程常驻(systemd/Windows 服务)。
6. **SSH 凭据**:root@<SERVER_IP>,RSA 私钥 `<SSH_KEY>`(本地 Downloads,**严禁入库**,.gitignore 已排除 *.pem)。

### P2 — 产品化
7. **审批策略固定 interactive**:无配置(自动放行/超时默认动作/审计日志)。
8. **发现层为启动快照**:仅手动 refresh;需文件监听(codex rollout / claude jsonl)自动更新列表。
9. **CLI attach/approve 硬编码 7688**;网关地址应可配置。
10. **openSession 无并发锁**:两客户端同时首次 open 同一会话存在竞态(低概率,单进程内仍需 mutex)。
11. **GUI 打包**:当前为开发态 Electron;需 electron-builder 出安装包 + 自动更新。

## 跨机验证计划(服务器就位后)
1. 本机(B)以 `--host 0.0.0.0 --token` 启动 mix;A 机(或本机以局域网 IP 模拟)`codex resume --remote ws://B:7689 --remote-auth-token-env`。
2. 验证:列表混合可见 → 打开 claude 会话 → prompt → 实时事件回显 → 审批在 web 端应答。
3. 公网:服务器做 TLS 反代 → 重复上述;对照纯 SSH 隧道方案。
