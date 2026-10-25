import test from 'node:test';
import assert from 'node:assert/strict';
import { BiliClient, beijingDate, options, readStatus, runAttempt } from '../src/modules/bilibili/original-core.js';
import worker, { BiliTaskCoordinator } from '../third_party/cf-bilibili-coupon-worker/worker.js';
import { message, notify } from '../third_party/cf-bilibili-coupon-worker/notify.js';

const baseConfig = options({ BILI_COOKIE: 'SESSDATA=session; bili_jct=csrf123; DedeUserID=42', BILI_AUTO_CLAIM: 'false', BILI_AUTO_EXCHANGE: 'true', SETTLE_WAIT_MS: '0' });
const mkReport = () => ({ date: '2026-10-25', attempts: 0, errors: [], ok: false });
const response = data => Response.json(data);

function fakeClient({ couponBalances = [5, 0], goldBalances = [10000, 15000], exchangeResponse = { code: 0, message: 'success' }, exchangeThrows = false } = {}) {
  let couponIndex = 0;
  let goldIndex = 0;
  let exchangeCalls = 0;
  const fetcher = async (input, init = {}) => {
    const url = new URL(input);
    if (url.pathname === '/x/web-interface/nav') {
      const balance = couponBalances[Math.min(couponIndex++, couponBalances.length - 1)];
      return response({ code: 0, data: { isLogin: true, mid: '42', uname: 'test-user', wallet: { bcoin_balance: 0, coupon_balance: balance } } });
    }
    if (url.pathname === '/xlive/web-ucenter/user/get_user_info') {
      const gold = goldBalances[Math.min(goldIndex++, goldBalances.length - 1)];
      return response({ code: 0, data: { gold, silver: 700 } });
    }
    if (url.pathname === '/x/vip/privilege/my') return response({ code: 0, data: { list: [] } });
    if (url.pathname === '/xlive/revenue/v1/order/createOrder') {
      exchangeCalls++;
      if (exchangeThrows) throw new Error('network fail');
      assert.equal(init.method, 'POST');
      const body = new URLSearchParams(init.body);
      assert.equal(body.get('pay_bp'), '5000');
      assert.equal(body.get('goods_num'), '5');
      return response(exchangeResponse);
    }
    throw new Error(`unexpected URL ${url}`);
  };
  return { client: new BiliClient({ ...baseConfig, cookie: 'SESSDATA=session; bili_jct=csrf123; DedeUserID=42', csrf: 'csrf123', timeout: 1000, settleWaitMs: 0 }, fetcher, async () => {}), get exchangeCalls() { return exchangeCalls; } };
}

test('configuration defaults to claiming only; conversion must be explicitly enabled', () => {
  const cfg = options({});
  assert.equal(cfg.autoClaim, true);
  assert.equal(cfg.autoExchange, false);
  assert.equal(options({ BILI_AUTO_EXCHANGE: 'true' }).autoExchange, true);
  assert.equal(beijingDate(Date.parse('2026-10-25T16:00:00Z')), '2026-10-26');
});

test('status reads coupon balance and live gold-seed balance without performing writes', async () => {
  const f = fakeClient({ couponBalances: [10], goldBalances: [23400] });
  const status = await readStatus(f.client);
  assert.equal(status.account.couponBalanceBp, 10);
  assert.equal(status.liveWallet.goldSeeds, 23400);
  assert.equal(status.liveWallet.batteryEquivalent, 234);
});

test('exchange is confirmed only after coupon decrease and expected gold-seed increase', async () => {
  const f = fakeClient({ couponBalances: [5, 5, 0], goldBalances: [10000, 15000, 15000] });
  const config = { ...baseConfig, autoClaim: false, autoExchange: true, settleWaitMs: 0 };
  const report = mkReport();
  await runAttempt(report, f.client, config, async () => {});
  assert.equal(report.exchange.state, 'confirmed');
  assert.equal(report.exchange.goldDelta, 5000);
  assert.equal(report.exchange.batteryDelta, 50);
  assert.equal(report.exchange.couponAfterBp, 0);
  assert.equal(report.ok, true);
  assert.equal(f.exchangeCalls, 1);
  assert.match(message(report).body, /电池折算：100 → 150（\+50）/);
});

