# Optional Google Apps Script HTTPS Relay

Chinese guide: [GOOGLE-RELAY-zh-CN.md](GOOGLE-RELAY-zh-CN.md).

## Summary

The Google relay is an optional, isolated transport adapter for platform upstream HTTP requests. It is **disabled by default**. If `GOOGLE_RELAY_ENABLED` is absent, empty, `false`, `TRUE`, or any value other than the exact string `true`, the application returns the native Cloudflare `fetch` function and existing behavior is unchanged.

When enabled, the platform modules use Google Apps Script `UrlFetchApp` for upstream requests. The application does not add a public proxy route. The existing Task Hub authentication, authorization, account ownership, task scheduling, Durable Object coordination, queue processing, and business logic remain in Cloudflare Workers.

## Scope of integration

The selector is used for:

- Baidu Netdisk account identity checks.
- Baidu Netdisk account probes and task execution.
- Baidu QR login start, poll, and cookie exchange requests.
- Bilibili account identity checks.
- Bilibili account probes, task execution, and read-only reconciliation.

The following traffic is not routed through Google:

- Browser requests to Task Hub.
- D1, Durable Object, Queue, and internal service bindings.
- Notification providers (Telegram, ServerChan, generic webhook).
- Static assets and frontend delivery.
- Any code path that calls native `fetch` directly rather than the platform fetcher injection point.

This boundary is intentional: the Google integration is not a global monkey patch and does not silently reroute unrelated application traffic.

## Changed files

| File | Change |
|---|---|
| `src/core/google-relay.ts` | HMAC-authenticated Google Apps Script transport implementation |
| `src/core/upstream-fetch.ts` | Feature-flag selector; native fetch is the default |
| `src/core/types.ts` | Optional relay environment bindings |
| `src/api/user.ts` | Pass selected fetcher into identity checks and account probes |
| `src/api/platforms.ts` | Pass selected fetcher into identity checks, probes, and Baidu QR flow |
| `src/durable/account-coordinator.ts` | Pass selected fetcher into execution and reconciliation contexts |
| `src/modules/baidu-netdisk/adapter.ts` | Probe accepts an optional injected fetcher |
| `src/modules/bilibili/adapter.ts` | Probe accepts an optional injected fetcher |
| `wrangler.jsonc` | Explicit `GOOGLE_RELAY_ENABLED: false` default |
| `tests/google-relay-toggle.test.mjs` | Tests default-off and configuration selection |
| `google-apps-script/Code.gs` | Google Apps Script Web App implementation |

No SQL migration is required. No frontend changes are required. Existing scheduled tasks, queues, Durable Objects, and notification flows are not redesigned.

## Configuration

### Default state

`wrangler.jsonc` contains:

```jsonc
"GOOGLE_RELAY_ENABLED": "false"
```

This is deliberate. Do not enable the relay until the Google Web App has been deployed and the secret values match.

### Cloudflare Worker variables

Configure these in Worker Settings > Variables and Secrets:

| Name | Type | Value |
|---|---|---|
| `GOOGLE_RELAY_ENABLED` | Plain text variable | `false` initially; set to exact `true` to opt in |
| `GOOGLE_RELAY_URL` | Plain text variable | The deployed Apps Script URL ending in `/exec` |
| `GOOGLE_RELAY_HMAC_SECRET` | Secret | A random high-entropy secret, at least 32 characters |

Keep all existing Task Hub secrets unchanged, including `DATA_KEY`, `IDENTITY_KEY`, `BOOTSTRAP_TOKEN`, and platform credentials. The relay secret is separate from these application secrets.

### Google Apps Script

1. Open <https://script.google.com/> and create a project.
2. Replace the content of `Code.gs` with `google-apps-script/Code.gs` from this project.
3. Generate a new random secret with at least 32 bytes of entropy. A password manager or cryptographically secure generator should be used; do not reuse a password.
4. In Project Settings > Script Properties, add `GOOGLE_RELAY_HMAC_SECRET` with the exact same value configured as the Cloudflare Worker Secret.
5. Save the project.
6. Deploy > New deployment > Web app.
7. Execute as: **Me**.
8. Who has access: **Anyone**, if allowed by the account or Workspace administrator. The Web App needs to accept the Worker request without an interactive Google login; HMAC authenticates the request at the application layer.
9. Copy the deployed URL ending in `/exec` and set it as `GOOGLE_RELAY_URL` in Cloudflare.

If your Google account or Workspace policy does not permit public Web App access, do not weaken organizational security controls. This deployment pattern will not work until an approved invocation method is available.

After changing Apps Script source, edit the existing deployment and deploy a new version. Saving the editor alone does not necessarily update the deployed Web App version.

## Request authentication protocol

The Worker creates a JSON payload containing:

- Target HTTPS URL.
- HTTP method.
- Request headers.
- Optional Base64-encoded request body.

It then creates an envelope:

```text
timestamp\nnonce\nhmac_sha256(timestamp + "\n" + nonce + "\n" + payload)\npayload
```

The envelope is sent as an HTTPS POST to the Google `/exec` URL. Apps Script checks:

