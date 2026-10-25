import {moduleDefinition} from '../core/registry.ts';
import {decryptConfig} from '../core/secrets.ts';
import type {Env,TaskResult} from '../core/types.ts';
import {jsonSafeParse} from '../core/response.ts';
import {setting} from '../core/db.ts';
import {sanitizeReport} from '../core/safety.ts';
import {verifiedIdentity,SessionExpiredError} from '../core/identity.ts';
function submitted(report:any):boolean{return !!(report?.exchange?.requestedAt||report?.claim?.requestedAt||report?.steps?.some((s:any)=>['before_operation','operation_confirmed'].includes(s.phase)));}
const EVIDENCE_RETENTION=365*86400000;
function evidenceKey(kind:'report'|'settlement',expiresAt:number,id:string){return kind+'-expiry:'+String(expiresAt).padStart(16,'0')+':'+id;}
function expiryKey(expiresAt:number,key:string){return 'rate-expiry:'+String(expiresAt).padStart(16,'0')+':'+key;}
export class AccountCoordinator implements DurableObject{
 private tail:Promise<unknown>=Promise.resolve();
 private state:DurableObjectState;private env:Env;
 constructor(state:DurableObjectState,env:Env){this.state=state;this.env=env;}
 private exclusive<T>(fn:()=>Promise<T>):Promise<T>{const r=this.tail.then(fn);this.tail=r.catch(()=>{});return r;}
 async fetch(req:Request):Promise<Response>{return this.exclusive(async()=>{
  const path=new URL(req.url).pathname;
  if(path!=='/rate'&&await this.state.storage.get('evidence-index-version')!==1)await this.alarmNoLater(Date.now()+1000);
  if(path==='/rate'){
   const x:any=await req.json();
   if(typeof x.key!=='string'||x.key.length>240||!Number.isInteger(x.limit)||x.limit<1||x.limit>100000||!Number.isInteger(x.windowMs)||x.windowMs<1000||x.windowMs>86400000)return new Response('',{status:400});
   const now=Date.now(),key='rate:'+x.key,bucket=Math.floor(now/x.windowMs),expiresAt=(bucket+1)*x.windowMs;
   const old=await this.state.storage.get<any>(key),count=old?.bucket===bucket?old.count:0;
   if(count>=x.limit)return Response.json({allowed:false},{status:429});
   const records:Record<string,unknown>={[key]:{bucket,count:count+1,expiresAt}};
   if(old?.expiresAt!==expiresAt)records[expiryKey(expiresAt,key)]={key,expiresAt};
   await this.state.storage.put(records);
   if(old?.expiresAt&&old.expiresAt!==expiresAt)await this.state.storage.delete(expiryKey(old.expiresAt,key));
   const alarm=await this.state.storage.getAlarm(),due=Math.min(expiresAt,now+3600000);
   // Never postpone an already armed cleanup when another IP visits the site.
   if(alarm===null||due<alarm)await this.state.storage.setAlarm(Math.max(now+1000,due));
   return Response.json({allowed:true});
  }
  if(path==='/purge'){
   const data:any=await req.json();
   if(data.confirm!==true)return new Response('',{status:400});
   const pending=await this.state.storage.get<any>('bili_pending_exchange');
   if(pending)return Response.json({ok:false,error:'UNRESOLVED_ASSET'},{status:409});
   // waiting_retry can already contain a submitted external operation. Never
   // erase its checkpoint just because it has not reached manual review yet.
   const reports=await this.state.storage.list<any>({prefix:'report:',limit:1000});
   for(const [key,report] of reports){
    const id=key.slice(7),settlement=await this.state.storage.get<any>('settlement:'+id);
    if(settlement){const resolved=await this.env.DB.prepare('SELECT run_id FROM manual_resolutions WHERE run_id=?').bind(id).first();if(resolved)continue;return Response.json({ok:false,error:'RESOLUTION_INCOMPLETE'},{status:409});}
    const run=await this.env.DB.prepare('SELECT status FROM job_runs WHERE id=?').bind(id).first<any>();
    if(run&&['succeeded','already_done','failed','canceled'].includes(run.status))continue;
    if(submitted(report)||run&&['running','waiting_retry','waiting_verification'].includes(run.status))return Response.json({ok:false,error:'UNRESOLVED_OPERATION'},{status:409});
   }
   if(reports.size===1000)return Response.json({ok:false,error:'REVIEW_IN_BATCHES'},{status:409});
   // Explicit administrative settlements are retained as replay tombstones;
   // they contain no credentials. Ordinary settled reports may be removed.
   for(const key of reports.keys())if(!await this.state.storage.get('settlement:'+key.slice(7)))await this.state.storage.delete(key);
   const retries=await this.state.storage.list<number>({prefix:'retry:',limit:1000});
   if(retries.size)await this.state.storage.delete([...retries.keys()]);
   await this.arm();return Response.json({ok:true});
  }
  if(path==='/resolve'){
   try{return await this.resolve(await req.json());}
   catch{return Response.json({ok:false,error:'RESOLUTION_PERSISTENCE_FAILED'},{status:500});}
  }
  if(path==='/run'||path==='/reconcile'){
   const body:any=await req.json();if(typeof body.runId!=='string'||body.runId.length>100)return new Response('',{status:400});
   try{await this.run(body.runId,path==='/reconcile'?'reconcile':'queue');return Response.json({ok:true});}
   catch{return Response.json({ok:false,error:'Coordinator persistence or execution failure'},{status:500});}
  }
  return new Response('',{status:404});
 });}
 async alarm(){await this.exclusive(async()=>{
  const now=Date.now();
  // Expiry-ordered index bounds work and avoids starvation behind live keys.
  const expiry=await this.state.storage.list<any>({prefix:'rate-expiry:',limit:100});
  for(const [index,row] of expiry){
   if(row.expiresAt>now)break;
   const current=await this.state.storage.get<any>(row.key);
   if(current?.expiresAt<=now)await this.state.storage.delete(row.key);
   await this.state.storage.delete(index);
  }
  // One resumable upgrade sweep indexes or removes pre-index limiter records.
  if(await this.state.storage.get('rate-index-version')!==1){
   const cursor=await this.state.storage.get<string>('rate-sweep-cursor');
   const old=await this.state.storage.list<any>({prefix:'rate:',limit:100,...(cursor?{startAfter:cursor}:{})});
   for(const [key,row] of old){
    if(row.expiresAt<=now)await this.state.storage.delete(key);
    else await this.state.storage.put(expiryKey(row.expiresAt,key),{key,expiresAt:row.expiresAt});
   }
   if(old.size===100)await this.state.storage.put('rate-sweep-cursor',[...old.keys()].at(-1)!);
   else{await this.state.storage.put('rate-index-version',1);await this.state.storage.delete('rate-sweep-cursor');}
  }
  await this.indexLegacyEvidence(now);
  await this.cleanupEvidence(now);
  if(this.env.BACKGROUND_PAUSED!=='true'){
   const retries=await this.state.storage.list<number>({prefix:'retry:',limit:20});
   // A single upstream run per alarm keeps D1/subrequest work bounded.
   const dueRetries=[...retries].filter(([,due])=>due<=now).sort((a,b)=>a[1]-b[1]).slice(0,1);
   for(const [key] of dueRetries){
    const id=key.slice(6);
    try{await this.state.storage.delete(key);await this.run(id,'alarm');}
    catch{await this.state.storage.put(key,now+300000);}
   }
  }
  await this.arm();
 });}
 private async arm(){
  const retries=this.env.BACKGROUND_PAUSED==='true'?new Map<string,number>():await this.state.storage.list<number>({prefix:'retry:',limit:20});
  const expiry=await this.state.storage.list<any>({prefix:'rate-expiry:',limit:1});
  const reports=await this.state.storage.list<any>({prefix:'report-expiry:',limit:1});
  const settlements=await this.state.storage.list<any>({prefix:'settlement-expiry:',limit:1});
  const values=[...retries.values(),...[...expiry.values(),...reports.values(),...settlements.values()].map(row=>Number(row.expiresAt))];
  if(await this.state.storage.get('rate-sweep-cursor')||await this.state.storage.get('evidence-index-version')!==1)values.push(Date.now()+1000);
  if(values.length)await this.state.storage.setAlarm(Math.max(Date.now()+1000,Math.min(...values)));else await this.state.storage.deleteAlarm();
 }
 private async alarmNoLater(when:number){
  const previous=await this.state.storage.getAlarm(),due=Math.max(Date.now()+1000,when);
  if(previous===null||due<previous)await this.state.storage.setAlarm(due);
 }
 private async indexLegacyEvidence(now:number){
  if(await this.state.storage.get('evidence-index-version')===1)return;
  const cursor=await this.state.storage.get<string>('evidence-sweep-cursor');
  const reports=await this.state.storage.list<any>({prefix:'report:',limit:4,...(cursor?{startAfter:cursor}:{})});
  for(const [key,report] of reports){
   const id=key.slice(7),run=await this.env.DB.prepare('SELECT created_at FROM job_runs WHERE id=?').bind(id).first<any>();
   const parsed=Date.parse(String(report?.time||report?.date||''));
   const createdAt=Number(run?.created_at??(Number.isFinite(parsed)?parsed:now)),expiresAt=createdAt+EVIDENCE_RETENTION;
   await this.state.storage.put(evidenceKey('report',expiresAt,id),{runId:id,expiresAt});
  }
  if(reports.size===4)await this.state.storage.put('evidence-sweep-cursor',[...reports.keys()].at(-1)!);
  else{await this.state.storage.put('evidence-index-version',1);await this.state.storage.delete('evidence-sweep-cursor');}
 }
 private async cleanupEvidence(now:number){
  let latch=await this.state.storage.get<any>('bili_pending_exchange');
  for(const kind of ['report','settlement'] as const){
   const entries=await this.state.storage.list<any>({prefix:kind+'-expiry:',limit:4});
   for(const [index,row] of entries){
    if(row.expiresAt>now)break;
    const run=await this.env.DB.prepare('SELECT status FROM job_runs WHERE id=?').bind(row.runId).first<any>();
    const settlement=await this.state.storage.get<any>('settlement:'+row.runId);
    if(settlement){
     const resolution=await this.env.DB.prepare('SELECT created_at,cleanup_confirmed_at FROM manual_resolutions WHERE run_id=?').bind(row.runId).first<any>();
     if(resolution&&(resolution.cleanup_confirmed_at===null||latch?.runId===row.runId)){await this.completeResolutionCleanup(row.runId,Number(resolution.created_at));latch=await this.state.storage.get<any>('bili_pending_exchange');}
    }
    let retryAt:number|null=null;
    if(latch?.runId===row.runId||run&&!['succeeded','already_done','failed','canceled'].includes(run.status))retryAt=now+86400000;
    else if(settlement&&Number(settlement.createdAt)+EVIDENCE_RETENTION>now)retryAt=Number(settlement.createdAt)+EVIDENCE_RETENTION;
    else{
     await this.state.storage.delete('report:'+row.runId);
     if(kind==='settlement')await this.state.storage.delete('settlement:'+row.runId);
    }
    if(retryAt!==null)await this.state.storage.put(evidenceKey(kind,retryAt,row.runId),{runId:row.runId,expiresAt:retryAt});
    await this.state.storage.delete(index);
   }
  }
 }
 private async completeResolutionCleanup(runId:string,createdAt:number){
  // Confirm cleanup in D1 only after DO state is durably safe. Retention cannot
  // remove the last unlock proof when a post-commit DO write is interrupted.
  await this.state.storage.transaction(async storage=>{
   await storage.delete('retry:'+runId);
   const pending=await storage.get<any>('bili_pending_exchange');
   if(pending?.runId===runId)await storage.delete('bili_pending_exchange');
   const tombstone=await storage.get<any>('settlement:'+runId);
   if(tombstone&&!tombstone.committedAt)await storage.put('settlement:'+runId,{...tombstone,committedAt:Date.now()});
  });
  await this.env.DB.prepare('UPDATE manual_resolutions SET cleanup_confirmed_at=? WHERE run_id=? AND cleanup_confirmed_at IS NULL').bind(Math.max(Date.now(),createdAt),runId).run();
 }
 private async resolve(body:any):Promise<Response>{
  if(typeof body?.runId!=='string'||body.runId.length>100||typeof body.actorId!=='string'||body.actorId.length>100||!['succeeded','failed'].includes(body.outcome)||typeof body.evidence!=='string'||body.evidence.trim().length<20||body.evidence.length>2000||body.confirmNoRepeat!==true)return Response.json({ok:false,error:'INVALID_RESOLUTION'},{status:400});
  const actor=await this.env.DB.prepare("SELECT id FROM users WHERE id=? AND role='admin' AND status='active'").bind(body.actorId).first();
  if(!actor)return Response.json({ok:false,error:'ADMIN_REQUIRED'},{status:403});
  const run=await this.env.DB.prepare('SELECT * FROM job_runs WHERE id=?').bind(body.runId).first<any>();
  const persisted=await this.env.DB.prepare('SELECT * FROM manual_resolutions WHERE run_id=?').bind(body.runId).first<any>();
  let tombstone=await this.state.storage.get<any>('settlement:'+body.runId);
  const evidence=body.evidence.trim();
  const matches=(r:any)=>r.outcome===body.outcome&&(r.evidence===evidence)&&((r.actor_user_id??r.actorId)===body.actorId);
  if(persisted&&!matches(persisted)||tombstone&&!matches(tombstone))return Response.json({ok:false,error:'RESOLUTION_CONFLICT'},{status:409});
  if(!persisted&&(!run||run.status!=='waiting_verification'))return Response.json({ok:false,error:run?'NOT_PENDING':'NOT_FOUND'},{status:run?409:404});
  if(!tombstone){
   const checkpoint=await this.state.storage.get<any>('report:'+body.runId)||(persisted?jsonSafeParse(persisted.checkpoint_json,null):null);
   tombstone={runId:body.runId,ownerId:run?.owner_user_id??persisted.owner_user_id,actorId:body.actorId,outcome:body.outcome,evidence,checkpoint:sanitizeReport(checkpoint),resolutionId:persisted?.resolution_id??crypto.randomUUID(),createdAt:persisted?.created_at??Date.now()};
   // Write the immutable intent first. Retrying after a D1 interruption must
   // complete this same declaration, never discard or change its evidence.
   const expiresAt=tombstone.createdAt+EVIDENCE_RETENTION;
   await this.state.storage.put({['settlement:'+body.runId]:tombstone,[evidenceKey('settlement',expiresAt,body.runId)]:{runId:body.runId,expiresAt}});
   await this.alarmNoLater(expiresAt);
  }
  if(!persisted){
   const details={manual_resolution:true,resolution_id:tombstone.resolutionId,actor_user_id:body.actorId,evidence:sanitizeReport(evidence),checkpoint:tombstone.checkpoint};
   const summary='Administrator reviewed upstream records and manually closed this run; no external request was replayed';
   await this.env.DB.batch([
    this.env.DB.prepare('INSERT INTO manual_resolutions(run_id,owner_user_id,actor_user_id,outcome,evidence,checkpoint_json,resolution_id,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(body.runId,run.owner_user_id,body.actorId,body.outcome,evidence,JSON.stringify(tombstone.checkpoint),tombstone.resolutionId,tombstone.createdAt),
    this.env.DB.prepare("UPDATE job_runs SET status=?,result_json=?,finished_at=?,error_code='MANUAL_RESOLUTION' WHERE id=? AND status='waiting_verification'").bind(body.outcome,JSON.stringify({summary,details}),Date.now(),body.runId),
    this.env.DB.prepare('INSERT INTO job_steps(id,owner_user_id,run_id,operation_id,status,report_json,updated_at) VALUES(?,?,?,?,?,?,?)').bind(body.runId+':manual-resolution',run.owner_user_id,body.runId,body.runId+':manual-resolution',body.outcome,JSON.stringify(details),Date.now()),
    this.env.DB.prepare("INSERT OR IGNORE INTO job_events(id,owner_user_id,run_id,event_type,summary,created_at) VALUES(?,?,?,'info',?,?)").bind(crypto.randomUUID(),run.owner_user_id,body.runId,summary,Date.now()),
   ]);
  }
  await this.completeResolutionCleanup(body.runId,Number(tombstone.createdAt));
  await this.arm();
  return Response.json({ok:true,manual_resolution:true,replayed:!!persisted,resolutionId:tombstone.resolutionId,status:body.outcome});
 }
 private async finalize(run:any,result:TaskResult){
  const now=Date.now(),details=sanitizeReport(result.details||{}),summary=String(sanitizeReport(result.summary));
  const report=jsonSafeParse<any>(JSON.stringify(details),{});
  // All persisted D1 consequences are atomic. Notification delivery is a separate
  // queue job; no outgoing notification request occurs inside the account lock.
  await this.env.DB.batch([
   this.env.DB.prepare('UPDATE job_runs SET status=?,result_json=?,finished_at=?,error_code=? WHERE id=?').bind(result.status,JSON.stringify({summary,details}),now,['succeeded','already_done'].includes(result.status)?null:result.status,run.id),
   this.env.DB.prepare('INSERT INTO job_steps(id,owner_user_id,run_id,operation_id,status,report_json,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(operation_id) DO UPDATE SET status=excluded.status,report_json=excluded.report_json,updated_at=excluded.updated_at').bind(run.id+':state',run.owner_user_id,run.id,run.id+':operation',result.status,JSON.stringify(report),now),
   this.env.DB.prepare('INSERT OR IGNORE INTO job_events(id,owner_user_id,run_id,event_type,summary,created_at) VALUES(?,?,?,?,?,?)').bind(crypto.randomUUID(),run.owner_user_id,run.id,result.status==='already_done'?'info':result.status==='succeeded'?'success':'exception',summary,now),
  ]);
  await this.state.storage.delete('retry:'+run.id);
  // Successful, settled reports no longer need an unbounded DO copy. D1 retains
  // the sanitized evidence. Keep an unresolved report and latch indefinitely.
  if(['succeeded','already_done','failed','canceled'].includes(result.status))await this.state.storage.delete(['report:'+run.id,evidenceKey('report',Number(run.created_at)+EVIDENCE_RETENTION,run.id)]);
  await this.arm();
 }
 private async run(runId:string,source:'queue'|'alarm'|'reconcile'){
  if(source!=='reconcile'&&this.env.BACKGROUND_PAUSED==='true')return;
  const run=await this.env.DB.prepare('SELECT * FROM job_runs WHERE id=?').bind(runId).first<any>();if(!run)return;
  if(['succeeded','already_done','failed','canceled'].includes(run.status))return;
  if(run.status==='waiting_verification'&&source!=='reconcile')return;
  const stale=run.status==='running'&&Date.now()-(run.started_at||Date.now())>600000;
  if(run.status==='running'&&!stale&&source==='queue')return;
  if(run.status==='waiting_retry'&&source==='queue'){
   const due=await this.state.storage.get<number>('retry:'+run.id);if(due&&due>Date.now())return;
  }
  const job=await this.env.DB.prepare('SELECT * FROM jobs WHERE id=? AND owner_user_id=?').bind(run.job_id,run.owner_user_id).first<any>();if(!job)return;
  const account=await this.env.DB.prepare('SELECT * FROM accounts WHERE id=? AND owner_user_id=?').bind(job.account_id,run.owner_user_id).first<any>();if(!account)return;
  const owner=await this.env.DB.prepare('SELECT status FROM users WHERE id=?').bind(run.owner_user_id).first<any>();
  const key='report:'+run.id;const saved=await this.state.storage.get<any>(key);
  const readOnly=source==='reconcile'||stale||(run.status==='waiting_retry'&&(account.module_id==='bilibili-vip'||submitted(saved)));
  // A tombstone written before a failed D1 commit blocks all automatic work
  // until the administrator repeats the same resolution to finish persistence.
  if(await this.state.storage.get('settlement:'+run.id))return;
  if(run.depends_on_run_id){
   const parent=await this.env.DB.prepare('SELECT status FROM job_runs WHERE id=? AND owner_user_id=?').bind(run.depends_on_run_id,run.owner_user_id).first<any>();
   if(parent&&['scheduled','queued','running','waiting_retry'].includes(parent.status)){
    await this.env.DB.prepare("UPDATE outbox SET status='pending',next_attempt_at=?,lease_token=NULL,lease_until=NULL WHERE kind='run' AND ref_id=?").bind(Date.now()+60000,run.id).run();return;
   }
   if(!parent||!['succeeded','already_done'].includes(parent.status)){await this.finalize(run,{status:'failed',summary:'Prerequisite coupon claim is missing or unconfirmed; no exchange request was submitted'});return;}
  }
  if(owner?.status!=='active'){
   // Revocation stops new requests; pending asset evidence must not be erased.
   if(submitted(saved))await this.finalize(run,{status:'waiting_verification',summary:'User suspended; pending operation preserved for review',details:{report:saved}});
   else await this.env.DB.prepare("UPDATE job_runs SET status='canceled',finished_at=? WHERE id=?").bind(Date.now(),run.id).run();return;
  }
  if(this.env.MAINTENANCE_MODE==='true'||await setting(this.env,'maintenance',false)){await this.state.storage.put('retry:'+run.id,Date.now()+300000);await this.arm();return;}
  if(!readOnly){
   if(!account.enabled||!account.identity_verified_at||(!job.enabled&&!run.manual)){
    await this.env.DB.prepare("UPDATE job_runs SET status='canceled',finished_at=? WHERE id=?").bind(Date.now(),run.id).run();return;
   }
   if(this.env.MAINTENANCE_MODE==='true'||await setting(this.env,'maintenance',false)){
    await this.state.storage.put('retry:'+run.id,Date.now()+300000);await this.arm();return;
   }
   const flags=await setting<any>(this.env,'modules_enabled',{'baidu-netdisk':true,'bilibili-vip':true});
   if(flags[account.module_id]===false){await this.finalize(run,{status:'failed',summary:'Module is disabled'});return;}
   if(job.task_key==='bili.exchange'&&!await setting(this.env,'bili_exchange_allowed',false)){await this.finalize(run,{status:'failed',summary:'Battery exchange gate is closed'});return;}
  }
  let pending=await this.state.storage.get<any>('bili_pending_exchange');
  if(pending){const resolved=await this.env.DB.prepare('SELECT run_id,created_at FROM manual_resolutions WHERE run_id=?').bind(pending.runId).first<any>();if(resolved){await this.completeResolutionCleanup(pending.runId,Number(resolved.created_at));pending=null;}}
  if(pending&&pending.runId!==run.id&&job.task_key==='bili.exchange'){
   await this.finalize(run,{status:'failed',summary:'An earlier exchange remains unsettled; no new request submitted'});return;
  }
  // Cancellation races lose to an atomic compare-and-set, never to stale reads.
  const changed=await this.env.DB.prepare("UPDATE job_runs SET status='running',started_at=coalesce(started_at,?) WHERE id=? AND status=? RETURNING id").bind(Date.now(),run.id,run.status).first();
  if(!changed)return;
  let result:TaskResult;
  const settings=jsonSafeParse<Record<string,unknown>>(account.config_json,{});
  try{
   const credentials=await decryptConfig<Record<string,unknown>>(this.env,run.owner_user_id,account.id,account.credentials_enc);
   if(!readOnly){const identity=await verifiedIdentity(this.env,account.module_id,credentials);if(identity.fingerprint!==account.fingerprint)throw new Error('Account identity changed');}
   const ctx={taskKey:job.task_key,credentials,settings,load:()=>this.state.storage.get(key),save:async(report:any)=>{
    const expiresAt=Number(run.created_at)+EVIDENCE_RETENTION;
    const records:Record<string,unknown>={[key]:report,[evidenceKey('report',expiresAt,run.id)]:{runId:run.id,expiresAt}};
    if(job.task_key==='bili.exchange'&&report.exchange?.requestedAt&&report.exchange.state!=='confirmed')records.bili_pending_exchange={runId:run.id,at:Date.now()};
    await this.state.storage.put(records); // Atomic multi-key checkpoint before POST.
    await this.alarmNoLater(expiresAt);
   }};
   const module=moduleDefinition(account.module_id);
   if(!module||!module.manifest.tasks.some(t=>t.key===job.task_key))result={status:'failed',summary:'Unknown module or task'};
   else result=readOnly?await module.reconcile(ctx):await module.run(ctx);
  }catch(error){
   if(error instanceof SessionExpiredError){await this.env.DB.batch([this.env.DB.prepare('UPDATE accounts SET enabled=0 WHERE id=?').bind(account.id),this.env.DB.prepare('UPDATE jobs SET enabled=0 WHERE account_id=?').bind(account.id)]);}
   const checkpoint=await this.state.storage.get<any>(key);
   const mayHaveSubmitted=submitted(checkpoint);
   result={status:mayHaveSubmitted?'waiting_verification':'failed',summary:mayHaveSubmitted?'External operation may have been submitted; review required':error instanceof SessionExpiredError?'Platform session expired. Account and schedules paused; update credentials and re-enable.':'Account check or task request failed; no successful completion confirmed',details:{report:checkpoint||null}};
  }
  if(job.task_key==='bili.exchange'&&result.status==='succeeded'){
   const report=await this.state.storage.get<any>(key);
   if(report?.exchange?.state==='confirmed'&&pending?.runId===run.id)await this.state.storage.delete('bili_pending_exchange');
   // The first attempt may have created the latch after the initial read.
   const current=await this.state.storage.get<any>('bili_pending_exchange');
   if(report?.exchange?.state==='confirmed'&&current?.runId===run.id)await this.state.storage.delete('bili_pending_exchange');
  }
  const report=await this.state.storage.get<any>(key),attempts=Number(report?.attempts||0);
  if(source!=='reconcile'&&attempts>0&&attempts<2&&((job.task_key==='baidu.daily'&&result.status==='failed')||result.status==='waiting_verification')){
   await this.env.DB.prepare("UPDATE job_runs SET status='waiting_retry',result_json=? WHERE id=?").bind(JSON.stringify({summary:result.summary,details:sanitizeReport(result.details||{})}),run.id).run();
   await this.state.storage.put('retry:'+run.id,Date.now()+Number(settings.retry_minutes||30)*60000);await this.arm();return;
  }
  await this.finalize(run,result);
 }
}
