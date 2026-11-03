/**
 * Optional Google Apps Script HTTPS Relay for CF Task Hub.
 *
 * Required Script Property:
 *   GOOGLE_RELAY_HMAC_SECRET
 *
 * The Cloudflare Worker sends a signed envelope:
 *   timestamp + "\n" + nonce + "\n" + signature + "\n" + JSON payload
 *
 * This relay does not persist upstream cookies or API keys. The Worker
 * supplies credentials per request; UrlFetchApp can read them while sending.
 *
 * This is an HTTPS API relay, not a TCP/UDP/WebSocket tunnel.
 */

const RELAY_CONFIG = {
  MAX_ENVELOPE_CHARS: 1050000,
  MAX_REQUEST_BYTES: 700000,
  MAX_RESPONSE_BYTES: 700000,
  MAX_HEADER_CHARS: 7000,
  MAX_CLOCK_SKEW_MS: 5 * 60 * 1000,
  NONCE_TTL_SECONDS: 600,
  MAX_URL_LENGTH: 2082
};

const REQUEST_BLOCKED_HEADERS = [
  'host', 'content-length', 'connection', 'keep-alive',
  'transfer-encoding', 'accept-encoding', 'proxy-authorization',
  'proxy-connection', 'proxy-authenticate', 'te', 'trailer',
  'upgrade', 'expect', 'forwarded'
];

const RESPONSE_BLOCKED_HEADERS = [
  'content-length', 'content-encoding', 'connection', 'keep-alive',
  'transfer-encoding', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'upgrade'
];

function doGet() {
  return jsonOutput_({
    ok: true,
    service: 'cf-task-hub-google-relay',
    version: 1
  });
}

function doPost(e) {
  try {
    const raw = e && e.postData ? e.postData.contents : '';
    if (typeof raw !== 'string' || !raw || raw.length > RELAY_CONFIG.MAX_ENVELOPE_CHARS) {
      throw new Error('INVALID_ENVELOPE');
    }

    // Envelope: timestamp \n nonce \n signature \n JSON payload.
    const p1 = raw.indexOf('\n');
    const p2 = raw.indexOf('\n', p1 + 1);
    const p3 = raw.indexOf('\n', p2 + 1);
    if (p1 < 1 || p2 < 0 || p3 < 0) throw new Error('INVALID_ENVELOPE');

    const timestamp = raw.substring(0, p1);
    const nonce = raw.substring(p1 + 1, p2);
    const signature = raw.substring(p2 + 1, p3);
    const payload = raw.substring(p3 + 1);

    if (!/^\d{13}$/.test(timestamp)) throw new Error('INVALID_TIMESTAMP');
    if (Math.abs(Date.now() - Number(timestamp)) > RELAY_CONFIG.MAX_CLOCK_SKEW_MS) {
      throw new Error('REQUEST_EXPIRED');
    }
    if (!/^[A-Za-z0-9_-]{16,80}$/.test(nonce)) throw new Error('INVALID_NONCE');

    const secret = PropertiesService.getScriptProperties()
      .getProperty('GOOGLE_RELAY_HMAC_SECRET');
    if (!secret || secret.length < 32) throw new Error('SECRET_NOT_CONFIGURED');

    const expected = hmacHex_(timestamp + '\n' + nonce + '\n' + payload, secret);
    if (!constantTimeEqual_(signature, expected)) throw new Error('INVALID_SIGNATURE');

    claimNonce_(nonce);
    const request = JSON.parse(payload);
    return executeRelay_(request);
  } catch (err) {
    const message = String(err && err.message ? err.message : '');
    const code = /^[A-Z0-9_]{1,80}$/.test(message) ? message : 'RELAY_FAILURE';
    // Never log or echo credentials, request headers, URLs, or upstream bodies.
    return jsonOutput_({ ok: false, error: code });
  }
}

