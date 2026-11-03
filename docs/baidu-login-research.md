# 百度网盘扫码登录参考核对

调研快照日期：2026-11-03。本文前半部分保留当时修改前的源码对照，提交日期采用 GitHub API 返回的 UTC；不是当前实现说明。现行流程与验收范围见 [百度扫码登录](BAIDU-AUTH.md)，后续根因见 [排查结论](baidu-login-followup-research.md)。

## 结论与本地差异

优先参考 **BaiduPCS-Rust 的真实 Set-Cookie 提取** 和 **tvbox-silicon 的全程会话 Cookie jar**。两者都实际实现 `getqrcode → unicast → qrbdusslogin`，不是用开放平台 OAuth 代替网页登录。维护状态只说明近期有提交，不代表本次已证明它们在所有账号、Cloudflare 出口上成功。

调研时本地 `src/core/baidu-qr.ts` 的 start/poll 未携带完整会话 jar，exchange 才新建 jar；并且取 STOKEN 时强制其来源为 pan.baidu.com。参考实现存在两处明确差异：登录从申请二维码开始一直复用 jar；STOKEN 从 qrbdusslogin 的 Set-Cookie / 合法百度域 jar 获取，不要求必须由 pan.baidu.com 响应首次下发。这些是可验证假设，尚不能直接断言为线上失败根因。

应遵循标准 Cookie Domain/Path/Secure 作用域：passport 响应可合法设置 `.baidu.com` Cookie，该 Cookie 能发给 pan.baidu.com；passport 的 host-only Cookie 则不能自动发给 pan。不能把所有 passport 专属 STOKEN、JSONP session.stoken 或临时 channel_v.v 不加区分地当作最终网盘 Cookie。

## 一手代码证据

### komorebiCarry/BaiduPCS-Rust

