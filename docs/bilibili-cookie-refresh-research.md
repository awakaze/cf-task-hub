# B 站 Cookie 自动续期方案调研

调研快照：2026-11-03（北京时间）。本文保留实施前的选型比较，维护状态以调研当日为准。方案现已接入并部署；当前使用、迁移、恢复和真实验证范围见 [B 站登录与自动续期](BILIBILI-AUTH.md)。

## 建议

为现有 Workers 增加 **Web 扫码登录 + refresh_token 按需轮换 + 失效通知重新扫码**。保留 Cookie 手动导入，同时允许导入同一次登录对应的 `ac_time_value`。直接参考 BiliStalkerMCP 的续期状态机，结合 API collect 的协议说明，用当前 TypeScript / Durable Object / D1 实现；不必整体迁入 Python、.NET 或 Rust 项目。

## 项目维护状态与用途

以下日期来自 GitHub 公共 API 的默认分支最新实际提交，采用 UTC；发布日单独列出，未把 `pushed_at` 当成代码维护日期。

| 项目 | 查到的状态 | 本项目可参考部分 |
| --- | --- | --- |
| [222wcnm/BiliStalkerMCP](https://github.com/222wcnm/BiliStalkerMCP) | 未归档；[最近提交 2026-10-10](https://github.com/222wcnm/BiliStalkerMCP/commit/952fd83b9089b3f1b5bfde730b968fe63e3eb6df) | **首选实现参考**：确有 Web Cookie 续期、并发锁、先持久化后确认、待确认恢复及相关测试。Python MCP 服务本身无需部署。 |
| [RayWangQvQ/BiliBiliToolPro](https://github.com/RayWangQvQ/BiliBiliToolPro) | 未归档；[最近提交 2026-10-18](https://github.com/RayWangQvQ/BiliBiliToolPro/commit/401698e88abedd1ff16ac0e5833b78369d29c631)；[4.2.3 发布于 2026-10-17](https://github.com/RayWangQvQ/BiliBiliToolPro/releases/tag/4.2.3) | 参考扫码、Cookie 保存和任务管理；已检查的登录服务主要是扫码及首页 Cookie 合并，不能据 README 的 cookie updates 声称其实现 Web refresh_token 轮换。 |
| [biliup/biliup](https://github.com/biliup/biliup) | 未归档；[最近提交 2026-10-27](https://github.com/biliup/biliup/commit/c2a8f4165224c03d6dcaeb44c4acca52fa76959a)；[v1.3.4 发布于 2026-10-22](https://github.com/biliup/biliup/releases/tag/v1.3.4) | 仍维护，但偏录制投稿；其续期使用 Android/TV OAuth 凭据及 `/oauth2/refresh_token`，不能直接套用到仅导入 Web Cookie 的账号。 |
| [bilibili-plugins/bilibili-api-collect](https://github.com/bilibili-plugins/bilibili-api-collect) | 未归档；[最近提交 2026-01-22](https://github.com/bilibili-plugins/bilibili-api-collect/commit/cfc5fddcc8a94b74d91970bb5b4eaeb349addc47) | 协议资料，较久未更新；不作为近期持续维护的运行库。原 SocialSisterYi 仓库已归档；Nemo2011/bilibili-api 也已归档。 |

维护状态复核 API：[BiliStalkerMCP](https://api.github.com/repos/222wcnm/BiliStalkerMCP)、[BiliBiliToolPro](https://api.github.com/repos/RayWangQvQ/BiliBiliToolPro)、[biliup](https://api.github.com/repos/biliup/biliup)、[API collect 接续仓库](https://api.github.com/repos/bilibili-plugins/bilibili-api-collect)、[API collect 原仓库](https://api.github.com/repos/SocialSisterYi/bilibili-API-collect)、[Nemo2011/bilibili-api](https://api.github.com/repos/Nemo2011/bilibili-api)。未归档和最近提交只是维护迹象，不保证接口实际成功率。

## 续期需要的凭据和步骤

`refresh_token` 对应浏览器 localStorage 的 `ac_time_value`，不是 Cookie 字段；仅有 `SESSDATA`、`bili_jct` 不足以完成此 Web 刷新流程。初次扫码成功后应同时保存 Cookie 与刷新口令；旧账号可重新扫码建立独立登录会话，避免与日常浏览器同时轮换同一份凭据。

每天或首个任务前检查 `cookie/info`，仅在需要时刷新：生成 RSA-OAEP SHA-256 的 correspondPath，从 `/correspond/1/{correspondPath}` 取 refresh_csrf，再调用 `cookie/refresh`；接收新的多个 Set-Cookie 和新 refresh_token，可靠保存后用 **新 Cookie + 旧 refresh_token** 调 `confirm/refresh`。确认会使旧登录凭据失效。[协议来源](https://github.com/bilibili-plugins/bilibili-api-collect/blob/master/docs/login/cookie_refresh.md)、[Web 扫码协议](https://github.com/bilibili-plugins/bilibili-api-collect/blob/master/docs/login/login_action/QR.md)。

直接实现证据：[BiliStalkerMCP cookie_refresh.py](https://github.com/222wcnm/BiliStalkerMCP/blob/952fd83b9089b3f1b5bfde730b968fe63e3eb6df/bili_stalker_mcp/cookie_refresh.py) 包含四个端点、协调锁、落盘后确认和 pending 恢复；[credentials.py](https://github.com/222wcnm/BiliStalkerMCP/blob/952fd83b9089b3f1b5bfde730b968fe63e3eb6df/bili_stalker_mcp/credentials.py) 处理持久化；[测试](https://github.com/222wcnm/BiliStalkerMCP/blob/952fd83b9089b3f1b5bfde730b968fe63e3eb6df/tests/test_cookie_refresh.py) 可供设计验收场景。

检索结果中出现过 `/cookie/refresh/csrf` 替代说法，但本次直接读取的 API collect 源文档及上述实际实现均仍采用 correspond 路径，未找到足够一手证据支持替换，不纳入方案。

补充源码：[BiliBiliToolPro 登录服务](https://github.com/RayWangQvQ/BiliBiliToolPro/blob/401698e88abedd1ff16ac0e5833b78369d29c631/src/Ray.BiliBiliTool.DomainService/LoginDomainService.cs)、[biliup 凭据及 OAuth 续期](https://github.com/biliup/biliup/blob/c2a8f4165224c03d6dcaeb44c4acca52fa76959a/crates/biliup/src/uploader/credential.rs)。

## 与当前项目衔接

根据本次本地代码核对，`src/api/platforms.ts` 与 `src/api/user.ts` 的凭据输入目前只有 Cookie/CUID/headers，B 站未实现扫码；`AccountCoordinator` 已按平台 UID 协调任务，任务前身份检查会在确认未登录时暂停账号与任务，已有凭据加密存储。这些结构可继续使用。

建议新增 B 站独立扫码会话；在现有加密凭据结构中加入 refresh_token、版本与 pending confirmation 状态。复用同账号协调器处理任务、手动导入和续期，持锁后重新读取当前版本，避免并发覆盖。先加密持久化新 Cookie、新 token、旧 token 的待确认状态，再确认旧凭据；重启后恢复确认。刷新请求响应未知时不能盲目重发，也不能因此重放兑换等业务动作。

Workers 原生 [Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/) 支持所需 RSA-OAEP；读取多 Cookie 应按 [Headers 文档](https://developers.cloudflare.com/workers/runtime-apis/headers/) 保留全部 Set-Cookie。不要以 KV 充当轮换锁，其[最终一致性不适合原子协调](https://developers.cloudflare.com/kv/concepts/how-kv-works/)。采用现有 DO/D1 是本地工程建议，不代表已完成或已验证。

## 采用边界和上线前验收

- 自动续期需要有效且匹配的登录态及刷新口令；退出登录、改密、硬过期或风控强制下线不能承诺自动恢复，应通知重新扫码。网络错误、`-412` 等风控和 `-101` 登录失效分别处理，退避重试只适用于明确安全的检查。
- 先验收纯 Workers 的扫码、info、correspond 与刷新链路；如使用已有 Google relay，必须实测它完整保留多 Set-Cookie，并保持同一登录流程的网络出口一致。源码存在 header 透传不等于生产已验证。
- 需覆盖新 token 落库失败、confirm 失败/超时、重启恢复、并发任务与手动换 Cookie、错配 token、风控响应等场景。BiliStalkerMCP 的单机文件锁不能原样替代 Workers 的跨请求协调。
- 不选定时访问首页作为主续期方案：存活探测及设备 Cookie 合并不能代替 Web refresh_token 轮换。浏览器 Cookie 同步可作手动补充，会增加本地常驻组件和同会话冲突；独立服务器部署 BiliTool/biliup 也增加现有需求之外的运维。

本次结论来自开源源码和 Cloudflare 官方能力文档；B 站协议资料属于社区逆向说明，并非稳定公开 API 的官方承诺。最终是否可用应以用户实际 Cloudflare 出口和账号的端到端验证为准。