test('claimable 5B coupon is claimed and verified from actual coupon balance before exchange', async () => {
  let navCalls = 0;
  let privilegeCalls = 0;
  let claimCalls = 0;
  let exchangeCalls = 0;
  let couponBalance = 0;
  let gold = 0;
  const fetcher = async (input, init = {}) => {
    const url = new URL(input);
    if (url.pathname === '/x/web-interface/nav') {
      navCalls++;
      return response({ code: 0, data: { isLogin: true, mid: '42', uname: 'test', wallet: { bcoin_balance: 0, coupon_balance: couponBalance } } });
    }
    if (url.pathname === '/x/vip/privilege/my') {
      privilegeCalls++;
      return response({ code: 0, data: { list: couponBalance === 0 ? [{ type: 1, state: 0 }] : [{ type: 1, state: 1 }] } });
    }
    if (url.pathname === '/x/vip/privilege/receive') {
      assert.equal(init.method, 'POST');
      assert.equal(url.searchParams.get('type'), '1');
      claimCalls++;
      couponBalance = 5;
      return response({ code: 0, message: '0' });
    }
    if (url.pathname === '/xlive/web-ucenter/user/get_user_info') {
      return response({ code: 0, data: { gold, silver: 0 } });
    }
    if (url.pathname === '/xlive/revenue/v1/order/createOrder') {
      exchangeCalls++;
      return response({ code: 0, message: 'success' });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const client = new BiliClient({ ...baseConfig, autoClaim: true, autoExchange: false, cookie: 'SESSDATA=x; bili_jct=y', csrf: 'y', settleWaitMs: 0 }, fetcher, async () => {});
  const report = mkReport();
  await runAttempt(report, client, { ...baseConfig, autoClaim: true, autoExchange: false, settleWaitMs: 0 }, async () => {});
  assert.equal(report.claim.state, 'confirmed');
  assert.equal(report.claim.couponDeltaBp, 5);
  assert.equal(claimCalls, 1);
  assert.equal(exchangeCalls, 0);
  assert.ok(navCalls >= 2 && privilegeCalls >= 2);
  assert.equal(report.ok, true);
});

test('uncertain exchange is never submitted twice on reconciliation retry', async () => {
  const f = fakeClient({ couponBalances: [5, 5, 5, 5], goldBalances: [10000, 10000, 10000, 10000], exchangeThrows: true });
  const config = { ...baseConfig, autoClaim: false, autoExchange: true, settleWaitMs: 0 };
  const report = mkReport();
  await runAttempt(report, f.client, config, async () => {});
  assert.equal(report.exchange.state, 'pending_verification');
  assert.equal(f.exchangeCalls, 1);
  await runAttempt(report, f.client, config, async () => {});
  assert.equal(report.exchange.state, 'unverified');
  assert.equal(f.exchangeCalls, 1);
  assert.equal(report.ok, false);
});

test('API code zero alone is not enough when balances do not move', async () => {
  const f = fakeClient({ couponBalances: [5, 5, 5], goldBalances: [10000, 10000, 10000], exchangeResponse: { code: 0, message: 'success' } });
  const report = mkReport();
  await runAttempt(report, f.client, { ...baseConfig, autoClaim: false, autoExchange: true, settleWaitMs: 0 }, async () => {});
  assert.equal(report.exchange.state, 'pending_verification');
  assert.equal(report.ok, false);
});

test('missing wallet or gold field fails closed instead of assuming zero', async () => {
  const noWallet = new BiliClient({ ...baseConfig, cookie: 'SESSDATA=x; bili_jct=y', csrf: 'y' }, async () => response({ code: 0, data: { isLogin: true, wallet: {} } }));
  await assert.rejects(noWallet.account(), /coupon_balance/);
  const noGold = new BiliClient({ ...baseConfig, cookie: 'SESSDATA=x; bili_jct=y', csrf: 'y' }, async () => response({ code: 0, data: {} }));
  await assert.rejects(noGold.liveWallet(), /data.gold/);
});

function fakeCoordinator(env = {}) {
  const data = new Map();
  const storage = {
    get: async key => structuredClone(data.get(key)),
    put: async (key, value) => data.set(key, structuredClone(value)),
    setAlarm: async value => data.set('alarm', value),
    deleteAlarm: async () => data.delete('alarm'),
  };
  return { object: new BiliTaskCoordinator({ storage }, env), storage, data };
}

test('health is public but management endpoints require ADMIN_TOKEN', async () => {
  assert.equal((await worker.fetch(new Request('https://worker/health'), {})).status, 200);
  assert.equal((await worker.fetch(new Request('https://worker/status'), {})).status, 401);
});

test('daily run is serialized and deduplicated', async () => {
  const { object } = fakeCoordinator({ ADMIN_TOKEN: 'secret', BILI_COOKIE: 'SESSDATA=x; bili_jct=y' });
  let executions = 0;
  object.execute = async report => { executions++; report.phase = 'complete'; await object.ctx.storage.put('report', report); };
  const request = () => new Request('https://internal/run', { method: 'POST' });
  await Promise.all([object.fetch(request()), object.fetch(request())]);
  assert.equal(executions, 1);
});

test('notification can be disabled without leaking secrets', async () => {
  const result = await notify({}, { date: '2026-10-25', attempts: 1, ok: true, errors: [] });
  assert.equal(result.state, 'disabled');
});
