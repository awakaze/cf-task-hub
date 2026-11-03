# 百度扫码确认失败：第二轮源码核对

源码对照快照：2026-11-03；结论同步：2026-11-04。前半部分保留诊断前的实现差异，后半部分记录已验证结论。仅核读外部公开源码，未执行外部项目或读取其账号状态文件。现行操作说明见 [百度扫码登录](BAIDU-AUTH.md)。

## 关键发现

**与同平台 Worker 实现相比，当时本地确认请求缺少 `getcookies=1` 和 `loginmerge=true`，版本参数也不同。** [2110693561 的实际源码第 676 行](https://github.com/2110693561/2110693561.github.io/blob/251f1b72df269479c352a48edebcf76c69b14b6f/oauth-worker/src/index.js#L676) 使用以下参数组合：

`bduss=<临时v>&u=<https://pan.baidu.com/>&clientfrom=web&lp=pc&loginmerge=true&actionlog&v=2&getcookies=1&callback=bdlogin`

本地 `src/core/baidu-qr.ts` 使用 `v=<毫秒时间戳>`、`loginVersion=v4`、`qrcode=1`、`tpl=netdisk`、`apiver=v3`、`tt`、`time=<秒>`、`alg=v3`、`callback=bd__cbs__login`。两者并非同一请求形状。另两个近期源码仍使用类似本地的 v4/时间戳参数，因而不能把某一组宣布为唯一正确协议；应优先以完整同源参数组合做验证，不能随意拼接或在不确定时重复消费同一临时 v。

**百度的确认响应可能不是严格 JSON。** 同一 Worker 的 [parseLoose，第 522 行](https://github.com/2110693561/2110693561.github.io/blob/251f1b72df269479c352a48edebcf76c69b14b6f/oauth-worker/src/index.js#L522) 在 JSONP 内容 JSON.parse 失败后，还将单引号的属性名转换为 JSON 双引号再解析。mogumc 项目也专门清理单引号和 `&quot;`。本地 parseCallback 只接受严格 JSON 或 callback(严格JSON)，否则返回 null；因此单引号键、HTML 包装或回调外的文字会丢失上游错误结构或 session fallback。但若正确 Set-Cookie 已齐全，JSON 解析失败本身不一定阻止本地完成。

## 项目证据和适用边界

| 项目 | 本次 API 核实状态及最新提交（UTC） | 确认流程 |
| --- | --- | --- |
| [mogumc/BaiduQRlogin](https://api.github.com/repos/mogumc/BaiduQRlogin) | 未归档；[59469c9，2026-05-23 03:45:38](https://github.com/mogumc/BaiduQRlogin/commit/59469c96956a33049e50cb4d200c3ad1acaeb312) | [auth/qr.go#L108](https://github.com/mogumc/BaiduQRlogin/blob/59469c96956a33049e50cb4d200c3ad1acaeb312/auth/qr.go#L108) 用 `tpl=pp`、`qrcode=1`、`apiver=v3`、tt/time均毫秒、`elapsed=1`，未带 callback/u/loginmerge/getcookies；取 JSON session.bduss/stoken/ptoken 并打印。HTTP client 无 Cookie jar。**没有网盘接口验证，不能据其“登录成功”证明 STOKEN 可签到。** |
| [komorebiCarry/BaiduPCS-Rust](https://api.github.com/repos/komorebiCarry/BaiduPCS-Rust) | 未归档；[2456e51，2026-11-03 01:36:03](https://github.com/komorebiCarry/BaiduPCS-Rust/commit/2456e51bbeed66da13997d96b7dbd4859533f7cb) | [backend/src/auth/qrcode.rs](https://github.com/komorebiCarry/BaiduPCS-Rust/blob/2456e51bbeed66da13997d96b7dbd4859533f7cb/backend/src/auth/qrcode.rs) 全程 client.cookie_store(true)；确认带 v/tt毫秒、临时bduss、u=`/disk/main`、tpl=netdisk、qrcode=1、apiver=v3。无 getcookies/loginmerge/callback/gid。从所有 Set-Cookie 提取凭据，确认不依赖响应体解析。 |
| [jo32/tvbox-silicon](https://api.github.com/repos/jo32/tvbox-silicon) | 未归档；[1ed263a，2026-11-03 15:05:39](https://github.com/jo32/tvbox-silicon/commit/1ed263a89008132513d85b20c122f9ba8bca7e26) | [CloudDriveQRLogin.swift#L161](https://github.com/jo32/tvbox-silicon/blob/1ed263a89008132513d85b20c122f9ba8bca7e26/Sources/TVCore/CloudDriveQRLogin.swift#L161) 参数最接近本地，u=`/disk/home`；callback带随机后缀，无 getcookies/loginmerge。全程 URLSession cookie storage；确认阶段忽略响应体，只从 jar 取凭据。仅要求 BDUSS，不保证 STOKEN 存在。 |
| [2110693561/2110693561.github.io](https://api.github.com/repos/2110693561/2110693561.github.io) | 未归档；[251f1b7，2026-09-29 10:00:12](https://github.com/2110693561/2110693561.github.io/commit/251f1b72df269479c352a48edebcf76c69b14b6f) | [oauth-worker/src/index.js#L645](https://github.com/2110693561/2110693561.github.io/blob/251f1b72df269479c352a48edebcf76c69b14b6f/oauth-worker/src/index.js#L645) 是上述 v=2/getcookies/loginmerge 参数组合；全程 Map jar，Set-Cookie优先，session字段fallback。未强制STOKEN存在。Map丢失Domain/Path信息，不能照抄其安全边界。 |

未归档和提交日期仅为维护迹象；本次未复测它们的真实扫码成功率。

## 与本地的具体差异及验证优先级

1. **参数组：** 同 Worker 的 getcookies/loginmerge/v=2 组合是最直接的新假设。现有 Swift/Rust 表明本地旧式组合有源码先例，但不能因此保证当前 Cloudflare 出口成功。确认请求加入 gid 不是这四个项目的共同要求：Swift在申请/轮询保持同一个gid，确认阶段不传；本地目前申请/轮询没有gid。
2. **错误解析：** 本地严格 JSON.parse 会吞掉单引号对象；应采用不执行脚本的受限解析，优先只提取 errno/errInfo.no 等安全诊断。禁止 eval/Function，也不照抄 mogumc 的全文引号替换，后者会破坏字符串值。确认成功以适用 Cookie 与身份验证为准。
3. **响应体处理：** 当时本地在确认时先读取最多16KiB正文，正文过大即抛错，即使已收齐有效Cookie也会失败；Rust/Swift确认阶段不依赖正文。若返回HTML/风控/跳转页面，需先区分当前失败是限长、网络错误还是 Cookie 不全，不能一概归为 token 错误。
4. **重定向：** 当时本地每一跳manual并收Cookie，最多4次请求、整链10秒；Swift的URLSession和Rust reqwest使用客户端默认自动重定向，其超时/跳数更宽。Worker参考也未指定redirect，使用fetch默认行为，且只读取最终response头；这可能丢中间Cookie。我们的逐跳捕获更完整，不应改成无约束follow，但可脱敏记录状态、跳数、目标host/path和终止原因。
5. **STOKEN双域：** 这些参考大多按名字覆盖，不能证明 parent-domain、pan-domain或passport host-only的同名值可互换。本地新版已接受适用于pan的父域Cookie，不能再沿用上一轮“仅pan来源”旧结论。但 jar.header(PAN_ROOT) 可能保留两个域同名STOKEN；value取适用列表首个，按Path长度和创建顺序排序而非Domain具体性。应在合成测试/实际脱敏诊断中区分名称+域+路径，不输出值，不盲目改域或选错凭据。
6. **观察能力：** COOKIE_EXCHANGE_FAILED是汇总错误，不足以选择上面哪一项。建议只保留阶段、HTTP状态、Content-Type、受限解析错误码、Cookie名称和Domain/Path、是否有BDUSS/STOKEN、重定向host/path及请求超时类别。不要记录临时v、完整URL query、原始正文、Set-Cookie值或用户资料。processing/poll_count=1也可能只是请求尚未结束或处理状态未恢复，不能当作第二个独立协议故障。

上述差异在当时尚未证明为线上根因；后续验证结果如下。

## 已验证根因与修正

1. **回调正文误读。** 原实现即使已收齐 BDUSS/STOKEN，仍把最终网盘网页按 16KiB 的登录正文读取。合成回归稳定复现“百度响应超过允许大小”。现优先使用逐跳收集的 Cookie，仅在缺少 BDUSS 且响应来自 passport/wappass 时读取有界正文。
2. **重定向终止条件。** 实际诊断观察到 pan → passport → pan 跳转在 302 中已下发可用网盘 STOKEN，但代码仍继续导航并达到请求次数上限，错误为 `BAIDU_QR_NETDISK_RESPONSE`。已用同样的响应顺序复现并修正：收齐 Cookie 即停止，仍保留地址白名单和后续账号身份验证。
3. **中转超时预算。** 后续诊断中，单次中转跳转耗时约数秒，完整链超过原 10 秒上限，记录 `BAIDU_QR_NETDISK_TIMEOUT`。缩放时限和延迟的 AbortSignal 回归复现同类失败。现每条交换链最多 30 秒、整个交换最多 45 秒，不延长其他业务请求。

没有据此盲目切换 v2/v4 参数组、把 JSONP session.stoken 当网盘令牌，或移除域与路径校验。

## 验证与当前状态

已完成真实账号扫码绑定，并通过业务运行确认身份、签到和奖励接口可用。运行报告正常返回今日已签到及奖励档位状态；没有在公开文档中保存真实账号标识、登录值、个人成长值或扫码日志。

现有代码包含回归测试，最新完整检查共 211 项通过（160 项单元、51 项接口集成），另通过类型检查、前端构建和发布预检。2026-11-04 已部署运行结果说明更新，健康与登录准备检查正常。

临时 `BAIDU_QR_DIAGNOSTICS=false`，临时日志持久化关闭。详细阶段日志与固定原因码说明见 [百度扫码登录](BAIDU-AUTH.md)。B 站二维码和续期的真实验证范围独立记录在 [B 站登录说明](BILIBILI-AUTH.md)，不以百度验收推断 B 站续期已完成。
