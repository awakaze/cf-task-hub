const MAIN_ORIGIN = 'https://api.bilibili.com';
const LIVE_ORIGIN = 'https://api.live.bilibili.com';
const VIP_REFERER = 'https://account.bilibili.com/';
const LIVE_REFERER = 'https://live.bilibili.com/';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// B站 nav.wallet.coupon_balance 是 B 币券面值余额（以 B 币为单位），不是券张数。
// 每张常见的 5B 币券会令余额增加 5；旧版兑换实现使用每 1 B 币对应 1000 金瓜子。
export const BCOIN_COUPON_FACE_VALUE = 5;
export const GOLD_SEEDS_PER_B = 1000;
export const GOLD_SEEDS_PER_BATTERY = 100;

export function cookieField(cookie = '', name) {
  return String(cookie).split(';').map(part => part.trim())
    .find(part => part.startsWith(`${name}=`))?.slice(name.length + 1) || '';
}

function positiveInteger(value, fallback, name, min = 0, max = 60000) {
  const number = Number(value ?? fallback);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`${name} 必须是 ${min}–${max} 的整数`);
  }
  return number;
}

export function options(env = {}) {
  return {
    cookie: env.BILI_COOKIE || '',
    csrf: cookieField(env.BILI_COOKIE || '', 'bili_jct'),
    retryMinutes: positiveInteger(env.RETRY_MINUTES, 30, 'RETRY_MINUTES', 1, 1440),
    timeout: positiveInteger(env.TIMEOUT_MS, 15000, 'TIMEOUT_MS', 100, 60000),
    settleWaitMs: positiveInteger(env.SETTLE_WAIT_MS, 1200, 'SETTLE_WAIT_MS', 0, 10000),
    autoClaim: env.BILI_AUTO_CLAIM !== 'false',
    // 兑换会消耗 B 币券，因此必须显式设置为字符串 "true" 才会执行。
    autoExchange: env.BILI_AUTO_EXCHANGE === 'true',
  };
}

export function beijingDate(time = Date.now()) {
  return new Date(time + 8 * 3600000).toISOString().slice(0, 10);
}

