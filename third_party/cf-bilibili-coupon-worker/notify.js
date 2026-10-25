function render(value, variables) {
  if (typeof value === 'string') return value.replace(/\{\{(title|body|date|status)\}\}/g, (_, key) => variables[key]);
  if (Array.isArray(value)) return value.map(item => render(item, variables));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, render(item, variables)]));
  return value;
}

const signed = n => n >= 0 ? `+${n}` : String(n);

export function message(report) {
  const lines = [
    `日期：${report.date}（北京时间）`,
    `执行：${report.attempts === 1 ? '首次' : `${report.retryMinutes ?? 30} 分钟后只读复核`}；${report.ok ? '已核验成功' : '存在失败或待核验项目'}`,
  ];
  if (report.account) {
    lines.push(`账号：${report.account.uname || '未知'}（UID ${report.account.mid || '未知'}）`);
    lines.push(`当前 B 币券余额：${report.account.couponBalanceBp ?? '未知'} B 币`);
  }
  const claim = report.claim;
  if (claim) {
    const label = {
      confirmed: '已领取并确认余额增长',
      not_available: '当前无可领取权益',
      disabled: '已关闭',
      request_started: '请求已发出，待核验',
      pending_verification: '待核验',
      unverified: '无法确认（未重复提交）',
    }[claim.state] || claim.state;
    lines.push(`5B 币券领取：${label}`);
    if (claim.couponBeforeBp != null && claim.couponAfterBp != null) {
      lines.push(`  B 币券余额：${claim.couponBeforeBp} → ${claim.couponAfterBp}（${signed(claim.couponDeltaBp || 0)} B 币）`);
    }
    if (claim.message) lines.push(`  说明：${claim.message}`);
  }
  const exchange = report.exchange;
  if (exchange) {
    const label = {
      confirmed: '已核验成功',
      no_coupons: '无可兑换余额',
      disabled: '已关闭',
      prepared: '已准备，尚未提交',
      request_started: '请求已发出，待核验',
      pending_verification: '待核验（不会重复提交）',
      unverified: '无法确认（不会重复提交）',
    }[exchange.state] || exchange.state;
    lines.push(`兑换电池：${label}`);
    if (exchange.goldBeforeSeeds != null && exchange.goldAfterSeeds != null) {
      lines.push(`  金瓜子：${exchange.goldBeforeSeeds} → ${exchange.goldAfterSeeds}（${signed(exchange.goldDelta || 0)}）`);
      lines.push(`  电池折算：${exchange.batteryBefore} → ${exchange.batteryAfter}（${signed(exchange.batteryDelta || 0)}）`);
    }
    if (exchange.couponBeforeBp != null && exchange.couponAfterBp != null) {
      lines.push(`  B 币券余额：${exchange.couponBeforeBp} → ${exchange.couponAfterBp} B 币`);
    }
    if (exchange.expectedBatteryDelta != null) lines.push(`  预期电池增长：${exchange.expectedBatteryDelta}`);
    if (exchange.message) lines.push(`  说明：${exchange.message}`);
  }
  for (const error of report.errors || []) lines.push(`❌ ${error}`);
  return { title: `B站 B币券/电池任务${report.ok ? '成功' : '异常'} · ${report.date}`, body: lines.join('\n'), date: report.date, status: report.ok ? 'success' : 'failure' };
}

export async function notify(env, report, fetcher = fetch) {
  const raw = report.ok ? env.PUSH_SUCCESS : env.PUSH_FAILURE;
  if (!raw) return { state: 'disabled' };
  let config;
  try { config = JSON.parse(raw); } catch { throw new Error('推送配置不是有效 JSON'); }
  if (!config.url || !config.url.startsWith('https://')) throw new Error('推送需要 HTTPS URL');
  const variables = message(report);
  for (const key of Object.keys(variables)) {
    if (config.escape === 'telegram-markdown-v2') variables[key] = variables[key].replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
    else if (config.escape === 'html') variables[key] = variables[key].replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    if (config.doubleBackslash) variables[key] = variables[key].replace(/\\/g, '\\\\');
  }
  const method = (config.method || 'POST').toUpperCase();
  let response;
  try {
    response = await fetcher(config.url, {
      method,
      headers: render({ 'Content-Type': 'application/json', ...config.headers }, variables),
      ...(method === 'GET' || method === 'HEAD' ? {} : { body: JSON.stringify(render(config.body ?? { title: '{{title}}', body: '{{body}}' }, variables)) }),
      redirect: 'manual', signal: AbortSignal.timeout(15000),
    });
  } catch { throw new Error('推送网络失败'); }
  if (!response.ok) throw new Error(`推送 HTTP ${response.status}`);
  if (config.successField) {
    let data;
    try { data = await response.json(); } catch { throw new Error('推送响应不是 JSON'); }
    const value = config.successField.split('.').reduce((obj, part) => obj?.[part], data);
    if (value !== config.successValue) throw new Error('推送服务业务状态未成功');
  }
  return { state: 'sent', time: new Date().toISOString() };
}
