import {BiliClient,runAttempt,options,readStatus,reconcileClaim,reconcileExchange,beijingDate} from './original-core.js';
import type {TaskResult} from '../../core/types.ts';
export const bilibiliManifest={id:'bilibili-vip',title:'B站大会员权益',tasks:[{key:'bili.vip_claim',title:'每日检查 / 领取 5B 币券',risk:'stateful'},{key:'bili.exchange',title:'兑换直播电池',risk:'non_idempotent'}],defaults:{timeout_ms:15000,retry_minutes:30,settle_wait_ms:1200}};
function config(credentials:Record<string,unknown>,settings:Record<string,unknown>,taskKey:string){return options({BILI_COOKIE:String(credentials.cookie||''),BILI_MAX_EXCHANGE_BP:settings.max_exchange_bp??5,BILI_AUTO_CLAIM:taskKey==='bili.vip_claim'?'true':'false',BILI_AUTO_EXCHANGE:taskKey==='bili.exchange'?'true':'false',TIMEOUT_MS:settings.timeout_ms||15000,RETRY_MINUTES:settings.retry_minutes||30,SETTLE_WAIT_MS:settings.settle_wait_ms??1200});}
export async function executeBili(ctx:{taskKey:string;credentials:Record<string,unknown>;settings:Record<string,unknown>;load:()=>Promise<any>;save:(r:any)=>Promise<void>;fetcher?:typeof fetch}):Promise<TaskResult>{
 const cfg=config(ctx.credentials,ctx.settings,ctx.taskKey);
 const client=new BiliClient(cfg,ctx.fetcher||fetch);
 const report=await ctx.load()??{date:beijingDate(),attempts:0,steps:[],errors:[],ok:false};
 // The original code only rechecks state after requests with an incomplete outcome.
 // Never call a second time with a fresh report for the same non-idempotent operation.
 if(report.attempts>=2&&!report.ok) return {status:'waiting_verification',summary:'已达到只读复核次数上限，禁止重新兑换',details:{report}};
 await runAttempt(report,client,cfg,()=>ctx.save(report));await ctx.save(report);
 const claimState=report.claim?.state,exchangeState=report.exchange?.state;
 const pending=ctx.taskKey==='bili.exchange'?['request_started','pending_verification','unverified'].includes(exchangeState):['request_started','pending_verification','unverified'].includes(claimState);
 return {status:pending?'waiting_verification':report.ok?(ctx.taskKey==='bili.vip_claim'&&claimState==='not_available'||ctx.taskKey==='bili.exchange'&&exchangeState==='no_coupons'?'already_done':'succeeded'):'failed',summary:pending?'权益或电池余额未能核实，已暂停重复提交':report.ok?'B站权益任务完成':'B站权益任务存在异常',details:{report}};
}
export async function probeBili(credentials:Record<string,unknown>,settings:Record<string,unknown>){return readStatus(new BiliClient(config(credentials,settings,'bili.vip_claim')));}

export async function reconcileBili(ctx:{taskKey:string;credentials:Record<string,unknown>;settings:Record<string,unknown>;load:()=>Promise<any>;save:(r:any)=>Promise<void>;fetcher?:typeof fetch}):Promise<TaskResult>{
 const report=await ctx.load();
 if(!report) return {status:'waiting_verification',summary:'No persisted checkpoint; cannot safely reconstruct an asset operation'};
 const cfg=config(ctx.credentials,ctx.settings,ctx.taskKey),client=new BiliClient(cfg,ctx.fetcher||fetch);
 // This path deliberately never calls runAttempt(), claimBcoinCoupon() or exchangeBcoinCoupons().
 report.attempts=Math.max(2,Number(report.attempts||0));
 try{
  if(ctx.taskKey==='bili.exchange'&&report.exchange?.requestedAt){
   await reconcileExchange(report,client,cfg,()=>ctx.save(report));
   report.ok=report.exchange.state==='confirmed';
  }else if(ctx.taskKey==='bili.vip_claim'&&report.claim?.requestedAt){
   await reconcileClaim(report,client,cfg,()=>ctx.save(report));report.ok=report.claim.state==='confirmed';
  }else return {status:'waiting_verification',summary:'No submitted-operation checkpoint; manual platform review required'};
  await ctx.save(report);
  return {status:report.ok?'succeeded':'waiting_verification',summary:report.ok?'Exact balance change observed (balance-only evidence)':'Balance still not matched; no new transaction submitted',details:{report}};
 }catch{return {status:'waiting_verification',summary:'Read-only reconciliation unavailable; no new transaction submitted',details:{report}};}
}
