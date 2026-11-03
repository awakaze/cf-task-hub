# 百度网盘扫码登录

本文描述截至 2026-11-04 的已实现行为。开源对照过程见 [首轮调研](baidu-login-research.md) 和 [后续排查](baidu-login-followup-research.md)，调研中的维护状态与源码差异以各自记录日期为准。

## 使用与绑定

在百度网盘平台生成二维码，用手机百度或百度网盘 App 扫码并确认。二维码有效期为 3 分钟；刷新登录时重新生成二维码，不复用已消费或失败的票据。更新已有账号必须登录同一个百度账号，原账号 ID、运行记录和平台设置保留。

服务端收齐适用于网盘的 `BDUSS` 和 `STOKEN` 后，还会调用只读身份接口确认真实账号，再原子绑定账号、任务与扫码会话。手机确认登录、拿到临时票据或收到 Cookie 都不单独代表绑定成功。

可改用完整 Cookie 导入；至少需要 `BDUSS` 与网盘可用的 `STOKEN`。`BAIDUCUID` 缺失时会生成设备号。当前百度流程不提供类似 B 站 `refresh_token` 的自动续期，登录失效后需更新 Cookie 或重新扫码。

## 会话、重定向与超时

- `getqrcode`、图片、`unicast` 轮询和 `qrbdusslogin` 交换复用同一 Cookie jar，每一步及每次跳转继续收集 Set-Cookie。
- 会话在 `login_challenges.sign` 中以 `enc:` 标记加密保存，加密附加数据绑定用户和 challenge ID；不把 Cookie jar 返回前端，无需新增百度数据库迁移。
- 申请和轮询保留 Cookie 的 Domain、Path、Secure 与过期属性。轮询取得租约时原子读取最新会话，写回受原租约限制，防止并发请求覆盖新状态。
- 仅请求明确允许的百度 HTTPS 主机，逐跳验证地址，再按目标 URL 重新选择 Cookie。有效 `.baidu.com` 父域 Cookie 可以适用于网盘；passport 专属 STOKEN 和 JSONP `session.stoken` 不直接用作网盘 STOKEN。
- 收齐网盘 Cookie 后立即结束收集，即使当前响应为 302；不再为了打开最终网页继续导航。仍由后续身份验证决定是否绑定。
- 已有 BDUSS 时不再下载回调后的大体积 HTML；仅在缺少 BDUSS 且最终响应仍来自 passport/wappass 时读取有界正文作兼容。
- 单条登录交换跳转链最多 30 秒，整个交换过程最多 45 秒；轮询最多 32 秒，扫码处理租约为 120 秒。这些时限独立于业务任务的接口超时设置。
- 成功或终止失败时清空临时会话；过期记录沿用维护任务清理。升级前创建的短期明文 sign 会话仍可兼容完成。

## 失败提示与诊断

| 原因码 | 含义 |
| --- | --- |
| `BAIDU_QR_CALLBACK_HTTP` | passport 回调返回非成功状态 |
| `BAIDU_QR_BDUSS_MISSING` | 回调没有返回适用于网盘的 BDUSS |
| `BAIDU_QR_STOKEN_MISSING` | 网盘跳转后仍缺少可用 STOKEN |
| `BAIDU_QR_NETDISK_HTTP` | 网盘请求返回非成功状态，且登录态未齐全 |
| `BAIDU_QR_*_TIMEOUT` / `*_NETWORK` | 对应阶段超时或连接失败 |
| `BAIDU_QR_*_RESPONSE` | 响应大小、地址或跳转等校验未通过 |
| `BINDING_FAILED` | Cookie 交换后，身份检查或账号事务未完成 |

终止错误直接停止页面轮询并显示提示，不继续无限重试同一票据。固定错误码保存在扫码会话中；过期会话会清理，因此不能把该表当作长期审计日志。

`BAIDU_QR_DIAGNOSTICS` 当前为 `false`，临时日志持久化也已关闭。需要排查时可暂时打开开关并使用实时日志，若需历史检索再单独启用 Workers 日志存储。结构化日志前缀为 `[baidu-qr-debug]`，仅记录阶段、跳数、白名单主机、耗时、状态码、数字错误码及已知 Cookie 的名称/域/长度/可用性。不记录 Cookie 值、sign、临时票据、完整 URL 或响应正文，排查后应关闭。

## 已验证范围

已完成真实账号扫码绑定，并通过一次业务运行确认身份、签到和奖励接口可用。已复现并修正 Cookie 会话丢失、父域 Cookie 被误拒绝、回调 HTML 超限、Cookie 已齐仍继续跳转，以及中转延迟触发旧超时限制等问题。

真实上游返回和出口环境仍可能变化。本次验证不保证所有账号均能收到 STOKEN，也没有把开放平台 OAuth token 当作网页 Cookie。
