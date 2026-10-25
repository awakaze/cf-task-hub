import {BaiduClient,runAttempt,options,readStatus,beijingDate} from './original-core.js';
import type {TaskResult} from '../../core/types.ts';
export const baiduManifest={id:'baidu-netdisk',title:'百度网盘签到',tasks:[{key:'baidu.daily',title:'PC / App 签到及累计奖励',risk:'stateful'}],defaults:{enable_pc:true,enable_app:true,enable_awards:true,timeout_ms:15000,retry_minutes:30}};
export function baiduConfig(credentials:Record<string,unknown>,setting:Record<string,unknown>){
 return options({BAIDU_COOKIE:String(credentials.cookie||''),BAIDU_CUID:String(credentials.cuid||''),BAIDU_HEADERS:JSON.stringify(credentials.headers||{}),ENABLE_PC:setting.enable_pc===false?'false':'true',ENABLE_APP:setting.enable_app===false?'false':'true',ENABLE_AWARDS:setting.enable_awards===false?'false':'true',TIMEOUT_MS:setting.timeout_ms||15000,RETRY_MINUTES:setting.retry_minutes||30});
}
export async function executeBaidu(ctx:{credentials:Record<string,unknown>;settings:Record<string,unknown>;load:()=>Promise<any>;save:(r:any)=>Promise<void>;fetcher?:typeof fetch}):Promise<TaskResult> {
 const config=baiduConfig(ctx.credentials,ctx.settings);const report=await ctx.load()??{date:beijingDate(),attempts:0,steps:[],errors:[],ok:false};
 const client=new BaiduClient(config,ctx.fetcher||fetch);
 if(report.attempts>=2&&!report.ok) return {status:'waiting_verification',summary:'签到此前已经两次尝试，请手动核对',details:{report}};
 await runAttempt(report,client,config,()=>ctx.save(report));await ctx.save(report);
 return {status:report.ok?(report.steps.length>0&&report.steps.every((s:any)=>['already_signed','already_claimed'].includes(s.state))?'already_done':'succeeded'):'failed',summary:report.ok?'PC / App 签到及奖励流程完成':'百度签到部分操作失败或待复核',details:{report}};
}
export async function probeBaidu(credentials:Record<string,unknown>,setting:Record<string,unknown>){const config=baiduConfig(credentials,setting);return readStatus(new BaiduClient(config),config);}

// Only the read-only membership query and signinlist endpoints are used here.
// Current App/award state can confirm today's goal, while an uncertain PC
// request cannot be inferred from unrelated growth changes.
export async function reconcileBaidu(ctx:{credentials:Record<string,unknown>;settings:Record<string,unknown>;load:()=>Promise<any>;save:(r:any)=>Promise<void>;fetcher?:typeof fetch}):Promise<TaskResult>{
 const report=await ctx.load();
 if(!report)return {status:'waiting_verification',summary:'缺少持久检查点，请管理员核对上游记录后结案；不会重发签到或领奖请求'};
 const config=baiduConfig(ctx.credentials,ctx.settings),client=new BaiduClient(config,ctx.fetcher||fetch);
 report.attempts=Math.max(2,Number(report.attempts||0));
 try{
  const steps=Array.isArray(report.steps)?report.steps:[],today=report.date===beijingDate();
  const enabled={pc:report.enabled?.pc??(config.pc||steps.some((s:any)=>s.id==='pc')),app:report.enabled?.app??(config.app||steps.some((s:any)=>s.id==='app')),awards:report.enabled?.awards??(config.awards||steps.some((s:any)=>String(s.id).startsWith('award-')))};
  const observed=await readStatus(client,{...config,...enabled});
  const confirmed=(id:string)=>steps.some((s:any)=>s.id===id&&s.phase==='operation_confirmed'&&['signed','already_signed','claimed','already_claimed'].includes(s.state));
  const checks:Record<string,boolean>={};
  if(enabled.pc)checks.pc=confirmed('pc');
  if(enabled.app)checks.app=confirmed('app')||today&&observed.awards?.signedToday===true;
  if(enabled.awards){
   const previous=(report.awards?.claimable||[]).map((tier:any)=>Number(tier.day));
   const days=[...new Set<number>([...previous,...steps.filter((s:any)=>String(s.id).startsWith('award-')).map((s:any)=>Number(String(s.id).slice(6)))])];
   const verifiedDays=days.every(day=>confirmed('award-'+day)||today&&observed.awards?.tiers.some((tier:any)=>tier.day===day&&tier.received>=tier.count));
   checks.awards=verifiedDays&&today&&observed.awards!==null&&observed.awards.claimable.length===0;
  }
  report.reconciliation={readOnly:true,checkedAt:new Date().toISOString(),sameBeijingDay:today,checks,observed};
  report.ok=Object.keys(checks).length>0&&Object.values(checks).every(Boolean);
  await ctx.save(report);
  return {status:report.ok?'succeeded':'waiting_verification',summary:report.ok?'只读状态核验完成；未重新发送签到或领奖请求':'只读检查仍不足以确认全部操作，请管理员核对上游记录后结案',details:{report}};
 }catch{
  report.reconciliation={readOnly:true,checkedAt:new Date().toISOString(),available:false};await ctx.save(report);
  return {status:'waiting_verification',summary:'只读核验暂不可用；请更新凭据后重试核验，或由管理员核对上游记录后结案',details:{report}};
 }
}
