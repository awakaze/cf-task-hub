import {decryptConfig} from '../core/secrets.ts';
import type {Hono,Context} from 'hono';
import {z} from 'zod';
import type {Env,CurrentUser,AccountRecord,JobRecord} from '../core/types.ts';
import {assert,HttpError,jsonSafeParse} from '../core/response.ts';
import {encrypt,decrypt,sha256} from '../core/crypto.ts';
import {audit,checkLimit,quotas,getAccount,setting} from '../core/db.ts';
import {manifests,taskMatches,taskManifest,moduleDefinition,validateModuleSettings} from '../core/registry.ts';
import {DEFAULT_POLICY} from '../core/notifications.ts';
import {validateSchedule,nextSchedule,validZone} from '../core/time.ts';
import {verifiedIdentity} from '../core/identity.ts';
import {cookieInput} from '../core/network.ts';
import {noUnsettled,requireRunning,takeRate,sanitizeReport} from '../core/safety.ts';
import {probeBaidu} from '../modules/baidu-netdisk/adapter.ts';
import {probeBili} from '../modules/bilibili/adapter.ts';
import {validateChannelInput,sendTestNotification} from '../providers/notify.ts';
import {queueRun} from '../core/scheduler.ts';
import {manualRunUsage} from '../core/run-batch.ts';