function asNonNegativeInteger(value, label) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${label} 响应缺少有效数值`);
  return n;
}

function apiCode(data) {
  const raw = data?.code;
  if (typeof raw === 'number' && Number.isInteger(raw)) return raw;
  if (typeof raw === 'string' && /^-?\d+$/.test(raw)) return Number(raw);
  return null;
}

function apiMessage(data) {
  const message = data?.message ?? data?.msg ?? data?.showMsg;
  return typeof message === 'string' ? message.slice(0, 240) : '';
}

export class BiliClient {
  constructor(config, fetcher = fetch, sleeper = ms => new Promise(resolve => setTimeout(resolve, ms))) {
    this.config = config;
    // Cloudflare Workers 原生 fetch 不应绑定到客户端实例。
    this.fetcher = (input, init) => fetcher(input, init);
    this.sleeper = sleeper;
  }

  ensureAuth() {
    if (!this.config.cookie || /[\r\n]/.test(this.config.cookie)) {
      throw new Error('未配置有效的 BILI_COOKIE');
    }
    if (!this.config.csrf || /[\r\n]/.test(this.config.csrf)) {
      throw new Error('Cookie 中缺少 bili_jct，无法安全提交需要 CSRF 的请求');
    }
  }

  async request(url, { method = 'GET', body = null, referer = LIVE_REFERER, origin = null } = {}) {
    this.ensureAuth();
    const target = new URL(url);
    const headers = {
      'User-Agent': USER_AGENT,
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.5',
      'Referer': referer,
      'Cookie': this.config.cookie,
    };
    if (origin) headers.Origin = origin;
    if (body != null) headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';

    let response;
    try {
      response = await this.fetcher(target.toString(), {
        method,
        headers,
        ...(body == null ? {} : { body: body.toString() }),
        redirect: 'manual',
        signal: AbortSignal.timeout(this.config.timeout),
      });
    } catch {
      // 不回显底层异常，避免异常文本意外带出 URL 或凭据。
      throw new Error('B站网络请求失败或超时');
    }
    if (response.status !== 200) throw new Error(`B站接口 HTTP ${response.status}`);
    let data;
    try { data = await response.json(); }
    catch { throw new Error('B站接口响应不是有效 JSON'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('B站接口响应结构无效');
    return data;
  }

  async checked(url, requestOptions = {}) {
    const data = await this.request(url, requestOptions);
    const code = apiCode(data);
    if (code !== 0) {
      const suffix = apiMessage(data);
      throw new Error(`B站接口业务失败（${code == null ? '缺少 code' : code}）${suffix ? `：${suffix}` : ''}`);
    }
    return data;
  }

  async account() {
    const response = await this.checked(`${MAIN_ORIGIN}/x/web-interface/nav`, { referer: 'https://www.bilibili.com/' });
    const data = response.data;
    if (!data || data.isLogin === false) throw new Error('B站账号未登录或 Cookie 已失效');
    const wallet = data.wallet;
    if (!wallet || wallet.coupon_balance == null) throw new Error('nav 响应中缺少 wallet.coupon_balance，拒绝把未知余额当作 0');
    return {
      mid: data.mid == null ? null : String(data.mid),
      uname: typeof data.uname === 'string' ? data.uname : null,
      couponBalanceBp: asNonNegativeInteger(wallet.coupon_balance, 'B币券余额'),
    };
  }

  async vipPrivileges() {
    const response = await this.checked(`${MAIN_ORIGIN}/x/vip/privilege/my`, { referer: VIP_REFERER });
    const list = response.data?.list;
    if (!Array.isArray(list)) throw new Error('大会员权益响应缺少 data.list');
    return list;
  }

  async claimBcoinCoupon() {
    const url = new URL(`${MAIN_ORIGIN}/x/vip/privilege/receive`);
    url.searchParams.set('type', '1');
    url.searchParams.set('csrf', this.config.csrf);
    const data = await this.request(url.toString(), {
      method: 'POST', referer: VIP_REFERER, origin: 'https://account.bilibili.com',
    });
    const code = apiCode(data);
    if (code === 0 || code === 69801) {
      return { code, message: apiMessage(data), alreadyClaimed: code === 69801 };
    }
    throw new Error(`领取 B 币券接口失败（${code == null ? '缺少 code' : code}）${apiMessage(data) ? `：${apiMessage(data)}` : ''}`);
  }

  async liveWallet() {
    const response = await this.checked(`${LIVE_ORIGIN}/xlive/web-ucenter/user/get_user_info`, {
      referer: LIVE_REFERER, origin: 'https://live.bilibili.com',
    });
    const data = response.data;
    if (!data || data.gold == null) throw new Error('直播钱包响应缺少 data.gold，无法核验电池余额');
    const goldSeeds = asNonNegativeInteger(data.gold, '直播金瓜子余额');
    return {
      goldSeeds,
      batteryEquivalent: goldSeeds / GOLD_SEEDS_PER_BATTERY,
      silverSeeds: data.silver == null ? null : asNonNegativeInteger(data.silver, '银瓜子余额'),
    };
  }

  async exchangeBcoinCoupons(couponBalanceBp) {
    if (!Number.isSafeInteger(couponBalanceBp) || couponBalanceBp <= 0) throw new Error('B币券余额无效，拒绝兑换');
    const form = new URLSearchParams({
      pay_bp: String(couponBalanceBp * GOLD_SEEDS_PER_B),
      context_id: '1',
      context_type: '11',
      goods_id: '1',
      goods_num: String(couponBalanceBp),
      csrf: this.config.csrf,
      csrf_token: this.config.csrf,
    });
    const data = await this.request(`${LIVE_ORIGIN}/xlive/revenue/v1/order/createOrder`, {
      method: 'POST', body: form, referer: LIVE_REFERER, origin: 'https://live.bilibili.com',
    });
    const code = apiCode(data);
    if (code == null) throw new Error('兑换接口响应缺少业务 code');
    return { code, message: apiMessage(data) };
  }
}

function couponClaimable(list) {
  return list.some(item => Number(item?.type) === 1 && Number(item?.state) === 0);
}

async function reconcileClaim(report, client, config, save) {
  const claim = report.claim;
  const [account, privileges] = await Promise.all([client.account(), client.vipPrivileges()]);
  claim.couponAfterBp = account.couponBalanceBp;
  claim.couponDeltaBp = account.couponBalanceBp - claim.couponBeforeBp;
  claim.stillClaimable = couponClaimable(privileges);
  claim.checkedAt = new Date().toISOString();
  if (claim.couponDeltaBp >= BCOIN_COUPON_FACE_VALUE) {
    claim.state = 'confirmed';
    claim.message = 'B币券余额增长已核实';
  } else if (claim.responseCode === 69801 && !claim.stillClaimable) {
    claim.state = 'unverified';
    claim.message = '接口提示已领取，但余额未观察到增加；不自动重复提交';
  } else if (report.attempts >= 2) {
    claim.state = 'unverified';
    claim.message = '领取请求后未能核实 B 币券余额增加；不自动重复提交';
  } else {
    claim.state = 'pending_verification';
    claim.message = '暂未观察到余额变化，将在稍后只读复核';
  }
  await save(report);
  return account;
}

async function doClaimIfNeeded(report, client, config, save) {
  if (!config.autoClaim) {
    report.claim = report.claim || { state: 'disabled', message: '自动领取已关闭' };
    return { account: await client.account(), uncertain: false };
  }

  if (['request_started', 'pending_verification'].includes(report.claim?.state)) {
    const account = await reconcileClaim(report, client, config, save);
    return { account, uncertain: report.claim.state !== 'confirmed' };
  }
  if (report.claim?.state === 'confirmed') return { account: await client.account(), uncertain: false };
  if (report.claim?.state === 'unverified') return { account: await client.account(), uncertain: true };

  const accountBefore = await client.account();
  const privileges = await client.vipPrivileges();
  if (!couponClaimable(privileges)) {
    report.claim = {
      state: 'not_available',
      couponBeforeBp: accountBefore.couponBalanceBp,
      couponAfterBp: accountBefore.couponBalanceBp,
      message: '当前没有可领取的 B 币券权益',
    };
    await save(report);
    return { account: accountBefore, uncertain: false };
  }

  // 先落盘再发请求。若 Worker 在请求期间中断，后续 alarm 只复核，不重复领取。
  report.claim = {
    state: 'request_started',
    couponBeforeBp: accountBefore.couponBalanceBp,
    expectedIncreaseBp: BCOIN_COUPON_FACE_VALUE,
    requestedAt: new Date().toISOString(),
  };
  await save(report);
  try {
    const result = await client.claimBcoinCoupon();
    report.claim.responseCode = result.code;
    report.claim.responseMessage = result.message;
  } catch (error) {
    report.claim.requestError = error.message;
  }
  const accountAfter = await reconcileClaim(report, client, config, save);
  return { account: accountAfter, uncertain: report.claim.state !== 'confirmed' };
}

function exchangeVerified(exchange, accountAfter, liveAfter) {
  const couponSpentBp = exchange.couponBeforeBp - accountAfter.couponBalanceBp;
  const goldDelta = liveAfter.goldSeeds - exchange.goldBeforeSeeds;
  return couponSpentBp >= exchange.couponBeforeBp && goldDelta >= exchange.expectedGoldDelta;
}

async function reconcileExchange(report, client, config, save) {
  const exchange = report.exchange;
  const [accountAfter, liveAfter] = await Promise.all([client.account(), client.liveWallet()]);
  exchange.couponAfterBp = accountAfter.couponBalanceBp;
  exchange.couponSpentBp = exchange.couponBeforeBp - accountAfter.couponBalanceBp;
  exchange.goldAfterSeeds = liveAfter.goldSeeds;
  exchange.goldDelta = liveAfter.goldSeeds - exchange.goldBeforeSeeds;
  exchange.batteryBefore = exchange.goldBeforeSeeds / GOLD_SEEDS_PER_BATTERY;
  exchange.batteryAfter = liveAfter.batteryEquivalent;
  exchange.batteryDelta = exchange.goldDelta / GOLD_SEEDS_PER_BATTERY;
  exchange.checkedAt = new Date().toISOString();
  if (exchangeVerified(exchange, accountAfter, liveAfter)) {
    exchange.state = 'confirmed';
    exchange.message = 'B币券已扣减，直播钱包金瓜子余额也达到预期增长';
  } else if (report.attempts >= 2) {
    exchange.state = 'unverified';
    exchange.message = '兑换结果无法由余额变化确认；为避免重复扣券，不会再次提交兑换请求';
  } else {
    exchange.state = 'pending_verification';
    exchange.message = '尚未同时确认 B 币券扣减和电池余额增长，将在稍后只读复核';
  }
  await save(report);
  return exchange.state === 'confirmed';
}

async function doExchangeIfNeeded(report, client, config, account, save) {
  if (!config.autoExchange) {
    report.exchange = report.exchange || { state: 'disabled', message: '自动兑换已关闭；仅查询/领取，不会消耗 B 币券' };
    return;
  }
  if (report.exchange?.state === 'confirmed' || report.exchange?.state === 'no_coupons' || report.exchange?.state === 'disabled') return;
  if (['request_started', 'pending_verification'].includes(report.exchange?.state)) {
    await reconcileExchange(report, client, config, save);
    return;
  }
  if (report.exchange?.state === 'unverified') {
    report.errors.push('之前的兑换结果未确认，已停止重复提交');
    return;
  }
  if (account.couponBalanceBp <= 0) {
    report.exchange = { state: 'no_coupons', couponBeforeBp: 0, message: '当前没有可兑换的 B 币券余额' };
    await save(report);
    return;
  }

  const liveBefore = await client.liveWallet();
  const couponBalanceBp = account.couponBalanceBp;
  report.exchange = {
    state: 'prepared',
    couponBeforeBp: couponBalanceBp,
    goldBeforeSeeds: liveBefore.goldSeeds,
    batteryBefore: liveBefore.batteryEquivalent,
    expectedGoldDelta: couponBalanceBp * GOLD_SEEDS_PER_B,
    expectedBatteryDelta: couponBalanceBp * GOLD_SEEDS_PER_B / GOLD_SEEDS_PER_BATTERY,
    preparedAt: new Date().toISOString(),
  };
  await save(report);

  // 在发起不可逆兑换请求之前，先持久化 request_started。
  report.exchange.state = 'request_started';
  report.exchange.requestedAt = new Date().toISOString();
  await save(report);
  try {
    const result = await client.exchangeBcoinCoupons(couponBalanceBp);
    report.exchange.responseCode = result.code;
    report.exchange.responseMessage = result.message;
  } catch (error) {
    report.exchange.requestError = error.message;
  }
  await save(report);
  if (config.settleWaitMs > 0) await client.sleeper(config.settleWaitMs);
  await reconcileExchange(report, client, config, save);
}

export async function runAttempt(report, client, config, save = async () => {}) {
  report.attempts = (report.attempts || 0) + 1;
  report.time = new Date().toISOString();
  report.errors = [];
  await save(report);

  let account;
  try {
    const result = await doClaimIfNeeded(report, client, config, save);
    account = result.account;
    report.account = { mid: account.mid, uname: account.uname, couponBalanceBp: account.couponBalanceBp };
    if (result.uncertain) {
      report.errors.push('B币券领取结果尚未确认；为避免错误消费，不执行兑换');
      report.ok = false;
      await save(report);
      return report;
    }
  } catch (error) {
    report.errors.push(`查询账号或领取 B 币券失败：${error.message}`);
    report.ok = false;
    await save(report);
    return report;
  }

  try {
    // 领取后重新查询账号余额；不得使用领取前的旧值。
    account = await client.account();
    report.account = { mid: account.mid, uname: account.uname, couponBalanceBp: account.couponBalanceBp };
    await doExchangeIfNeeded(report, client, config, account, save);
  } catch (error) {
    report.errors.push(`兑换/余额核验异常：${error.message}`);
  }

  const claimOk = !config.autoClaim || ['confirmed', 'not_available'].includes(report.claim?.state);
  const exchangeOk = !config.autoExchange || ['confirmed', 'no_coupons'].includes(report.exchange?.state);
  report.ok = claimOk && exchangeOk && report.errors.length === 0;
  await save(report);
  return report;
}

export async function readStatus(client) {
  const [account, live] = await Promise.all([client.account(), client.liveWallet()]);
  return {
    ok: true,
    account: { mid: account.mid, uname: account.uname, couponBalanceBp: account.couponBalanceBp },
    liveWallet: live,
    note: 'goldSeeds 是直播钱包接口返回的金瓜子数；按 100 金瓜子折算 1 电池展示。',
    checkedAt: new Date().toISOString(),
  };
}
