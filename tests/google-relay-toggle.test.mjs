import test from 'node:test';
import assert from 'node:assert/strict';
import { upstreamFetch } from '../src/core/upstream-fetch.ts';

test('Google relay is disabled when the flag is absent', () => {
  assert.equal(upstreamFetch({}), globalThis.fetch);
});

test('Google relay is disabled unless the flag is exactly true', () => {
  assert.equal(upstreamFetch({ GOOGLE_RELAY_ENABLED: 'false' }), globalThis.fetch);
  assert.equal(upstreamFetch({ GOOGLE_RELAY_ENABLED: 'TRUE' }), globalThis.fetch);
  assert.equal(upstreamFetch({ GOOGLE_RELAY_ENABLED: '1' }), globalThis.fetch);
});

test('enabling Google relay requires its independent URL and HMAC secret', () => {
  assert.throws(
    () => upstreamFetch({ GOOGLE_RELAY_ENABLED: 'true' }),
    /GOOGLE_RELAY_CONFIG_MISSING/
  );
});

test('enabled Google relay validates the deployment endpoint', () => {
  assert.throws(
    () => upstreamFetch({
      GOOGLE_RELAY_ENABLED: 'true',
      GOOGLE_RELAY_URL: 'https://example.com/exec',
      GOOGLE_RELAY_HMAC_SECRET: 'x'.repeat(64)
    }),
    /GOOGLE_RELAY_URL_INVALID/
  );
});

test('valid enabled configuration selects a separate relay fetcher', () => {
  const relay = upstreamFetch({
    GOOGLE_RELAY_ENABLED: 'true',
    GOOGLE_RELAY_URL: 'https://script.google.com/macros/s/test-deployment/exec',
    GOOGLE_RELAY_HMAC_SECRET: 'a'.repeat(64)
  });
  assert.equal(typeof relay, 'function');
  assert.notEqual(relay, globalThis.fetch);
});
