import { BiliClient, beijingDate, options, readStatus, runAttempt } from './core.js';
import { notify } from './notify.js';

const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });

export class BiliTaskCoordinator {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.queue = Promise.resolve(); }
  async exclusive(fn) {
    const task = this.queue.then(fn);
    this.queue = task.catch(() => {});
    return task;
  }
  async fetch(request) {
    return this.exclusive(async () => {
      const path = new URL(request.url).pathname;
      const config = options(this.env);
      if (path === '/status') {
        try { return json(await readStatus(new BiliClient(config))); }
        catch (error) { return json({ ok: false, error: error.message }, 502); }
      }
      if (path === '/report') return json(await this.ctx.storage.get('report') ?? { state: 'not_run' });
      if (path === '/notify' && request.method === 'POST') {
        const report = await this.ctx.storage.get('report');
        if (!report || report.phase !== 'complete') return json({ error: '没有可补发的已完成报告' }, 409);
        if (report.notification?.state === 'failed') await this.deliver(report);
        return json(report);
      }
      if (path !== '/run' || request.method !== 'POST') return json({ error: 'Not found' }, 404);
      const date = beijingDate();
      let report = await this.ctx.storage.get('report');
      if (report?.date === date) return json(report);
      report = { date, attempts: 0, retryMinutes: config.retryMinutes, steps: [], errors: [], ok: false, phase: 'running' };
      await this.ctx.storage.put('report', report);
      await this.execute(report, config);
      return json(report);
    });
  }
  async execute(report, config) {
    const due = Date.now() + config.retryMinutes * 60000;
    await this.ctx.storage.setAlarm(due);
    report.retryAt = new Date(due).toISOString();
    await this.ctx.storage.put('report', report);
    try {
      await runAttempt(report, new BiliClient(config), config, r => this.ctx.storage.put('report', r));
    } catch {
      report.ok = false;
      report.errors.push('执行出现内部异常；为避免重复消费，未自动重放不确定的兑换请求');
    }
    if (report.ok || report.attempts >= 2) {
      report.phase = 'complete';
      await this.ctx.storage.put('report', report);
      await this.deliver(report);
    } else {
      report.phase = 'waiting_retry';
      await this.ctx.storage.put('report', report);
    }
  }
  async deliver(report) {
    if (report.notification?.state === 'sent' || report.notification?.state === 'disabled') {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const tries = (report.notification?.attempts || 0) + 1;
    try {
      report.notification = { ...await notify(this.env, report), attempts: tries };
      await this.ctx.storage.deleteAlarm();
      delete report.retryAt;
    } catch (error) {
      report.notification = { state: 'failed', message: error.message, attempts: tries };
      if (tries < 2) await this.ctx.storage.setAlarm(Date.now() + options(this.env).retryMinutes * 60000);
      else await this.ctx.storage.deleteAlarm();
    }
    await this.ctx.storage.put('report', report);
  }
  async alarm() {
    return this.exclusive(async () => {
      const report = await this.ctx.storage.get('report');
      if (!report || report.date !== beijingDate()) {
        await this.ctx.storage.deleteAlarm();
        return;
      }
      if (report.phase === 'complete') await this.deliver(report);
      else if (report.attempts < 2) await this.execute(report, options(this.env));
      else {
        report.ok = false;
        report.phase = 'complete';
        report.errors.push('复核中断，兑换结果可能仍未确认；未自动重复提交');
        await this.deliver(report);
      }
    });
  }
}

export default {
  async scheduled(event, env, ctx) {
    const stub = env.BILI_TASK.get(env.BILI_TASK.idFromName('daily'));
    ctx.waitUntil(stub.fetch(new Request('https://internal/run', { method: 'POST' })).then(response => {
      if (!response.ok) throw new Error(`调度失败 HTTP ${response.status}`);
    }));
  },
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/health' && request.method === 'GET') return json({ service: 'cf-bilibili-coupon-worker', ok: true });
    if (!env.ADMIN_TOKEN || request.headers.get('Authorization') !== `Bearer ${env.ADMIN_TOKEN}`) return json({ error: 'Unauthorized' }, 401);
    if (!['/status', '/report', '/run', '/notify'].includes(path)) return json({ error: 'Not found' }, 404);
    const isWrite = path === '/run' || path === '/notify';
    if ((isWrite && request.method !== 'POST') || (!isWrite && request.method !== 'GET')) return json({ error: 'Method not allowed' }, 405);
    try {
      const stub = env.BILI_TASK.get(env.BILI_TASK.idFromName('daily'));
      return await stub.fetch(new Request(`https://internal${path}`, { method: request.method }));
    } catch { return json({ error: '执行失败，请检查配置或稍后重试' }, 500); }
  },
};