type AppContext={Bindings:Env;Variables:{user:CurrentUser}};
type App=Hono<AppContext>;
const accountSchema=z.object({module_id:z.enum(['baidu-netdisk','bilibili-vip']),label:z.string().min(1).max(50),credentials:z.object({cookie:z.string().min(10).max(16000),cuid:z.string().max(500).optional(),headers:z.record(z.string(),z.string().max(500).refine(v=>!/[\r\n]/.test(v))).refine(h=>Object.keys(h).length<=2&&Object.keys(h).every(k=>['user-agent','x-requested-with'].includes(k.toLowerCase())),'Only User-Agent and X-Requested-With are allowed').optional()}),config:z.record(z.string(),z.unknown()).default({})});
const scheduleSchema=z.unknown().transform((value,ctx)=>{try{return validateSchedule(value);}catch{ctx.addIssue({code:'custom',message:'Invalid daily, weekly or interval schedule'});return z.NEVER;}});
const jobSchema=z.object({account_id:z.string().uuid(),task_key:z.string().min(3),schedule:scheduleSchema,enabled:z.boolean().default(false)});
function user(c:Context<AppContext>){return c.get('user') as CurrentUser;}
function publicAccount(row:Record<string,unknown>){return {id:row.id,module_id:row.module_id,label:row.label,enabled:!!row.enabled,config:jsonSafeParse(String(row.config_json),{}),created_at:row.created_at,identity_verified_at:row.identity_verified_at,has_credentials:true};}
async function taskAllowed(env:Env,module:string,key:string){
 const flags=await setting(env,'modules_enabled',{'baidu-netdisk':true,'bilibili-vip':true});
 assert((flags as any)[module]!==false,403,'MODULE_DISABLED','该模块暂未开放');
 if(key==='bili.exchange')assert(await setting(env,'bili_exchange_allowed',false),403,'EXCHANGE_DISABLED','管理员尚未确认 B站兑换接口有效，禁止创建兑换任务');
}
async function ownedJob(env:Env,id:string,owner:string){const row=await env.DB.prepare('SELECT * FROM jobs WHERE id=? AND owner_user_id=?').bind(id,owner).first<JobRecord>();assert(row,404,'NOT_FOUND','任务不存在');return row;}
async function ownedChannel(env:Env,id:string,owner:string){const row=await env.DB.prepare('SELECT * FROM notification_channels WHERE id=? AND owner_user_id=?').bind(id,owner).first<any>();assert(row,404,'NOT_FOUND','通知渠道不存在');return row;}
async function checkAccountConfig(module:string,raw:unknown){return validateModuleSettings(module,raw||{});}
function pageNumber(value:string|undefined){const n=Number(value||0);assert(Number.isSafeInteger(n)&&n>=0&&n<=10000,400,'INVALID_PAGE','Invalid page');return n;}
function cursor(value:string|undefined){const n=value===undefined?Date.now()+1000:Number(value);assert(Number.isSafeInteger(n)&&n>0,400,'INVALID_CURSOR','Invalid pagination cursor');return n;}
export function registerUserRoutes(app:App){
 app.get('/api/v1/me',async c=>{
  const u=user(c);return c.json({user:{id:u.id,username:u.username,role:u.role,timezone:u.timezone,has_password:!!u.password_hash,recovery_password_reset_allowed:!!u.recovery_password_reset_allowed,recovery_password_reset_expires_at:u.recovery_password_reset_expires_at??null},quotas:await quotas(c.env,u.id),csrf:true});
 });
 app.get('/api/v1/modules',async c=>{
  const flags=await setting(c.env,'modules_enabled',{'baidu-netdisk':true,'bilibili-vip':true});
  const exchangeAllowed=await setting(c.env,'bili_exchange_allowed',false);
  return c.json({modules:manifests.map(m=>({...m,enabled:(flags as any)[m.id]!==false,tasks:m.tasks.map(t=>({...t,available:t.key!=='bili.exchange'||exchangeAllowed}))}))});
 });
 app.get('/api/v1/dashboard',async c=>{
  const u=user(c);
  const values=await c.env.DB.batch([
   c.env.DB.prepare('SELECT count(*) n FROM accounts WHERE owner_user_id=?').bind(u.id),
   c.env.DB.prepare('SELECT count(*) n FROM jobs WHERE owner_user_id=? AND enabled=1').bind(u.id),
   c.env.DB.prepare("SELECT count(*) n FROM job_runs WHERE owner_user_id=? AND status IN ('succeeded','already_done') AND created_at>=?").bind(u.id,Date.now()-86400000),
   c.env.DB.prepare("SELECT count(*) n FROM job_runs WHERE owner_user_id=? AND status IN ('failed','waiting_verification') AND created_at>=?").bind(u.id,Date.now()-86400000),
  ]);
  const recent=await c.env.DB.prepare('SELECT r.id,r.status,r.created_at,r.result_json,r.job_id,j.task_key,a.label account_label FROM job_runs r JOIN jobs j ON j.id=r.job_id JOIN accounts a ON a.id=j.account_id WHERE r.owner_user_id=? ORDER BY r.created_at DESC LIMIT 8').bind(u.id).all();
  return c.json({stats:values.map(x=>(x.results[0] as any)?.n||0),recent:recent.results.map((x:any)=>({...x,result_json:undefined}))});
 });
 app.get('/api/v1/accounts',async c=>{
  const page=pageNumber(c.req.query('page'));const rows=await c.env.DB.prepare('SELECT * FROM accounts WHERE owner_user_id=? ORDER BY created_at DESC,id LIMIT 50 OFFSET ?').bind(user(c).id,page*50).all();return c.json({items:rows.results.map((x:any)=>publicAccount(x)),page,next_page:rows.results.length===50?page+1:null});
 });
 app.post('/api/v1/accounts',async c=>{
  const u=user(c),body=accountSchema.parse(await c.req.json());
  await taskAllowed(c.env,body.module_id,'');await checkLimit(c.env,u.id,'accounts',(await quotas(c.env,u.id)).max_accounts);
  const config=await checkAccountConfig(body.module_id,body.config),id=crypto.randomUUID();
  await requireRunning(c.env);await takeRate(c.env,'account-check:'+u.id,15,3600000);
  const cookie=cookieInput(body.credentials.cookie);
  const identity=await verifiedIdentity(c.env,body.module_id,{...body.credentials,cookie});
  const fp=identity.fingerprint;
  const encrypted=await encrypt(c.env.DATA_KEY,u.id,id,{...body.credentials,cookie,externalId:identity.externalId});
  try{await c.env.DB.prepare('INSERT INTO accounts(id,owner_user_id,module_id,label,fingerprint,credentials_enc,config_json,enabled,created_at,updated_at,identity_verified_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(id,u.id,body.module_id,body.label,fp,encrypted,JSON.stringify(config),1,Date.now(),Date.now(),Date.now()).run();}
  catch {throw new HttpError(409,'ACCOUNT_CONFLICT','账号已被绑定或数据无效');}
  await audit(c.env,u.id,'account.create',id,{module_id:body.module_id});return c.json({id,ok:true},201);
 });
 app.patch('/api/v1/accounts/:id',async c=>{
  const u=user(c),old=await getAccount(c.env,c.req.param('id'),u.id);
  const body=z.object({label:z.string().min(1).max(50).optional(),enabled:z.boolean().optional(),credentials:accountSchema.shape.credentials.optional(),config:z.record(z.string(),z.unknown()).optional()}).strict().parse(await c.req.json());
  const id=String(old.id),module=String(old.module_id);
  let creds=String(old.credentials_enc),fp=String(old.fingerprint),verified=old.identity_verified_at;
  if(body.credentials){
   await requireRunning(c.env);await takeRate(c.env,'account-check:'+u.id,15,3600000);
   const input={...body.credentials,cookie:cookieInput(body.credentials.cookie)};
   const identity=await verifiedIdentity(c.env,module,input);
   if(verified)assert(identity.fingerprint===fp,409,'DIFFERENT_ACCOUNT','New credentials must belong to the same upstream account');
   else await noUnsettled(c.env,u.id,id);
   fp=identity.fingerprint;creds=await encrypt(c.env.DATA_KEY,u.id,id,{...input,externalId:identity.externalId});verified=Date.now();
  }
  if(body.enabled===true)assert(verified,409,'REVERIFY_REQUIRED','Re-enter and verify the account credentials before enabling');
  const config=body.config!==undefined?JSON.stringify(await checkAccountConfig(module,body.config)):String(old.config_json);
  try{await c.env.DB.prepare('UPDATE accounts SET label=?,enabled=?,credentials_enc=?,fingerprint=?,config_json=?,updated_at=?,identity_verified_at=? WHERE id=? AND owner_user_id=?').bind(body.label??old.label,body.enabled===undefined?old.enabled:body.enabled?1:0,creds,fp,config,Date.now(),verified??null,id,u.id).run();}catch{throw new HttpError(409,'ACCOUNT_CONFLICT','账号可能重复绑定');}
  await audit(c.env,u.id,'account.update',id);return c.json({ok:true});
 });
 app.delete('/api/v1/accounts/:id',async c=>{
  const u=user(c),id=c.req.param('id');const account=await getAccount(c.env,id,u.id);
  await noUnsettled(c.env,u.id,id);
  const purged=await c.env.ACCOUNTS.get(c.env.ACCOUNTS.idFromName('account:'+account.fingerprint)).fetch('https://internal/purge',{method:'POST',body:JSON.stringify({confirm:true})});
  assert(purged.ok,409,'UNRESOLVED_ASSET','Cannot delete an account with unresolved asset evidence');
  await c.env.DB.prepare('DELETE FROM accounts WHERE id=? AND owner_user_id=?').bind(id,u.id).run();await audit(c.env,u.id,'account.delete',id);return c.json({ok:true});
 });
 app.post('/api/v1/accounts/:id/probe',async c=>{
  const u=user(c);await requireRunning(c.env);await takeRate(c.env,'account-check:'+u.id,15,3600000);const acc=await getAccount(c.env,c.req.param('id'),u.id);const creds=await decryptConfig<Record<string,unknown>>(c.env,u.id,String(acc.id),String(acc.credentials_enc));
  const identity=await verifiedIdentity(c.env,String(acc.module_id),creds);
  if(acc.identity_verified_at)assert(identity.fingerprint===acc.fingerprint,409,'DIFFERENT_ACCOUNT','Upstream identity mismatch');
  else{await noUnsettled(c.env,u.id,String(acc.id));await c.env.DB.prepare('UPDATE accounts SET fingerprint=?,identity_verified_at=? WHERE id=? AND owner_user_id=?').bind(identity.fingerprint,Date.now(),acc.id,u.id).run();}
  const config=jsonSafeParse<Record<string,unknown>>(String(acc.config_json),{});
  const module=moduleDefinition(String(acc.module_id));assert(module,400,'INVALID_MODULE','Unknown module');const result=await module.probe(creds,config);
  return c.json({ok:true,readOnly:true,checked_at:Date.now(),result:sanitizeReport(result)});
 });
 app.get('/api/v1/jobs',async c=>{
  const page=pageNumber(c.req.query('page'));const rows=await c.env.DB.prepare('SELECT j.*,a.label account_label,a.module_id FROM jobs j JOIN accounts a ON a.id=j.account_id WHERE j.owner_user_id=? ORDER BY j.created_at DESC,j.id LIMIT 50 OFFSET ?').bind(user(c).id,page*50).all();
  return c.json({items:rows.results.map((r:any)=>({...r,enabled:!!r.enabled,schedule:jsonSafeParse(r.schedule_json,{}),schedule_json:undefined})),page,next_page:rows.results.length===50?page+1:null});
 });
 app.post('/api/v1/jobs',async c=>{
  const u=user(c),body=jobSchema.parse(await c.req.json());
  await checkLimit(c.env,u.id,'jobs',(await quotas(c.env,u.id)).max_jobs);
  const acc=await getAccount(c.env,body.account_id,u.id);
  assert(taskMatches(String(acc.module_id),body.task_key),400,'INVALID_TASK','模块与任务不匹配');await taskAllowed(c.env,String(acc.module_id),body.task_key);
  // Automatically publishing a high-risk transaction requires a separate explicit opt-in.
  assert(body.task_key!=='bili.exchange'||body.enabled===false,400,'EXCHANGE_ENABLE_REQUIRES_CONFIRMATION','兑换任务须先创建为关闭状态，再通过风险确认开启');
  const id=crypto.randomUUID(),next=nextSchedule(body.schedule);
  try{await c.env.DB.prepare('INSERT INTO jobs(id,owner_user_id,account_id,task_key,schedule_json,enabled,next_run_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(id,u.id,body.account_id,body.task_key,JSON.stringify(body.schedule),body.enabled?1:0,next,Date.now(),Date.now()).run();}
  catch{throw new HttpError(409,'JOB_EXISTS','该账号已经创建了相同任务');}
  await audit(c.env,u.id,'job.create',id,{task_key:body.task_key});return c.json({id,ok:true},201);
 });
 app.patch('/api/v1/jobs/:id',async c=>{
  const u=user(c),job=await ownedJob(c.env,c.req.param('id'),u.id);
  const body=z.object({enabled:z.boolean().optional(),schedule:scheduleSchema.optional(),riskAccepted:z.boolean().optional()}).strict().parse(await c.req.json());
  if(body.enabled===true){
   const account=await getAccount(c.env,job.account_id,u.id);assert(Number(account.enabled)===1&&account.identity_verified_at,403,'ACCOUNT_DISABLED','账号已关闭');
   await taskAllowed(c.env,String(account.module_id),job.task_key);
   if(job.task_key==='bili.exchange')assert(body.riskAccepted===true,403,'RISK_ACCEPTANCE_REQUIRED','请明确确认兑换会消费你的 B 币券且需真实接口验证');
  }
  const schedule=body.schedule??jsonSafeParse<any>(job.schedule_json,{}),next=body.schedule||body.enabled===true?nextSchedule(schedule):job.next_run_at;
  await c.env.DB.prepare('UPDATE jobs SET enabled=?,schedule_json=?,next_run_at=?,updated_at=? WHERE id=? AND owner_user_id=?').bind(body.enabled===undefined?Number(job.enabled):body.enabled?1:0,JSON.stringify(schedule),next,Date.now(),job.id,u.id).run();
  await audit(c.env,u.id,'job.update',job.id,{enabled:body.enabled});return c.json({ok:true});
 });
 app.delete('/api/v1/jobs/:id',async c=>{const u=user(c),job=await ownedJob(c.env,c.req.param('id'),u.id);await noUnsettled(c.env,u.id,undefined,job.id);await c.env.DB.prepare('DELETE FROM jobs WHERE id=? AND owner_user_id=?').bind(job.id,u.id).run();await audit(c.env,u.id,'job.delete',job.id);return c.json({ok:true});});
 app.post('/api/v1/jobs/:id/run',async c=>{
  const u=user(c),job=await ownedJob(c.env,c.req.param('id'),u.id);
  await requireRunning(c.env);
  const account=await getAccount(c.env,job.account_id,u.id);assert(Number(account.enabled)===1&&account.identity_verified_at,403,'ACCOUNT_DISABLED','账号已关闭');await taskAllowed(c.env,String(account.module_id),job.task_key);
  const idem=c.req.header('Idempotency-Key');assert(idem&&idem.length>=12&&idem.length<=100,400,'IDEMPOTENCY_KEY_REQUIRED','必须提供 Idempotency-Key');
  const key=`manual:${await sha256(u.id+':'+job.id+':'+idem)}`;
  const existing=await c.env.DB.prepare('SELECT id,status FROM job_runs WHERE job_id=? AND window_key=? AND owner_user_id=?').bind(job.id,key,u.id).first<any>();
  if(existing)return c.json({runId:existing.id,status:existing.status,replayed:true});
  const quota=await quotas(c.env,u.id);
  assert(await manualRunUsage(c.env,u.id)<quota.max_manual_runs,429,'QUOTA_EXCEEDED','近24小时手动执行额度已用完');
  if(job.task_key==='bili.exchange'){const confirm=await c.req.json<any>();assert(confirm.riskAccepted===true,403,'RISK_ACCEPTANCE_REQUIRED','Explicit confirmation is required for consuming coupons');}
  const record=await queueRun(c.env,job,key,true,Date.now());return c.json({runId:record,queued:true});
 });
 app.get('/api/v1/runs',async c=>{
  const before=cursor(c.req.query('before')),afterId=c.req.query('after_id')||'~';assert(afterId.length<=100,400,'INVALID_CURSOR','Invalid cursor ID');
  const rows=await c.env.DB.prepare('SELECT r.id,r.job_id,r.status,r.manual,r.created_at,r.started_at,r.finished_at,r.error_code,j.task_key,a.label account_label FROM job_runs r JOIN jobs j ON j.id=r.job_id JOIN accounts a ON a.id=j.account_id WHERE r.owner_user_id=? AND (r.created_at<? OR (r.created_at=? AND r.id<?)) ORDER BY r.created_at DESC,r.id DESC LIMIT 50').bind(user(c).id,before,before,afterId).all();return c.json({items:rows.results,next_before:rows.results.length===50?rows.results[49].created_at:null,next_id:rows.results.length===50?rows.results[49].id:null});
 });
 app.get('/api/v1/runs/:id',async c=>{
  const r=await c.env.DB.prepare('SELECT * FROM job_runs WHERE id=? AND owner_user_id=?').bind(c.req.param('id'),user(c).id).first<any>();assert(r,404,'NOT_FOUND','记录不存在');const steps=await c.env.DB.prepare('SELECT operation_id,status,report_json,updated_at FROM job_steps WHERE run_id=? AND owner_user_id=? ORDER BY updated_at').bind(r.id,user(c).id).all();return c.json({run:{...r,result:jsonSafeParse(r.result_json,null),result_json:undefined},steps:steps.results.map((s:any)=>({...s,report:jsonSafeParse(s.report_json,{}),report_json:undefined}))});
 });
 app.get('/api/v1/notification-channels',async c=>{
  const owner=user(c).id,r=await c.env.DB.prepare('SELECT id,name,type,enabled,created_at,updated_at,consecutive_failures,cooldown_until,config_enc FROM notification_channels WHERE owner_user_id=? ORDER BY created_at DESC LIMIT 20').bind(owner).all<any>();
  const items=await Promise.all(r.results.map(async row=>{
   const {config_enc,...safe}=row;let editable_config:Record<string,string>={};
   try{const config=await decryptConfig<any>(c.env,owner,row.id,config_enc);
    if(row.type==='telegram')editable_config={chatId:String(config.chatId||''),threadId:String(config.threadId||'')};
   }catch{safe.configuration_unavailable=true;}
   return {...safe,editable_config};
  }));return c.json({items});
 });
 app.post('/api/v1/notification-channels',async c=>{
  const u=user(c),body=await c.req.json<any>();await checkLimit(c.env,u.id,'notification_channels',(await quotas(c.env,u.id)).max_channels);
  const config=await validateChannelInput(c.env,body.type,body.config);const id=crypto.randomUUID();
  await c.env.DB.prepare('INSERT INTO notification_channels(id,owner_user_id,name,type,config_enc,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').bind(id,u.id,String(body.name||'未命名').slice(0,60),body.type,await encrypt(c.env.DATA_KEY,u.id,id,config),1,Date.now(),Date.now()).run();await audit(c.env,u.id,'notification.create',id,{type:body.type});return c.json({id,ok:true},201);
 });
 app.patch('/api/v1/notification-channels/:id',async c=>{
  const u=user(c),r=await ownedChannel(c.env,c.req.param('id'),u.id);
  const body=z.object({name:z.string().min(1).max(60).optional(),enabled:z.boolean().optional(),config:z.record(z.string(),z.unknown()).optional(),configPatch:z.record(z.string(),z.unknown()).optional()}).strict().parse(await c.req.json());
  assert(!(body.config&&body.configPatch),400,'INVALID_CONFIG','Choose a full replacement or a configuration patch');
  let enc=r.config_enc;
  if(body.config!==undefined||body.configPatch!==undefined){
   const allowed:Record<string,string[]>={telegram:['botToken','chatId','threadId'],serverchan:['sendKey'],webhook:['url','headers','signingSecret']};
   const patch=body.configPatch;
   if(patch)assert(Object.keys(patch).every(k=>allowed[r.type]?.includes(k)),400,'INVALID_CONFIG','Unsupported notification field');
   const raw=patch?{...await decryptConfig<Record<string,unknown>>(c.env,u.id,r.id,r.config_enc),...patch}:body.config;
   const next=await validateChannelInput(c.env,r.type,raw);enc=await encrypt(c.env.DATA_KEY,u.id,r.id,next);
  }
  await c.env.DB.prepare('UPDATE notification_channels SET name=?,enabled=?,config_enc=?,updated_at=? WHERE id=? AND owner_user_id=?').bind(body.name??r.name,body.enabled===undefined?r.enabled:body.enabled?1:0,enc,Date.now(),r.id,u.id).run();
  await audit(c.env,u.id,'notification.update',r.id);return c.json({ok:true});
 });
 app.delete('/api/v1/notification-channels/:id',async c=>{const u=user(c);await ownedChannel(c.env,c.req.param('id'),u.id);await c.env.DB.prepare('DELETE FROM notification_channels WHERE id=? AND owner_user_id=?').bind(c.req.param('id'),u.id).run();return c.json({ok:true});});
 app.post('/api/v1/notification-channels/:id/test',async c=>{
  const u=user(c),r=await ownedChannel(c.env,c.req.param('id'),u.id);
  await sendTestNotification(c.env,u.id,r);
  await audit(c.env,u.id,'notification.test',r.id);return c.json({ok:true});
 });
 app.get('/api/v1/notification-policies',async c=>{
  const u=user(c),rows=await c.env.DB.prepare('SELECT * FROM notification_policies WHERE owner_user_id=?').bind(u.id).all();
  return c.json({items:rows.results.map((r:any)=>({id:r.id,scope_type:r.scope_type,scope_id:r.scope_id,success_enabled:!!r.success_enabled,exception_enabled:!!r.exception_enabled,success_channels:jsonSafeParse(r.success_channels_json,[]),error_mode:r.error_mode,exception_channels:jsonSafeParse(r.exception_channels_json,[])})),default:DEFAULT_POLICY});
 });
 app.put('/api/v1/notification-policies',async c=>{
  const u=user(c),body=z.object({scope_type:z.enum(['user','account','job']),scope_id:z.string(),success_enabled:z.boolean(),exception_enabled:z.boolean(),success_channels:z.array(z.string().uuid()).max(3),error_mode:z.enum(['same','custom']),exception_channels:z.array(z.string().uuid()).max(3)}).strict().parse(await c.req.json());
  if(body.scope_type==='user')assert(body.scope_id===u.id,403,'FORBIDDEN','默认策略只能设置为自己');
  if(body.scope_type==='account')await getAccount(c.env,body.scope_id,u.id);
  if(body.scope_type==='job')await ownedJob(c.env,body.scope_id,u.id);
  const ids=[...new Set([...body.success_channels,...body.exception_channels])];
  for(const id of ids)await ownedChannel(c.env,id,u.id);
  const id=`${body.scope_type}:${body.scope_id}`;
  await c.env.DB.prepare(`INSERT INTO notification_policies(id,owner_user_id,scope_type,scope_id,success_enabled,exception_enabled,success_channels_json,error_mode,exception_channels_json,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_user_id,scope_type,scope_id) DO UPDATE SET success_enabled=excluded.success_enabled,exception_enabled=excluded.exception_enabled,success_channels_json=excluded.success_channels_json,error_mode=excluded.error_mode,exception_channels_json=excluded.exception_channels_json,updated_at=excluded.updated_at`).bind(id,u.id,body.scope_type,body.scope_id,body.success_enabled?1:0,body.exception_enabled?1:0,JSON.stringify(body.success_channels),body.error_mode,JSON.stringify(body.exception_channels),Date.now()).run();
  return c.json({ok:true});
 });
 app.get('/api/v1/notification-history',async c=>{
  const before=cursor(c.req.query('before')),afterId=c.req.query('after_id')||'~';assert(afterId.length<=100,400,'INVALID_CURSOR','Invalid cursor ID');
  const r=await c.env.DB.prepare('SELECT d.id,d.status,d.attempts,d.last_error,d.delivered_at,ch.name channel_name,e.event_type,e.summary,e.created_at FROM notification_deliveries d JOIN notification_channels ch ON ch.id=d.channel_id JOIN job_events e ON e.id=d.event_id WHERE d.owner_user_id=? AND (e.created_at<? OR (e.created_at=? AND d.id<?)) ORDER BY e.created_at DESC,d.id DESC LIMIT 50').bind(user(c).id,before,before,afterId).all();return c.json({items:r.results,next_before:r.results.length===50?r.results[49].created_at:null,next_id:r.results.length===50?r.results[49].id:null});
 });
 app.patch('/api/v1/me',async c=>{
  const u=user(c),b=z.object({timezone:z.string().max(80)}).strict().parse(await c.req.json());
  assert(validZone(b.timezone),400,'INVALID_ZONE','Use an IANA time zone');
  await c.env.DB.prepare('UPDATE users SET timezone=? WHERE id=?').bind(b.timezone,u.id).run();return c.json({ok:true});
 });
 app.post('/api/v1/runs/:id/cancel',async c=>{
  const u=user(c),id=c.req.param('id');
  const changed=await c.env.DB.prepare("UPDATE job_runs SET status='canceled',finished_at=? WHERE id=? AND owner_user_id=? AND status IN ('scheduled','queued') RETURNING id").bind(Date.now(),id,u.id).first();
  assert(changed,409,'NOT_CANCELABLE','Only a not-yet-started run may be canceled');
  await c.env.DB.prepare("UPDATE outbox SET status='canceled',lease_token=NULL,lease_until=NULL WHERE kind='run' AND ref_id=? AND owner_user_id=?").bind(id,u.id).run();
  await audit(c.env,u.id,'run.cancel',id);return c.json({ok:true});
 });
 app.post('/api/v1/runs/:id/reconcile',async c=>{
  const u=user(c),id=c.req.param('id');await requireRunning(c.env);await takeRate(c.env,'reconcile:'+u.id,10,3600000);
  const run=await c.env.DB.prepare('SELECT r.id,r.status,a.fingerprint FROM job_runs r JOIN jobs j ON j.id=r.job_id JOIN accounts a ON a.id=j.account_id WHERE r.id=? AND r.owner_user_id=?').bind(id,u.id).first<any>();
  assert(run,404,'NOT_FOUND','Run not found');assert(run.status==='waiting_verification',409,'NOT_PENDING','Run is not awaiting verification');
  const response=await c.env.ACCOUNTS.get(c.env.ACCOUNTS.idFromName('account:'+run.fingerprint)).fetch('https://internal/reconcile',{method:'POST',body:JSON.stringify({runId:id})});
  assert(response.ok,503,'RECONCILE_FAILED','Read-only reconciliation could not finish');
  await audit(c.env,u.id,'run.reconcile',id);return c.json({ok:true,readOnly:true});
 });
 app.delete('/api/v1/notification-policies/:scope/:id',async c=>{
  const u=user(c),scope=c.req.param('scope'),id=c.req.param('id');
  assert(['user','account','job'].includes(scope),400,'INVALID_SCOPE','Invalid notification scope');
  if(scope==='user')assert(id===u.id,404,'NOT_FOUND','Policy not found');
  if(scope==='account')await getAccount(c.env,id,u.id);if(scope==='job')await ownedJob(c.env,id,u.id);
  await c.env.DB.prepare('DELETE FROM notification_policies WHERE owner_user_id=? AND scope_type=? AND scope_id=?').bind(u.id,scope,id).run();return c.json({ok:true,inherited:true});
 });
 app.post('/api/v1/notification-history/:id/retry',async c=>{
  const u=user(c),id=c.req.param('id');await requireRunning(c.env);await takeRate(c.env,'notify-retry:'+u.id,5,86400000);
  const delivery=await c.env.DB.prepare("SELECT id FROM notification_deliveries WHERE id=? AND owner_user_id=? AND status IN ('failed','disabled')").bind(id,u.id).first();
  assert(delivery,409,'NOT_RETRYABLE','Delivery is not in a retryable state');
  const now=Date.now();await c.env.DB.batch([
   c.env.DB.prepare("UPDATE notification_deliveries SET status='retry',attempts=0,last_error=NULL,next_attempt_at=?,lease_token=NULL,lease_until=NULL WHERE id=? AND owner_user_id=? AND status IN ('failed','disabled')").bind(now,id,u.id),
   c.env.DB.prepare("INSERT INTO outbox(id,owner_user_id,kind,ref_id,payload_json,status,next_attempt_at,updated_at) VALUES(?,?,'notify',?,?,'pending',?,?) ON CONFLICT(kind,ref_id) DO UPDATE SET status='pending',attempts=0,next_attempt_at=excluded.next_attempt_at,lease_token=NULL,lease_until=NULL,updated_at=excluded.updated_at").bind(crypto.randomUUID(),u.id,id,JSON.stringify({kind:'notify',id}),now,now)
  ]);await audit(c.env,u.id,'notification.retry',id);return c.json({ok:true,duplicatePossible:true});
 });
 app.post('/api/v1/me/delete',async c=>{
  const u=user(c);assert(u.role!=='admin',403,'ADMIN_PROTECTED','The sole administrator cannot self-delete');
  const b=z.object({confirmUsername:z.string()}).strict().parse(await c.req.json());assert(b.confirmUsername===u.username,400,'CONFIRMATION_REQUIRED','Type your username to confirm deletion');
  const session=await c.env.DB.prepare('SELECT created_at FROM sessions WHERE id=?').bind(u.sessionId).first<any>();
  assert(session&&session.created_at>Date.now()-900000,403,'REAUTH_REQUIRED','Log in again before deleting your account');
  await noUnsettled(c.env,u.id);const accounts=await c.env.DB.prepare('SELECT id,fingerprint FROM accounts WHERE owner_user_id=? LIMIT 21').bind(u.id).all<any>();
  assert(accounts.results.length<=20,409,'DELETE_IN_BATCHES','Remove platform accounts until at most 20 remain, then retry account deletion');
  // Stop any race with future scheduling first. An existing unsettled run blocks
  // deletion in database triggers; suspension can be reversed by the administrator.
  await c.env.DB.batch([c.env.DB.prepare("UPDATE users SET status='suspended' WHERE id=?").bind(u.id),c.env.DB.prepare('UPDATE jobs SET enabled=0 WHERE owner_user_id=?').bind(u.id),c.env.DB.prepare('UPDATE sessions SET revoked_at=? WHERE user_id=?').bind(Date.now(),u.id)]);
  await noUnsettled(c.env,u.id);
  for(const account of accounts.results){const r=await c.env.ACCOUNTS.get(c.env.ACCOUNTS.idFromName('account:'+account.fingerprint)).fetch('https://internal/purge',{method:'POST',body:JSON.stringify({confirm:true})});assert(r.ok,409,'UNRESOLVED_ASSET','Account contains unsettled asset evidence');}
  await c.env.DB.prepare("DELETE FROM users WHERE id=? AND role='user'").bind(u.id).run();
  return c.json({ok:true,deleted:true});
 });

}