- Timestamp is within five minutes of its current time.
- Nonce has the expected format and has not recently been observed in Script Cache.
- HMAC-SHA256 matches using `GOOGLE_RELAY_HMAC_SECRET`.
- The target URL uses HTTPS, port 443, and a public-looking DNS hostname.
- Method and header names are allowed.
- Request and response sizes stay within configured limits.

Nonce replay protection uses Apps Script CacheService and is best-effort: Google may evict cache entries before their requested expiration. It is an additional mitigation, not a durable exactly-once guarantee.

## Credential handling

The relay does not store Bilibili Cookie, Baidu Cookie, or third-party API keys in Script Properties. The Worker passes the required credential in the individual upstream request headers. Apps Script necessarily receives and can read those headers while making the upstream request; therefore this is not end-to-end secrecy from Google. It only avoids creating a separate persistent copy of platform credentials in the Apps Script project.

Keep Apps Script project editor access restricted to trusted administrators. Do not log request payloads, headers, cookies, tokens, or the HMAC secret. Do not paste real credentials into issue trackers, chat, or source control.

## Enabling and disabling

### Enable

1. Deploy the Google Web App.
2. Set `GOOGLE_RELAY_URL`.
3. Set `GOOGLE_RELAY_HMAC_SECRET` as a Worker Secret.
4. Set `GOOGLE_RELAY_ENABLED` to the exact string `true`.
5. Redeploy or allow the updated Worker configuration to take effect.
6. Test a read-only identity endpoint before enabling state-changing tasks.

### Disable / rollback

Set `GOOGLE_RELAY_ENABLED` to `false` (or remove it) and redeploy/update the Worker configuration. The selector immediately returns native Cloudflare `fetch`; no database migration or data conversion is needed. The Google Web App can remain deployed but will no longer be called by this project.

## Limits and behavior differences

This implementation is an HTTP(S) API relay, not a full network tunnel.

- Supports GET, POST, PUT, PATCH, and DELETE.
- Does not support TCP, UDP, WebSocket, HTTP/2 extended CONNECT, or arbitrary sockets.
- Does not provide transparent streaming. Request and response bodies are buffered and Base64-wrapped.
- Current code limits request and response bodies to 700,000 bytes each and request headers to 7,000 characters.
- Apps Script URL Fetch has its own URL length, execution-time, daily quota, and service limits. The current implementation additionally limits target URLs to 2,082 characters.
- Some restricted headers cannot be set by Apps Script. `Host`, `Content-Length`, hop-by-hop headers, Cloudflare headers, and forwarded headers are removed.
- Response headers are reconstructed; multi-value headers and `Set-Cookie` semantics may not be perfectly transparent for every upstream.
- The Worker respects the original `Request.redirect` mode. Manual redirect mode returns the upstream redirect to the caller. Follow mode follows a bounded number of redirects and strips sensitive credentials when the origin changes.
- Google Apps Script does not expose a reliable per-request cancellation control for an upstream `UrlFetchApp.fetch`. If the Worker-side signal aborts, the Apps Script execution may still finish its upstream request. This is especially important for non-idempotent actions: the existing Bilibili checkpoint/reconciliation safeguards must remain enabled.
- Google egress addresses are shared and may change. Enabling this relay does not guarantee a fixed IP, a specific country, or that Bilibili will stop returning 412 / risk-control responses.

## Security boundaries

The relay rejects non-HTTPS URLs, non-443 ports, IP-literal hosts, localhost, and common private/test host suffixes. This is a defensive baseline, not a complete SSRF defense. String validation alone cannot fully prevent DNS rebinding or guarantee that a hostname resolves only to public IP addresses.

The application does not expose a public endpoint that accepts an arbitrary target URL. The relay is called from internal platform code after the existing Task Hub authentication/authorization checks. Preserve that property. Do not add a public generic proxy route without a separate authorization model, strict target policy, abuse limits, and security review.

The HMAC secret must be stored as a Cloudflare Worker Secret and as a Google Script Property. If it is exposed, rotate it in both locations. Do not put it in `wrangler.jsonc`, source code, frontend code, query strings, or logs.

## Testing

Run from the project root:

```bash
npm run typecheck:worker
node --experimental-strip-types --test tests/google-relay-toggle.test.mjs
npm run test:syntax
npm test
npm run test:http
npm run build
npm run dry-run
```

The toggle tests verify:

- Missing flag uses native Cloudflare fetch.
- Values other than exact `true` use native fetch.
- Enabling without URL/secret fails closed.
- Invalid deployment URLs are rejected.
- A valid enabled configuration selects a separate relay fetcher.

These tests do not call Google or Bilibili. Complete a controlled live test only after deploying the Web App and setting the secrets.

## Operational checklist

- [ ] Google Web App deployed and `/exec` URL copied.
- [ ] Same random HMAC secret stored in Google Script Properties and Cloudflare Worker Secret.
- [ ] `GOOGLE_RELAY_ENABLED` remains `false` until configuration is complete.
- [ ] Read-only IP check succeeds through the relay.
- [ ] Read-only Bilibili identity check succeeds before state-changing calls are tested.
- [ ] Existing Cron, queue, account coordinator, and notification behavior remains unchanged.
- [ ] Rollback tested by setting `GOOGLE_RELAY_ENABLED=false`.