function executeRelay_(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('INVALID_REQUEST');
  }

  const url = validateTargetUrl_(request.url);
  const method = String(request.method || 'GET').toUpperCase();
  const allowedMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
  if (allowedMethods.indexOf(method) === -1) throw new Error('METHOD_NOT_ALLOWED');

  const inputHeaders = request.headers || {};
  if (typeof inputHeaders !== 'object' || Array.isArray(inputHeaders)) {
    throw new Error('INVALID_HEADERS');
  }

  const headers = {};
  let headerSize = 0;
  Object.keys(inputHeaders).forEach(function(key) {
    const name = key.toLowerCase();
    const value = String(inputHeaders[key]);
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) throw new Error('INVALID_HEADER_NAME');
    if (/[\r\n]/.test(value)) throw new Error('INVALID_HEADER_VALUE');
    if (
      REQUEST_BLOCKED_HEADERS.indexOf(name) !== -1 ||
      name.indexOf('cf-') === 0 ||
      name.indexOf('x-forwarded-') === 0
    ) return;

    headerSize += name.length + value.length;
    if (headerSize > RELAY_CONFIG.MAX_HEADER_CHARS) throw new Error('HEADERS_TOO_LARGE');
    headers[name] = value;
  });

  let bodyBytes = null;
  if (request.bodyB64 !== null && request.bodyB64 !== undefined) {
    if (typeof request.bodyB64 !== 'string') throw new Error('INVALID_BODY');
    try {
      bodyBytes = Utilities.base64Decode(request.bodyB64);
    } catch (err) {
      throw new Error('INVALID_BODY_BASE64');
    }
    if (bodyBytes.length > RELAY_CONFIG.MAX_REQUEST_BYTES) throw new Error('REQUEST_TOO_LARGE');
  }
  if (method === 'GET' && bodyBytes && bodyBytes.length) throw new Error('GET_BODY_NOT_ALLOWED');

  const options = {
    method: method.toLowerCase(),
    headers: headers,
    muteHttpExceptions: true,
    followRedirects: false
  };

  if (bodyBytes !== null) {
    options.payload = bodyBytes;
    options.contentType = headers['content-type'] || 'application/octet-stream';
    delete headers['content-type'];
  }

  const upstream = UrlFetchApp.fetch(url, options);
  const responseBytes = upstream.getContent();
  if (responseBytes.length > RELAY_CONFIG.MAX_RESPONSE_BYTES) throw new Error('RESPONSE_TOO_LARGE');

  const responseHeaders = {};
  const rawHeaders = upstream.getAllHeaders();
  Object.keys(rawHeaders).forEach(function(key) {
    const name = key.toLowerCase();
    if (RESPONSE_BLOCKED_HEADERS.indexOf(name) !== -1) return;
    const value = rawHeaders[key];
    responseHeaders[name] = Array.isArray(value)
      ? value.map(function(item) { return String(item); })
      : String(value);
  });

  return jsonOutput_({
    ok: true,
    status: upstream.getResponseCode(),
    headers: responseHeaders,
    bodyB64: Utilities.base64Encode(responseBytes)
  });
}

function validateTargetUrl_(rawUrl) {
  if (
    typeof rawUrl !== 'string' ||
    !rawUrl ||
    rawUrl.length > RELAY_CONFIG.MAX_URL_LENGTH ||
    /[\r\n\\]/.test(rawUrl)
  ) throw new Error('INVALID_URL');

  // Avoid relying on browser URL APIs in the Apps Script runtime.
  const match = /^https:\/\/([^/?#]+)(?:[/?][^#]*)?$/i.exec(rawUrl);
  if (!match) throw new Error('INVALID_URL');
  const authority = match[1];
  if (authority.indexOf('@') !== -1 || authority.indexOf('\\') !== -1 || authority.indexOf('%') !== -1 || authority.indexOf('[') !== -1 || authority.indexOf(']') !== -1) {
    throw new Error('INVALID_HOST');
  }
  const parts = authority.split(':');
  if (parts.length > 2) throw new Error('INVALID_HOST');
  const host = parts[0].toLowerCase();
  const port = parts.length === 2 ? parts[1] : '443';
  if (port !== '443') throw new Error('HTTPS_ONLY');

  const hostnamePattern = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
  if (!hostnamePattern.test(host) || /^[0-9.]+$/.test(host)) throw new Error('INVALID_HOST');

  const blockedSuffixes = [
    '.localhost', '.local', '.internal', '.test', '.invalid',
    '.example', '.onion', '.home', '.lan'
  ];
  if (
    host === 'localhost' ||
    host === 'metadata' ||
    host === 'metadata.google.internal' ||
    blockedSuffixes.some(function(suffix) { return host.endsWith(suffix); })
  ) throw new Error('PRIVATE_HOST_NOT_ALLOWED');

  return rawUrl;
}

function hmacHex_(message, secret) {
  const bytes = Utilities.computeHmacSha256Signature(
    message,
    secret,
    Utilities.Charset.UTF_8
  );
  return bytes.map(function(value) {
    return ('0' + ((value + 256) % 256).toString(16)).slice(-2);
  }).join('');
}

function constantTimeEqual_(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function claimNonce_(nonce) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) throw new Error('BUSY');
  try {
    const cache = CacheService.getScriptCache();
    const key = 'google_relay_nonce_' + nonce;
    if (cache.get(key)) throw new Error('REPLAY_DETECTED');
    cache.put(key, '1', RELAY_CONFIG.NONCE_TTL_SECONDS);
  } finally {
    lock.releaseLock();
  }
}

function jsonOutput_(value) {
  let text = JSON.stringify(value);
  if (text.length > RELAY_CONFIG.MAX_ENVELOPE_CHARS) {
    text = JSON.stringify({ ok: false, error: 'RESPONSE_ENVELOPE_TOO_LARGE' });
  }
  return ContentService.createTextOutput(text)
    .setMimeType(ContentService.MimeType.JSON);
}
