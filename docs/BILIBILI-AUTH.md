# B 站登录与自动续期

## 使用

在 B 站平台的账号设置中生成二维码，用哔哩哔哩 App 扫码并确认。上游同时返回 Web `refresh_token` 时保存它与 Cookie，并显示“自动续期已开启”；只返回 Cookie 时仍可绑定，但不会启用自动续期。更新已有账号时，必须扫描同一个 B 站账号；运行记录、平台设置和原账号 ID 均保留。

旧的 Cookie 账号继续工作，但仅有 Cookie 无法自动续期。可以扫码更新，也可以手动同时导入同一次登录的 Cookie 和本地存储 `ac_time_value`（API 字段名为 `refresh_token`）。更换 Cookie 时未填写续期凭据，会关闭该账号的自动续期，防止继续使用不匹配的旧令牌。仅改别名、暂停或恢复时会保留原凭据。

系统每 24 小时检查一次是否需要续期；任务执行前也会处理到期检查。没有必要刷新时不会轮换 Cookie。暂时的网络/风控问题退避 15 分钟；确认失败保留新凭据，最多尝试三次确认。硬失效、凭据不匹配、刷新结果未知或无法恢复确认时暂停账号和计划，并按已有异常通知设置发送重新扫码提示。未配置异常通知渠道时，只在面板和运行记录中提示。

账号主动暂停、用户冻结、模块关闭、维护模式或后台暂停时，不发起新的自动续期请求。已发出的请求仍可能由上游完成。只读探测和交易复核不主动刷新 Cookie。

## 部署

新增迁移 `0009_bilibili_sessions.sql`，数据库版本升为 9；不会改写旧账号的加密凭据。沿用 `DATA_KEY`、D1、ACCOUNTS Durable Object、现有 Queue 和五分钟 Cron，无新增密钥或外部服务。

执行 `npm run deploy` 完成检查、远端迁移和发布。升级后数据库版本必须为 9，`/api/v1/auth/setup-status` 应返回 `ready: true`；`/health` 仅检查 HTTP 可响应。迁移已在现有部署应用；扫码与续期可以复用可选 Google relay，启用方法见 [中转说明](GOOGLE-RELAY-zh-CN.md)。

## 实现与恢复

- `src/core/bilibili-auth.ts` 仅请求固定的 B 站登录端点；扫码二维码在服务端本地生成，不把登录地址交给第三方二维码服务。不跟随上游重定向，不访问带有凭据的 crossDomain URL。
- 多个 Set-Cookie 独立处理，仅接收 `.bilibili.com` 根路径的已知会话字段，支持原生 Workers 与 relay 重建响应。
- `src/core/bilibili-sessions.ts` 通过现有账号 DO 与业务任务串行执行；D1 租约和密文版本比较同时防止公开账号修改接口覆盖后台轮换。
- Cookie、刷新令牌和待确认旧令牌全部放在原有 AES-GCM 加密的 `credentials_enc` 中；`bili_sessions` 仅存公开状态、时间和协调租约。API 不回显登录凭据。
- POST 刷新前持久化 `refreshing` 状态，成功后先保存新 Cookie、新令牌及 `confirming` 状态，校验真实 UID，再使用新 Cookie 和旧令牌确认。刷新 POST 超时或响应丢失后不重发；进程重启也不重发。确认失败可以从新凭据恢复，不重放领取或兑换。
- 待续期账号通过维护任务分批入队；维护检查失败的登录失效事件复用现有通知策略，不消耗业务运行额度。任务内发现失效时使用该任务自己的异常事件，避免双重通知。

## 参考与验证范围

2026-11-03 实测发现二维码生成接口已返回 `https://account.bilibili.com/h5/account-h5/auth/scan-web`，原来的 `https://passport.bilibili.com/h5-app/passport/login/scan` 校验会误拒绝成功响应。本项目现同时允许这两组精确域名和路径，继续检查 HTTPS、无用户信息、无额外端口以及二维码密钥匹配；不放开任意 B 站子域或任意页面。直连与现有 Google relay 均已实测生成二维码并轮询到未扫码状态，扫码确认和续期仍需真实账号完成验证。

同时对照了 [BiliBiliToolPro 的扫码接口](https://github.com/RayWangQvQ/BiliBiliToolPro/blob/main/src/Ray.BiliBiliTool.Agent/BiliBiliAgent/Interfaces/IPassportApi.cs) 与 [Cookie 收集流程](https://github.com/RayWangQvQ/BiliBiliToolPro/blob/main/src/Ray.BiliBiliTool.DomainService/LoginDomainService.cs)。本次修复针对过窄的地址校验，不更换已有刷新协议，也不增加未经证明必要的指纹注册。

参考仓库已拉取至本地忽略目录 `.wrangler/references/BiliStalkerMCP`，固定提交 `952fd83b9089b3f1b5bfde730b968fe63e3eb6df`。本项目用 TypeScript 独立接入 Workers，参考其“先保存后确认”和中断恢复设计；未引入 Python SDK 或运行其代码。许可见 [LICENSE-BiliStalkerMCP.txt](LICENSE-BiliStalkerMCP.txt)。

- [参考续期实现](https://github.com/222wcnm/BiliStalkerMCP/blob/952fd83b9089b3f1b5bfde730b968fe63e3eb6df/bili_stalker_mcp/cookie_refresh.py)
- [社区 Web Cookie 刷新协议](https://github.com/bilibili-plugins/bilibili-api-collect/blob/master/docs/login/cookie_refresh.md)
- [社区 Web 二维码登录协议](https://github.com/bilibili-plugins/bilibili-api-collect/blob/master/docs/login/login_action/QR.md)

本地测试覆盖扫码状态、URL/Cookie 域隔离、凭据不回显、同 UID 校验、并发任务、手动更新冲突、刷新响应丢失、落库失败、确认中断恢复和调度暂停。测试使用合成凭据，不代表已通过真实账号端到端验证。真实验证需要首次扫码，并在上游要求刷新时观察实际轮换；不能仅凭“无需刷新”的响应宣称续期已成功。