未归档；默认分支最近提交为 [2456e51，2026-11-03 01:36:03 UTC](https://github.com/komorebiCarry/BaiduPCS-Rust/commit/2456e51bbeed66da13997d96b7dbd4859533f7cb)。[仓库元数据](https://api.github.com/repos/komorebiCarry/BaiduPCS-Rust)。

- [backend/src/auth/qrcode.rs](https://github.com/komorebiCarry/BaiduPCS-Rust/blob/2456e51bbeed66da13997d96b7dbd4859533f7cb/backend/src/auth/qrcode.rs)：`new_with_proxy` 创建 `reqwest::Client.cookie_store(true)`，同一客户端用于二维码及后续请求。`fetch_qrcode_sign` 还保留 BAIDUID；`confirm_login` 把 unicast 的 v 作为临时 bduss 传到 qrbdusslogin，u 指向 `https://pan.baidu.com/disk/main`。
- 同一文件 `confirm_login` 明确遍历 `resp.headers().get_all("set-cookie")`，提取 BDUSS、STOKEN、PTOKEN、BAIDUID、SBOXTKN，保存全部 name=value；不是从 JSONP 的 session.stoken 当作网盘令牌。它没有本地的“STOKEN 必须来自 pan 响应”限制。但其简单按名字提取也不宜照抄，应保留我们自己的标准域名和重定向校验。
- [constants.rs](https://github.com/komorebiCarry/BaiduPCS-Rust/blob/2456e51bbeed66da13997d96b7dbd4859533f7cb/backend/src/auth/constants.rs) 中二维码申请为 `lp=pc`、`qrloginfrom=pc`、`tpl=netdisk`；二维码图片请求改为 mobile。说明应区分二维码参数和最终使用的 Web Cookie / APP token；不能仅因需要手机扫描就整体切换到 APP OAuth。
- [backend/src/netdisk/client.rs](https://github.com/komorebiCarry/BaiduPCS-Rust/blob/2456e51bbeed66da13997d96b7dbd4859533f7cb/backend/src/netdisk/client.rs) 把 STOKEN 等载入 Cookie jar，另有 Web 预热以取得 PANPSC、csrfToken、bdstoken。该预热面向其网盘功能，不能直接断言每个签到接口都需要。
- 不应照抄源码中的完整 Set-Cookie 日志或部分 BDUSS 日志；生产诊断仅保留 Cookie 名称、作用域、是否存在、长度及上游错误码。

### jo32/tvbox-silicon

未归档；默认分支最近提交为 [ffd1eb9，2026-11-03 09:18:25 UTC](https://github.com/jo32/tvbox-silicon/commit/ffd1eb9d1f66eb48fa1cbfcbb951ecbd0cb0b677)。[仓库元数据](https://api.github.com/repos/jo32/tvbox-silicon)。

[Sources/TVCore/CloudDriveQRLogin.swift](https://github.com/jo32/tvbox-silicon/blob/ffd1eb9d1f66eb48fa1cbfcbb951ecbd0cb0b677/Sources/TVCore/CloudDriveQRLogin.swift)：

- `startBaidu` 创建独立 ephemeral URLSession，设置约 45 秒请求超时；将 session 和 gid 保存在登录对象里。申请参数是 pc + netdisk，直接显示上游 imgurl。
- `pollBaidu` 复用同一个 session/gid，调用 unicast，解析 channel_v.status 与临时 v；errno=1 视为等待。
- `completeBaidu` 仍复用 session 请求 qrbdusslogin，u 为 `https://pan.baidu.com/disk/home`，使用 v4、qrcode=1、tpl=netdisk、apiver=v3 等参数；随后从 session Cookie storage 取得 BDUSS/STOKEN/PTOKEN。它只要求 BDUSS 存在，所以不能据此保证 STOKEN 永远下发。
- 它采用客户端标准 Cookie storage；我们的实现应按目标 URL 选择可发送 Cookie，避免直接复制它按域后缀聚合的宽松做法。它证明的是共享会话实现差异，并非放宽域安全边界的理由。

## 排除项

[OpenListTeam/OpenList](https://api.github.com/repos/OpenListTeam/OpenList) 未归档，最近提交 [e72822f，2026-10-30](https://github.com/OpenListTeam/OpenList/commit/e72822f5390f4272c9fe9da8cabba3c1a270182f)。其 [baidu_netdisk/meta.go](https://github.com/OpenListTeam/OpenList/blob/e72822f5390f4272c9fe9da8cabba3c1a270182f/drivers/baidu_netdisk/meta.go) 要求 RefreshToken，[util.go](https://github.com/OpenListTeam/OpenList/blob/e72822f5390f4272c9fe9da8cabba3c1a270182f/drivers/baidu_netdisk/util.go) 使用 `openapi.baidu.com/oauth/2.0/token`。这能参考开放平台令牌刷新，不能当作获取签到所需 Web STOKEN 的直接实现。

[awakaze/cf-netdisk-signin](https://api.github.com/repos/awakaze/cf-netdisk-signin) 未归档，最近提交 [c49e5ce，2026-10-22](https://github.com/awakaze/cf-netdisk-signin/commit/c49e5ced1b95958e8fe2c719ebb21ee56851fddd)。本次直接检查 src/core.js 与 src/worker.js 没有发现上述扫码端点及 STOKEN 字面量；不能以项目名或签到成功宣称它提供了可复用的 STOKEN 获取方案。

## 当时的验证建议

同为 Cloudflare Worker 的补充参考是 [2110693561/2110693561.github.io 的 oauth-worker/src/index.js](https://github.com/2110693561/2110693561.github.io/blob/main/oauth-worker/src/index.js)，主代理已核读 `diskQrInit`、`diskQrPoll`、`ingestCookies` 和 `parseLoose`：申请二维码后即收集 Cookie，经 `X-QR-Cookie` 往返保留；轮询和 qrbdusslogin 都带回同一份 Cookie，并继续合并 Set-Cookie。其确认参数还有 `getcookies=1`、`loginmerge=true`、`clientfrom=web` 等，与 Rust/Swift 及本地存在变体，不能未经实测就全盘替换。

作者自己的[登录管理实现记录](https://2110693561.github.io/posts/2026-09-04-netdisk-login-admin/)及[网盘接入排查记录](https://2110693561.github.io/posts/2026-09-04-netdisk-three-in-one/)也记录了这一排查过程。源码依然有 JSONP session 字段回退及按长度判断 BDUSS 的逻辑，不能将其当成普遍可靠的最终身份判据。本项目不宜照搬把登录 Cookie 交给前端的做法，应在现有服务端扫码会话中加密保存，并继续按标准 Cookie 作用域处理。

另一类参考是 [NkAntony777/baiduwangpan-cli 的 lib/browser-login.js](https://github.com/NkAntony777/baiduwangpan-cli/blob/main/lib/browser-login.js)，主代理已直接核读。它保留专用浏览器 profile，经 CDP 取得 BDUSS/STOKEN，在同一浏览器会话内请求 gettemplatevariable 验证登录，再保留浏览器供后续网页 API 使用。这适合作为纯 HTTP 方案实测仍被浏览器会话绑定阻断时的备选；会增加本地或服务器常驻浏览器，不是当前纯 Worker 部署的首选。不能仅根据项目 README 宣称所有扫码 Cookie 都必须保留浏览器。

先补充一个从 getqrcode 起保留 Cookie/gid 的服务端扫码会话；每一步和每一跳分别收集多 Set-Cookie，在原有白名单及域规则下传递。对 STOKEN 区分“合法适用于 pan 的父域 Cookie”与“passport host-only / JSONP session token”。保留 PTOKEN、BAIDUID 等已返回的有效辅助 Cookie，具体必需项以实际接口结果验证。

用脱敏日志比较当前与参考流程的 Cookie 名称/作用域、重定向目标和 errno，完成一次真实扫码闭环后，再决定是否需要额外预热。不能仅凭一个预检接口或 STOKEN 字符长度宣称登录成功，也不能把开放平台 access_token 与 Web Cookie 混用。

## 实施结果（2026-11-04 同步）

已实现服务端加密扫码会话、全程 Cookie jar、标准域/路径隔离与辅助 Cookie 保留。真实排查另确认了回调大页面、收齐 Cookie 后继续重定向和中转超时问题；修正后已完成扫码绑定及业务接口验证，详细实现、时限和诊断开关见 [百度扫码登录](BAIDU-AUTH.md)。

当前临时诊断开关与日志持久化已关闭。扫码成功不代表未来永不失效，也不保证所有账号或出口均可成功；缺少网盘 STOKEN 时仍需更新完整 Cookie 或重新扫码。
