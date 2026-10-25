import type {Env,JobRecord,QueueItem} from './types.ts';
import {nextSchedule,scheduleWindow} from './time.ts';
import {jsonSafeParse} from './response.ts';
import {deliverNotification,routeEvent} from '../providers/notify.ts';
import {setting,setSetting} from './db.ts';
import {maintenance} from './maintenance.ts';
import {queueRunBatch,type RunSpec} from './run-batch.ts';
const PAGE=2,OUTBOX_PAGE=8;
// A run and its queue intent must commit atomically, including quota checks.
export async function queueRun(env:Env,job:JobRecord,windowKey:string,manual=false,at=Date.now()):Promise<string>{
 return (await queueRunBatch(env,[{job,windowKey,manual,at}],{publish:manual}))[0];
}
export async function publishOutbox(env:Env,referenceId?:string):Promise<number>{
 const now=Date.now(),token=crypto.randomUUID();
 const rows=await env.DB.prepare(`UPDATE outbox SET status='sending',lease_token=?,lease_until=?,attempts=attempts+1
 WHERE id IN (SELECT id FROM outbox WHERE (status='pending' OR (status='sending' AND lease_until<?))
 AND next_attempt_at<=? AND (? IS NULL OR ref_id=?) ORDER BY next_attempt_at,id LIMIT ?)
 RETURNING id,payload_json`).bind(token,now+60000,now,now,referenceId??null,referenceId??null,OUTBOX_PAGE).all<any>();
 if(!rows.results.length)return 0;
 try{
  await env.TASK_QUEUE.sendBatch(rows.results.map(r=>({body:JSON.parse(r.payload_json)})));
  // A consumer may already have rescheduled a notification. Do not overwrite it.
  await env.DB.prepare("UPDATE outbox SET status='sent',lease_token=NULL,lease_until=NULL,updated_at=? WHERE lease_token=? AND status='sending'").bind(Date.now(),token).run();
  return rows.results.length;
 }catch{
  await env.DB.prepare("UPDATE outbox SET status='pending',lease_token=NULL,lease_until=NULL,next_attempt_at=?,updated_at=? WHERE lease_token=? AND status='sending'").bind(Date.now()+60000,Date.now(),token).run();return 0;
 }
}
export async function scheduledTick(env:Env):Promise<{scheduled:number;published:number}>{
 if(env.BACKGROUND_PAUSED==='true')return {scheduled:0,published:0};
 const now=Date.now();await setSetting(env,'scheduler_heartbeat',now);
 if(env.MAINTENANCE_MODE==='true'||await setting(env,'maintenance',false))return {scheduled:0,published:0};
 const flags=await setting<any>(env,'modules_enabled',{'baidu-netdisk':true,'bilibili-vip':true});
 // A module switched off by the administrator must never run, even if a user already configured it.
 const disabled=Object.keys(flags||{}).filter(key=>flags[key]===false);
 // A bounded page per invocation, then a separate queue invocation for the next
 // page. This avoids stacking all tenants into a single Free-tier CPU budget.
 const rows=await env.DB.prepare(`SELECT * FROM (
 SELECT j.*,a.module_id module_id,ROW_NUMBER() OVER(PARTITION BY j.owner_user_id ORDER BY j.next_run_at,j.id) AS tenant_rank
 FROM jobs j JOIN accounts a ON a.id=j.account_id JOIN users u ON u.id=j.owner_user_id
 WHERE j.enabled=1 AND a.enabled=1 AND a.identity_verified_at IS NOT NULL AND u.status='active' AND j.next_run_at<=?${disabled.length?` AND a.module_id NOT IN (${disabled.map(()=>'?').join(',')})`:''}
 ) ORDER BY tenant_rank,next_run_at,id LIMIT ?`).bind(now,...disabled,PAGE).all<JobRecord>();
 let scheduled=0;const processed=new Set<string>();
 for(const job of rows.results){
  if(processed.has(job.id))continue;
  const s=jsonSafeParse<any>(job.schedule_json,null),at=job.next_run_at!;
  const specs:RunSpec[]=[];
  const advance:JobRecord[]=[job];
  try{
   specs.push({job,windowKey:scheduleWindow(s,at),at});
   // A platform's same-time claim/exchange pair is one atomic scheduling unit.
   // This remains correct even when exchange's random UUID sorts first.
   if(job.task_key==='bili.vip_claim'||job.task_key==='bili.exchange'){
    const other=await env.DB.prepare('SELECT * FROM jobs WHERE account_id=? AND owner_user_id=? AND task_key=? AND enabled=1 AND schedule_json=?').bind(job.account_id,job.owner_user_id,job.task_key==='bili.exchange'?'bili.vip_claim':'bili.exchange',job.schedule_json).first<JobRecord>();
    if(other&&(job.task_key==='bili.exchange'||(other.next_run_at!==null&&other.next_run_at<=at))){
     const otherWindow=scheduleWindow(s,at);
     const existing=await env.DB.prepare('SELECT id FROM job_runs WHERE job_id=? AND window_key=?').bind(other.id,otherWindow).first();
     if(job.task_key==='bili.exchange')specs[0].dependsOn={jobId:other.id,windowKey:otherWindow};
     if(!existing){specs.push({job:other,windowKey:otherWindow,at});advance.push(other);}
    }
   }
   const next=nextSchedule(s,Math.max(now,at));
   await queueRunBatch(env,specs,{after:advance.map(j=>env.DB.prepare('UPDATE jobs SET next_run_at=? WHERE id=? AND next_run_at=?').bind(next,j.id,j.next_run_at))});
   for(const j of advance)processed.add(j.id);
   scheduled+=advance.length;
  }catch(error){
   const message=error instanceof Error?error.message:'';
   // A depleted day budget is not a transient outage; avoid rechecking it every
   // 15 minutes for the rest of the day. Other failures keep bounded backoff.
   const retryAt=/automatic_run_limit|platform_run_limit/.test(message)?(Math.floor(now/86400000)+1)*86400000:now+900000;
   await env.DB.batch(advance.map(j=>env.DB.prepare('UPDATE jobs SET next_run_at=? WHERE id=? AND next_run_at=?').bind(retryAt,j.id,j.next_run_at)));
   for(const j of advance)processed.add(j.id);
  }
 }
 const events=await env.DB.prepare('SELECT id FROM job_events WHERE routed_at IS NULL ORDER BY created_at LIMIT 2').all<any>();
 for(const ev of events.results)await routeEvent(env,ev.id);
 const published=await publishOutbox(env);
 if(scheduled>=PAGE||events.results.length===2||published===OUTBOX_PAGE){
  await env.TASK_QUEUE.send({kind:'dispatch',id:crypto.randomUUID()},{delaySeconds:5});
 }
 return {scheduled,published};
}
export async function consumeMessage(env:Env,message:QueueItem):Promise<void>{
 if(!message||typeof message.id!=='string'||message.id.length>128)throw new Error('Invalid queue message');
 if(message.kind==='dispatch'){await scheduledTick(env);return;}
 if(message.kind==='maintenance'){await maintenance(env);return;}
 if(message.kind==='run'){
  const row=await env.DB.prepare('SELECT r.id,r.status,a.fingerprint,a.module_id module_id,u.status user_status FROM job_runs r JOIN jobs j ON j.id=r.job_id JOIN accounts a ON a.id=j.account_id JOIN users u ON u.id=r.owner_user_id WHERE r.id=?').bind(message.id).first<any>();
  if(!row||['succeeded','failed','already_done','waiting_verification','canceled'].includes(row.status))return;
  const flags=await setting<any>(env,'modules_enabled',{'baidu-netdisk':true,'bilibili-vip':true});
  if(flags?.[row.module_id]===false){
   if(row.status==='running'||row.status==='waiting_retry')return;
   await env.DB.prepare("UPDATE job_runs SET status='canceled',finished_at=? WHERE id=? AND status IN ('scheduled','queued')").bind(Date.now(),message.id).run();return;
  }
  if(row.user_status!=='active'){
   if(row.status==='running'||row.status==='waiting_retry')return; // preserve unresolved state
   await env.DB.prepare("UPDATE job_runs SET status='canceled',finished_at=? WHERE id=? AND status IN ('scheduled','queued')").bind(Date.now(),message.id).run();return;
  }
  if(env.MAINTENANCE_MODE==='true'||await setting(env,'maintenance',false)){
   await env.DB.prepare("UPDATE outbox SET status='pending',lease_token=NULL,next_attempt_at=? WHERE kind='run' AND ref_id=?").bind(Date.now()+300000,message.id).run();return;
  }
  const response=await env.ACCOUNTS.get(env.ACCOUNTS.idFromName('account:'+row.fingerprint)).fetch('https://internal/run',{method:'POST',body:JSON.stringify({runId:message.id})});
  if(!response.ok)throw new Error('Account coordinator unavailable');return;
 }
 if(message.kind==='notify'){await deliverNotification(env,message.id);return;}
 throw new Error('Unknown queue message type');
}
export async function deadLetter(env:Env,message:QueueItem){
 if(message.kind==='run'){
  const r=await env.DB.prepare('SELECT id,owner_user_id,status FROM job_runs WHERE id=?').bind(message.id).first<any>();
  if(r&&!['succeeded','already_done','failed','canceled','waiting_verification'].includes(r.status)){
   const status=['running','waiting_retry'].includes(r.status)?'waiting_verification':'failed';
   await env.DB.batch([
    env.DB.prepare('UPDATE job_runs SET status=?,finished_at=?,error_code=? WHERE id=? AND status=?').bind(status,Date.now(),'QUEUE_EXHAUSTED',r.id,r.status),
    env.DB.prepare("INSERT OR IGNORE INTO job_events(id,owner_user_id,run_id,event_type,summary,created_at) SELECT ?,owner_user_id,id,'exception','Queue retries exhausted; review required',? FROM job_runs WHERE id=? AND error_code='QUEUE_EXHAUSTED'").bind(crypto.randomUUID(),Date.now(),r.id),
   ]);
  }
 }else if(message.kind==='notify')await env.DB.prepare("UPDATE notification_deliveries SET status='failed',last_error='QUEUE_EXHAUSTED' WHERE id=? AND status<>'delivered'").bind(message.id).run();
 await env.DB.prepare("UPDATE outbox SET status='dead',lease_token=NULL WHERE kind=? AND ref_id=?").bind(message.kind,message.id).run();
}
