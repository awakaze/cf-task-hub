export type NotificationPolicy={
  success_enabled:boolean; exception_enabled:boolean; success_channels:string[];
  error_mode:'same'|'custom'; exception_channels:string[];
};
export const DEFAULT_POLICY:NotificationPolicy={success_enabled:true,exception_enabled:true,success_channels:[],error_mode:'same',exception_channels:[]};
export function routeChannels(policy:NotificationPolicy, event:'success'|'exception'):string[] {
  if(event==='success'&&!policy.success_enabled) return [];
  if(event==='exception'&&!policy.exception_enabled) return [];
  const channels=event==='exception' && policy.error_mode==='custom' ? policy.exception_channels:policy.success_channels;
  return [...new Set(channels.filter(s=>typeof s==='string'))];
}
export function validateWebhookTarget(input:string,approved:string[]):URL {
  let u:URL;try{u=new URL(input);}catch{throw new Error('Webhook 地址无效');}
  if(u.protocol!=='https:'||u.port&&u.port!=='443'||u.username||u.password||u.hash)throw new Error('只接受 HTTPS 443 端口的 Webhook 地址');
  const hostname=u.hostname.toLowerCase().replace(/\.$/,'');
  if(!/^[a-z0-9.-]+$/.test(hostname)||!hostname.includes('.')||hostname.endsWith('.localhost')||hostname.endsWith('.local')||hostname.endsWith('.internal'))throw new Error('不允许的 Webhook 主机名');
  if(/^\d+\.\d+\.\d+\.\d+$/.test(hostname)||hostname.includes('..')||hostname==='localhost')throw new Error('不允许直接使用 IP 或本地主机');
  if(['api.cloudflare.com','dash.cloudflare.com','cloudflare-dns.com','metadata.google.internal'].includes(hostname))throw new Error('Cloudflare or metadata control-plane targets are not allowed');
  if(!approved.map(s=>s.toLowerCase().trim()).includes(hostname))throw new Error('Webhook 域名尚未获得管理员批准');
  return u;
}
export function safeSummary(s:string):string {return s.replace(/[\r\n\t]/g,' ').slice(0,300);}
const MODULE_TITLES:Record<string,string>={'baidu-netdisk':'百度网盘签到','bilibili-vip':'B站大会员签到'};
const TASK_TITLES:Record<string,string>={'baidu.daily':'PC / App 签到及累计奖励','bili.vip_claim':'每日检查 / 领取 5B 币券','bili.exchange':'兑换直播电池'};
const STEP_STATES:Record<string,string>={signed:'已完成',already_signed:'今日已签到',claimed:'已领取',already_claimed:'已领取'};
function signed(value:number){return value>0?`+${value}`:String(value);}
function beijingTime(ts:number){return new Date(ts+8*3600000).toISOString().slice(0,16).replace('T',' ');}
// The run report already holds the verified growth values, so the notification can
// carry the same evidence the UI shows instead of a generic one-line result.
function detailLines(moduleId:string|undefined,report:any,summary:string):string[]{
 const fallback=[`结果：${safeSummary(summary)}`];
 if(moduleId!=='baidu-netdisk'||!report||typeof report!=='object')return fallback;
 const lines:string[]=[];
 if(typeof report.date==='string'&&report.date)lines.push(`日期：${report.date}（北京时间）`);
 const attempts=Number(report.attempts||1);
 lines.push(`执行：${attempts<=1?'首次':`第 ${attempts} 次`}；${report.ok?'全部成功':'部分异常'}`);
 for(const step of Array.isArray(report.steps)?report.steps:[]){
  if(!step||typeof step!=='object'||(step.id!=='pc'&&step.id!=='app'))continue;
  lines.push(`${step.ok?'✅':'❌'} ${String(step.label||step.id)}：${step.ok?STEP_STATES[String(step.state)]||'已完成':'失败'}`);
  const before=Number(step.before),after=Number(step.after);
  if(Number.isFinite(before)&&Number.isFinite(after))lines.push(`  成长值：${before} → ${after}（${signed(after-before)}）`);
  if(!step.ok&&step.message)lines.push(`  原因：${safeSummary(String(step.message))}`);
 }
 const awards=report.awards;
 if(awards&&typeof awards==='object'){
  if(Number.isFinite(Number(awards.signinDays)))lines.push(`本周期累计签到：${Number(awards.signinDays)} 天`);
  if(Number.isFinite(Number(awards.nextDay)))lines.push(`下一档累计 ${Number(awards.nextDay)} 天奖励：还需签到 ${Number(awards.remainingDays)||0} 天`);
  else lines.push('累计奖励：已全部达成');
 }
 const current=Number(report.finalGrowth),initial=Number(report.initialGrowth);
 if(Number.isFinite(current))lines.push(`当前成长值：${current}`);
 if(Number.isFinite(current)&&Number.isFinite(initial))lines.push(`本轮余额变化：${initial} → ${current}（${signed(current-initial)}）`);
 const errors=Array.isArray(report.errors)?report.errors.filter((item:unknown)=>typeof item==='string'):[];
 if(errors.length)lines.push(`备注：${errors.join('；')}`);
 return lines.length?lines:fallback;
}
export function notificationText(e:{event_type:string;summary:string;module_id?:string;account_label?:string;task_key?:string;created_at:number;run_url?:string;report?:unknown}):{title:string;text:string} {
 const ok=e.event_type==='success'||e.event_type==='info';
 const title=`${MODULE_TITLES[e.module_id||'']||'CF Task Hub'} · ${ok?'执行成功':'任务异常'}`;
 const lines:string[]=[];
 if(e.account_label)lines.push(`账号：${e.account_label}`);
 if(e.task_key)lines.push(`任务：${TASK_TITLES[e.task_key]||e.task_key}`);
 lines.push(...detailLines(e.module_id,e.report,e.summary));
 lines.push(`时间：${beijingTime(e.created_at)}（北京时间）`);
 if(e.run_url)lines.push(e.run_url);
 return {title,text:lines.join('\n')};
}
export function isPublicAddress(address:string):boolean{
 if(/^\d+\.\d+\.\d+\.\d+$/.test(address)){
  const [a,b,c,d]=address.split('.').map(Number);
  if([a,b,c,d].some(n=>n<0||n>255))return false;
  return !(a===0||a===10||a===127||a>=224||(a===100&&b>=64&&b<=127)||
   (a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&(b===168||b===0))||
   (a===198&&(b===18||b===19||(b===51&&c===100)))||(a===203&&b===0&&c===113));
 }
 const lower=address.toLowerCase();
 // Conservative: only native global-unicast IPv6, not mapped/transition ranges.
 if(!/^[23][0-9a-f]{3}:/.test(lower)||!/^[0-9a-f:]+$/.test(lower))return false;
 if(lower.startsWith('2001:db8:')||lower.startsWith('2001:0:')||lower.startsWith('2002:'))return false;
 const halves=lower.split('::');if(halves.length>2)return false;
 const groups=halves.flatMap(h=>h?h.split(':'):[]);
 return groups.every(g=>/^[0-9a-f]{1,4}$/.test(g))&&(halves.length===2?groups.length<8:groups.length===8);
}
export async function validateWebhookDns(input:string,approved:string[],fetcher:typeof fetch=fetch):Promise<void>{
 const u=validateWebhookTarget(input,approved);
 const responses=await Promise.all(['A','AAAA'].map(async type=>{
  const r=await fetcher(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(u.hostname)}&type=${type}`,{headers:{Accept:'application/dns-json'},redirect:'manual',signal:AbortSignal.timeout(5000)});
  if(r.status!==200)throw new Error('Webhook DNS check failed');
  const {boundedJson}=await import('./network.ts');return boundedJson(r,16384);
 }));
 const addresses=responses.flatMap(r=>{
  if(r.Status!==0)throw new Error('Webhook DNS response unavailable');
  return (r.Answer||[]).filter((a:any)=>a.type===1||a.type===28).map((a:any)=>a.data);
 });
 if(!addresses.length||addresses.some(a=>typeof a!=='string'||!isPublicAddress(a)))throw new Error('Webhook resolves to a non-public or unverifiable address');
 // DNS preflight is NOT address pinning. Only administrator-trusted domains are
 // allowed: a malicious allowed domain could still rebind before fetch connects.
}
