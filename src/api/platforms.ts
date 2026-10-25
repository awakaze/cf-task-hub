import type {Hono,Context} from 'hono';
import {z} from 'zod';
import type {Env,CurrentUser,JobRecord} from '../core/types.ts';
import {assert,HttpError,jsonSafeParse} from '../core/response.ts';
import {encrypt,sha256} from '../core/crypto.ts';
import {audit,auditStatement,checkLimit,quotas,getAccount,setting} from '../core/db.ts';
import {mutationGuard} from '../core/mutation-guard.ts';
import {manifests,moduleDefinition,validateModuleSettings} from '../core/registry.ts';
import {validateSchedule,nextSchedule,BEIJING} from '../core/time.ts';
import {verifiedIdentity,SessionExpiredError} from '../core/identity.ts';
import {cookieInput,boundedJson,boundedText} from '../core/network.ts';
import {requireRunning,takeRate,noUnsettled,sanitizeReport} from '../core/safety.ts';
import {decryptConfig} from '../core/secrets.ts';
import {queueRunBatch} from '../core/run-batch.ts';
import {baiduAuthUrl,baiduQrStart,baiduQrPoll,baiduQrCookie} from '../core/baidu-qr.ts';
import {DEFAULT_POLICY} from '../core/notifications.ts';

type AppContext={Bindings:Env;Variables:{user:CurrentUser}};
type App=Hono<AppContext>;
type GroupRow={id:string;owner_user_id:string;module_id:string;config_json:string;schedule_json:string|null;notify_json:string|null;features_json:string;created_at:number;updated_at:number};
const credentialsSchema=z.object({cookie:z.string().min(10).max(16000),cuid:z.string().max(500).optional(),headers:z.record(z.string(),z.string().max(500).refine(v=>!/[\r\n]/.test(v))).refine(h=>Object.keys(h).length<=2&&Object.keys(h).every(k=>['user-agent','x-requested-with'].includes(k.toLowerCase())),'Only User-Agent and X-Requested-With are allowed').optional()});
const scheduleSchema=z.unknown().transform((value,ctx)=>{try{return validateSchedule(value);}catch{ctx.addIssue({code:'custom',message:'Invalid daily, weekly or interval schedule'});return z.NEVER;}});
const notifySchema=z.object({success_enabled:z.boolean(),exception_enabled:z.boolean(),success_channels:z.array(z.string().uuid()).max(3),error_mode:z.enum(['same','custom']),exception_channels:z.array(z.string().uuid()).max(3)}).strict();

function user(c:Context<AppContext>){return c.get('user') as CurrentUser;}
function moduleOf(c:Context<AppContext>){const id=c.req.param('module')||'';assert(manifests.some(m=>m.id===id),404,'NOT_FOUND','未知平台');return id;}
function defaultConfig(module:string){return Object.fromEntries((moduleDefinition(module)?.manifest.configSchema||[]).map(f=>[f.key,f.default]));}
function defaultFeatures(module:string){return (manifests.find(m=>m.id===module)?.tasks||[]).filter(t=>t.key!=='bili.exchange').map(t=>t.key);}
function defaultSchedule(){return {type:'daily' as const,hour:9,minute:0,timezone:BEIJING};}
function publicAccount(row:Record<string,any>){return {id:row.id,module_id:row.module_id,label:row.label,enabled:!!row.enabled,config:jsonSafeParse(row.config_json,{}),created_at:row.created_at,identity_verified_at:row.identity_verified_at??null};}
function groupView(row:GroupRow|null|undefined,module:string){
 if(!row)return {id:null,config:defaultConfig(module),schedule:defaultSchedule(),notify:null,features:defaultFeatures(module)};
 const schedule=jsonSafeParse<any>(row.schedule_json,null);
 return {id:row.id,config:{...defaultConfig(module),...jsonSafeParse<Record<string,unknown>>(row.config_json,{})},schedule:schedule||defaultSchedule(),notify:row.notify_json===null?null:{...DEFAULT_POLICY,...jsonSafeParse<Record<string,unknown>>(row.notify_json,{})},features:jsonSafeParse<string[]>(row.features_json,[])};
}
async function moduleEnabled(env:Env,module:string){const flags=await setting<any>(env,'modules_enabled',{'baidu-netdisk':true,'bilibili-vip':true});assert(flags?.[module]!==false,403,'MODULE_DISABLED','该模块暂未开放');}
async function ensureGroup(env:Env,owner:string,module:string):Promise<GroupRow>{
 const row=await env.DB.prepare('SELECT * FROM platform_groups WHERE owner_user_id=? AND module_id=?').bind(owner,module).first<GroupRow>();
 if(row)return row;
 const now=Date.now();
 // A missing group is planned in memory, then committed with its accounts/jobs.
 // Deterministic IDs prevent concurrent first-time account additions disagreeing.
 return {id:`platform:${owner}:${module}`,owner_user_id:owner,module_id:module,config_json:JSON.stringify(defaultConfig(module)),schedule_json:JSON.stringify(defaultSchedule()),notify_json:null,features_json:JSON.stringify(defaultFeatures(module)),created_at:now,updated_at:now};
}
function groupInsert(env:Env,group:GroupRow,replace=false){
 return env.DB.prepare('INSERT INTO platform_groups(id,owner_user_id,module_id,config_json,schedule_json,notify_json,features_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_user_id,module_id) DO '+(replace?'UPDATE SET config_json=excluded.config_json,schedule_json=excluded.schedule_json,notify_json=excluded.notify_json,features_json=excluded.features_json,updated_at=excluded.updated_at':'NOTHING'))
  .bind(group.id,group.owner_user_id,group.module_id,group.config_json,group.schedule_json,group.notify_json,group.features_json,group.created_at,group.updated_at);
}
async function validateNotify(env:Env,owner:string,notify:{success_enabled:boolean;exception_enabled:boolean;success_channels:string[];error_mode:'same'|'custom';exception_channels:string[]}){
 for(const id of [...new Set([...notify.success_channels,...notify.exception_channels])]){
  const row=await env.DB.prepare('SELECT id FROM notification_channels WHERE id=? AND owner_user_id=?').bind(id,owner).first();
  assert(row,404,'NOT_FOUND','通知渠道不存在');
 }
 return notify;
}
async function validateFeatures(env:Env,module:string,raw:string[],riskAccepted:boolean,previous:string[]=[]){
 const manifest=manifests.find(m=>m.id===module);assert(manifest,404,'NOT_FOUND','未知平台');
 const valid=new Set((manifest?.tasks||[]).map(t=>t.key));
 const features=[...new Set(raw)];
 assert(features.every(f=>valid.has(f)),400,'INVALID_TASK','该平台不存在所选功能');
 if(features.includes('bili.exchange')){
  assert(await setting(env,'bili_exchange_allowed',false),403,'EXCHANGE_DISABLED','管理员尚未确认 B站兑换接口有效，禁止开启兑换功能');
  assert(previous.includes('bili.exchange')||riskAccepted,403,'RISK_ACCEPTANCE_REQUIRED','开启兑换会实际消耗 B 币券，请先确认风险');
 }
 return features;
}
async function jobStatements(env:Env,group:GroupRow,module:string,schedule:any,options:{newAccountId?:string;onlyAccountId?:string}={}){
 const owner=group.owner_user_id,now=Date.now(),features=jsonSafeParse<string[]>(group.features_json,[]),scheduleJson=JSON.stringify(schedule);
 const next=nextSchedule(schedule); // Validate feasibility before ANY mutation.
 const accounts=await env.DB.prepare('SELECT id FROM accounts WHERE owner_user_id=? AND module_id=? AND (group_id=? OR group_id IS NULL)').bind(owner,module,group.id).all<{id:string}>();
 const jobs=await env.DB.prepare('SELECT j.id,j.account_id,j.task_key,j.schedule_json,j.enabled,j.next_run_at FROM jobs j JOIN accounts a ON a.id=j.account_id WHERE j.owner_user_id=? AND a.module_id=?').bind(owner,module).all<any>();
 const selected=accounts.results.filter(a=>!options.onlyAccountId||a.id===options.onlyAccountId);
 if(options.newAccountId&&!selected.some(a=>a.id===options.newAccountId))selected.push({id:options.newAccountId});
 const byKey=new Map<string,any>();for(const row of jobs.results)byKey.set(`${row.account_id}:${row.task_key}`,row);
 const needed=selected.reduce((sum,a)=>sum+features.filter(t=>!byKey.has(`${a.id}:${t}`)).length,0);
 if(needed){const q=await quotas(env,owner);const total=await env.DB.prepare('SELECT count(*) n FROM jobs WHERE owner_user_id=?').bind(owner).first<{n:number}>();assert(Number(total?.n||0)+needed<=q.max_jobs,429,'QUOTA_EXCEEDED','任务数量额度不足；本次修改未保存');}
 const stmts:D1PreparedStatement[]=[
  env.DB.prepare('UPDATE accounts SET group_id=?,config_json=?,updated_at=? WHERE owner_user_id=? AND module_id=? AND (? IS NULL OR id=?) AND (group_id=? OR group_id IS NULL)').bind(group.id,group.config_json,now,owner,module,options.onlyAccountId??null,options.onlyAccountId??null,group.id),
 ];
 for(const account of selected){
  for(const task of features){
   const existing=byKey.get(`${account.id}:${task}`);
   if(existing){
    const keep=Number(existing.enabled)===1&&existing.schedule_json===scheduleJson&&existing.next_run_at;
    const due=keep?Number(existing.next_run_at):next;
    stmts.push(env.DB.prepare('UPDATE jobs SET group_id=?,schedule_json=?,enabled=1,next_run_at=?,updated_at=? WHERE id=?').bind(group.id,scheduleJson,due,now,existing.id));
   }else{
    stmts.push(env.DB.prepare('INSERT OR IGNORE INTO jobs(id,owner_user_id,account_id,group_id,task_key,schedule_json,enabled,next_run_at,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?,?)').bind(crypto.randomUUID(),owner,account.id,group.id,task,scheduleJson,next,now,now));
   }
  }
  for(const row of jobs.results.filter((j:any)=>j.account_id===account.id&&!features.includes(j.task_key))){
   if(Number(row.enabled)===1)stmts.push(env.DB.prepare('UPDATE jobs SET group_id=?,enabled=0,updated_at=? WHERE id=?').bind(group.id,now,row.id));
  }
 }
 return stmts;
}
function moduleTitle(module:string){return manifests.find(m=>m.id===module)?.title||module;}
function cookieValue(cookie:string,name:string){return cookie.split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='))?.slice(name.length+1).trim()||'';}
// The task-center APIs only require a device id (cuid) parameter and accept any
// stable value; Baidu's passport QR login never issues BAIDUCUID, so generate
// one when the caller did not supply it. Without it App sign-in always fails
// with "缺少有效 cuid".
function withBaiduCuid(module:string,credentials:{cookie:string;cuid?:string;headers?:Record<string,string>}){
 if(module!=='baidu-netdisk'||credentials.cuid)return credentials;
 const fromCookie=cookieValue(credentials.cookie,'BAIDUCUID');
 return {...credentials,cuid:fromCookie||crypto.randomUUID().replaceAll('-','').toUpperCase()};
}
// Upstream login checks fail with opaque errors today. Translate them into an
// actionable message so a rejected Cookie is not reported as an internal error.
async function checkIdentity(env:Env,module:string,credentials:Record<string,unknown>){
 try{return await verifiedIdentity(env,module,credentials);}
 catch(error){
  if(error instanceof SessionExpiredError)throw new HttpError(422,'UPSTREAM_SESSION_EXPIRED',`${moduleTitle(module)}登录态已失效，请重新登录后导入新的 Cookie`);
  const hint=module==='baidu-netdisk'?'BDUSS、STOKEN':'SESSDATA、bili_jct';
  throw new HttpError(422,'UPSTREAM_IDENTITY_FAILED',`无法通过${moduleTitle(module)}登录态校验，请确认 Cookie 中的 ${hint} 完整有效，且账号仍在登录状态`);
 }
}
async function prepareAccountBinding(env:Env,owner:string,module:string,label:string,credentials:{cookie:string;cuid?:string;headers?:Record<string,string>},group:GroupRow,targetId?:string,resumeJobs=false){
 await requireRunning(env);await takeRate(env,'account-check:'+owner,15,3600000);
 const old=targetId?await getAccount(env,targetId,owner):null;
 if(old)assert(old.module_id===module,404,'NOT_FOUND','账号不属于该平台');
 else await checkLimit(env,owner,'accounts',(await quotas(env,owner)).max_accounts);
 const id=targetId||crypto.randomUUID();
 const schedule=jsonSafeParse<any>(group.schedule_json,null)||defaultSchedule();
 const jobs=!old||resumeJobs?await jobStatements(env,group,module,schedule,{...(!old?{newAccountId:id}:{}),onlyAccountId:id}):[];
 const cookie=cookieInput(credentials.cookie);
 const input=withBaiduCuid(module,{...credentials,cookie});
 const identity=await checkIdentity(env,module,input);
 if(old){if(old.identity_verified_at)assert(identity.fingerprint===old.fingerprint,409,'DIFFERENT_ACCOUNT','新凭据必须属于原来的上游账号');else await noUnsettled(env,owner,id);}
 const encrypted=await encrypt(env.DATA_KEY,owner,id,{...input,externalId:identity.externalId});
 const now=Date.now();
 const account=old
  ?env.DB.prepare('UPDATE accounts SET label=?,fingerprint=?,credentials_enc=?,identity_verified_at=?,updated_at=?,enabled=? WHERE id=? AND owner_user_id=?').bind(label,identity.fingerprint,encrypted,now,now,resumeJobs?1:old.enabled,id,owner)
  :env.DB.prepare('INSERT INTO accounts(id,owner_user_id,module_id,label,fingerprint,credentials_enc,config_json,enabled,group_id,created_at,updated_at,identity_verified_at) VALUES(?,?,?,?,?,?,?,1,?,?,?,?)').bind(id,owner,module,label,identity.fingerprint,encrypted,group.config_json,group.id,now,now,now);
 const ownerGuard=mutationGuard(env,"EXISTS(SELECT 1 FROM users WHERE id=? AND status='active')"+(old?' AND EXISTS(SELECT 1 FROM accounts WHERE id=? AND owner_user_id=? AND module_id=? AND fingerprint=? AND identity_verified_at IS ?)':''),[owner,...(old?[id,owner,module,old.fingerprint,old.identity_verified_at??null]:[])]);
 return {id,statements:[ownerGuard.before,groupInsert(env,group),account,...jobs,ownerGuard.after]};
}

export function registerPlatformRoutes(app:App){
 app.get('/api/v1/platforms',async c=>{
  const u=user(c);
  const groups=await c.env.DB.prepare('SELECT * FROM platform_groups WHERE owner_user_id=?').bind(u.id).all<GroupRow>();
  const flags=await setting<any>(c.env,'modules_enabled',{'baidu-netdisk':true,'bilibili-vip':true});
  const stats=await c.env.DB.prepare(`SELECT a.module_id,
   count(DISTINCT a.id) accounts,
   count(DISTINCT CASE WHEN a.enabled=1 THEN a.id END) enabled_accounts,
   count(DISTINCT CASE WHEN j.enabled=1 THEN j.id END) enabled_jobs,
   min(CASE WHEN j.enabled=1 THEN j.next_run_at END) next_run_at
   FROM accounts a LEFT JOIN jobs j ON j.account_id=a.id AND j.owner_user_id=a.owner_user_id
   WHERE a.owner_user_id=? GROUP BY a.module_id`).bind(u.id).all<any>();
  const runs=await c.env.DB.prepare("SELECT a.module_id,r.status,count(*) n FROM job_runs r JOIN jobs j ON j.id=r.job_id JOIN accounts a ON a.id=j.account_id WHERE r.owner_user_id=? AND r.created_at>=? GROUP BY a.module_id,r.status").bind(u.id,Date.now()-86400000).all<any>();
  return c.json({items:manifests.map(m=>{
   const group=groups.results.find(g=>g.module_id===m.id),st=stats.results.find(x=>x.module_id===m.id);
   let success=0,error=0;
   for(const row of runs.results.filter(x=>x.module_id===m.id)){
    if(['succeeded','already_done'].includes(row.status))success+=Number(row.n);
    else if(['failed','waiting_verification'].includes(row.status))error+=Number(row.n);
   }
   return {module:{...m,enabled:flags?.[m.id]!==false},group:groupView(group,m.id),stats:{accounts:Number(st?.accounts||0),enabled_accounts:Number(st?.enabled_accounts||0),enabled_jobs:Number(st?.enabled_jobs||0),next_run_at:st?.next_run_at||null,today_success:success,today_error:error}};
  })});
 });
 app.get('/api/v1/platforms/:module',async c=>{
  const u=user(c),module=moduleOf(c);
  const group=await c.env.DB.prepare('SELECT * FROM platform_groups WHERE owner_user_id=? AND module_id=?').bind(u.id,module).first<GroupRow>();
  const accounts=await c.env.DB.prepare('SELECT * FROM accounts WHERE owner_user_id=? AND module_id=? ORDER BY created_at DESC,id').bind(u.id,module).all<any>();
  const jobs=await c.env.DB.prepare('SELECT j.id,j.account_id,j.task_key,j.schedule_json,j.enabled,j.next_run_at FROM jobs j JOIN accounts a ON a.id=j.account_id WHERE j.owner_user_id=? AND a.module_id=? ORDER BY j.created_at,j.id').bind(u.id,module).all<any>();
  const recent=await c.env.DB.prepare('SELECT r.id,r.status,r.created_at,r.manual,j.task_key,a.label account_label FROM job_runs r JOIN jobs j ON j.id=r.job_id JOIN accounts a ON a.id=j.account_id WHERE r.owner_user_id=? AND a.module_id=? ORDER BY r.created_at DESC LIMIT 10').bind(u.id,module).all<any>();
  const flags=await setting<any>(c.env,'modules_enabled',{'baidu-netdisk':true,'bilibili-vip':true});
  const manifest=manifests.find(m=>m.id===module)!;
  return c.json({module:{...manifest,enabled:flags?.[module]!==false},group:groupView(group,module),accounts:accounts.results.map(publicAccount),jobs:jobs.results.map((j:any)=>({...j,enabled:!!j.enabled})),recent:recent.results});
 });
 app.put('/api/v1/platforms/:module',async c=>{
  const u=user(c),module=moduleOf(c);
  await moduleEnabled(c.env,module);
  const body=z.object({features:z.array(z.string()).max(20),schedule:scheduleSchema,config:z.record(z.string(),z.unknown()).default({}),notify:notifySchema.nullable().default(null),riskAccepted:z.boolean().default(false)}).strict().parse(await c.req.json());
  const previous=await ensureGroup(c.env,u.id,module);
  const features=await validateFeatures(c.env,module,body.features,body.riskAccepted,jsonSafeParse<string[]>(previous.features_json,[]));
  const config={...defaultConfig(module),...validateModuleSettings(module,body.config)};
  const notify=body.notify===null?null:await validateNotify(c.env,u.id,body.notify);
  const now=Date.now();
  const group:GroupRow={...previous,config_json:JSON.stringify(config),schedule_json:JSON.stringify(body.schedule),notify_json:notify===null?null:JSON.stringify(notify),features_json:JSON.stringify(features),updated_at:now};
  const jobs=await jobStatements(c.env,group,module,body.schedule);
  await c.env.DB.batch([groupInsert(c.env,group,true),...jobs,auditStatement(c.env,u.id,'platform.update',module,{features})]);
  return c.json({ok:true,group:groupView(group,module)});
 });
 app.post('/api/v1/platforms/:module/accounts',async c=>{
  const u=user(c),module=moduleOf(c);
  await moduleEnabled(c.env,module);
  const body=z.object({label:z.string().min(1).max(50),credentials:credentialsSchema}).strict().parse(await c.req.json());
  const group=await ensureGroup(c.env,u.id,module);
  const account=await prepareAccountBinding(c.env,u.id,module,body.label,body.credentials,group);
  await c.env.DB.batch([...account.statements,auditStatement(c.env,u.id,'account.create',account.id,{module_id:module})]);
  return c.json({id:account.id,ok:true},201);
 });
 app.patch('/api/v1/platforms/:module/accounts/:id',async c=>{
  const u=user(c),module=moduleOf(c),old=await getAccount(c.env,c.req.param('id'),u.id);
  assert(String(old.module_id)===module,404,'NOT_FOUND','账号不属于该平台');
  const body=z.object({label:z.string().min(1).max(50).optional(),enabled:z.boolean().optional(),credentials:credentialsSchema.optional(),resumeJobs:z.boolean().default(false)}).strict().parse(await c.req.json());
  const id=String(old.id);
  let creds=String(old.credentials_enc),fp=String(old.fingerprint),verified=old.identity_verified_at;
  if(body.credentials){
   await requireRunning(c.env);await takeRate(c.env,'account-check:'+u.id,15,3600000);
   const input=withBaiduCuid(module,{...body.credentials,cookie:cookieInput(body.credentials.cookie)});
   const identity=await checkIdentity(c.env,module,input);
   if(verified)assert(identity.fingerprint===fp,409,'DIFFERENT_ACCOUNT','New credentials must belong to the same upstream account');
   else await noUnsettled(c.env,u.id,id);
   fp=identity.fingerprint;creds=await encrypt(c.env.DATA_KEY,u.id,id,{...input,externalId:identity.externalId});verified=Date.now();
  }
  if(body.enabled===true||body.resumeJobs){assert(verified,409,'REVERIFY_REQUIRED','请先重新验证账号凭据再启用');await moduleEnabled(c.env,module);assert(body.enabled!==false,400,'INVALID_RESUME','恢复任务时不能同时暂停账号');}
  const statements=[c.env.DB.prepare('UPDATE accounts SET label=?,enabled=?,credentials_enc=?,fingerprint=?,updated_at=?,identity_verified_at=? WHERE id=? AND owner_user_id=?').bind(body.label??old.label,body.resumeJobs?1:body.enabled===undefined?old.enabled:body.enabled?1:0,creds,fp,Date.now(),verified??null,id,u.id)];
  if(body.resumeJobs){const group=await ensureGroup(c.env,u.id,module);statements.push(groupInsert(c.env,group),...await jobStatements(c.env,group,module,jsonSafeParse<any>(group.schedule_json,null)||defaultSchedule(),{onlyAccountId:id}));}
  if(body.enabled===false)statements.push(c.env.DB.prepare('UPDATE jobs SET enabled=0,updated_at=? WHERE account_id=? AND owner_user_id=?').bind(Date.now(),id,u.id));
  const guard=mutationGuard(c.env,'EXISTS(SELECT 1 FROM accounts WHERE id=? AND owner_user_id=? AND module_id=? AND fingerprint=?)',[id,u.id,module,old.fingerprint]);
  await c.env.DB.batch([guard.before,...statements,auditStatement(c.env,u.id,'account.update',id),guard.after]);
  return c.json({ok:true});
 });
 app.delete('/api/v1/platforms/:module/accounts/:id',async c=>{
  const u=user(c),module=moduleOf(c),id=c.req.param('id'),account=await getAccount(c.env,id,u.id);
  assert(String(account.module_id)===module,404,'NOT_FOUND','账号不属于该平台');
  // waiting_retry can represent a submitted operation awaiting read-only
  // reconciliation. Never erase it as if it were an unsubmitted queue item.
  const blocking=await c.env.DB.prepare("SELECT r.id FROM job_runs r JOIN jobs j ON j.id=r.job_id WHERE r.owner_user_id=? AND j.account_id=? AND (r.status IN ('running','waiting_verification','waiting_retry') OR (r.status IN ('scheduled','queued') AND EXISTS(SELECT 1 FROM job_steps s WHERE s.run_id=r.id AND s.status IN ('submitted','unknown','waiting_verification')))) LIMIT 1").bind(u.id,id).first();
  assert(!blocking,409,'UNSETTLED_RUN','该账号有正在执行或等待人工核对的运行记录，请先在运行记录中处理后再删除');
  // Purge first: the coordinator refuses to purge an account with an unsettled
  // external operation, and the pending runs must stay untouched in that case.
  const purged=await c.env.ACCOUNTS.get(c.env.ACCOUNTS.idFromName('account:'+account.fingerprint)).fetch('https://internal/purge',{method:'POST',body:JSON.stringify({confirm:true})});
  assert(purged.ok,409,'UNRESOLVED_ASSET','该账号存在未结清的外部操作，暂不能删除');
  const now=Date.now();
  await c.env.DB.batch([
   c.env.DB.prepare("UPDATE job_runs SET status='canceled',finished_at=? WHERE owner_user_id=? AND status IN ('scheduled','queued') AND job_id IN (SELECT id FROM jobs WHERE account_id=?)").bind(now,u.id,id),
   c.env.DB.prepare("UPDATE outbox SET status='canceled',lease_token=NULL,lease_until=NULL WHERE owner_user_id=? AND kind='run' AND ref_id IN (SELECT id FROM job_runs WHERE job_id IN (SELECT id FROM jobs WHERE account_id=?))").bind(u.id,id),
  ]);
  await c.env.DB.prepare('DELETE FROM accounts WHERE id=? AND owner_user_id=?').bind(id,u.id).run();
  await audit(c.env,u.id,'account.delete',id);
  return c.json({ok:true});
 });
 app.post('/api/v1/platforms/:module/accounts/:id/probe',async c=>{
  const u=user(c),module=moduleOf(c);
  await requireRunning(c.env);await takeRate(c.env,'account-check:'+u.id,15,3600000);
  const account=await getAccount(c.env,c.req.param('id'),u.id);
  assert(String(account.module_id)===module,404,'NOT_FOUND','账号不属于该平台');
  const credentials=await decryptConfig<Record<string,unknown>>(c.env,u.id,String(account.id),String(account.credentials_enc));
  const identity=await checkIdentity(c.env,module,credentials);
  if(account.identity_verified_at)assert(identity.fingerprint===account.fingerprint,409,'DIFFERENT_ACCOUNT','账号身份不一致');
  else{await noUnsettled(c.env,u.id,String(account.id));await c.env.DB.prepare('UPDATE accounts SET fingerprint=?,identity_verified_at=? WHERE id=? AND owner_user_id=?').bind(identity.fingerprint,Date.now(),account.id,u.id).run();}
  const moduleDef=moduleDefinition(module);assert(moduleDef,400,'INVALID_MODULE','未知模块');
  const result=await moduleDef.probe(credentials,jsonSafeParse<Record<string,unknown>>(String(account.config_json),{}));
  return c.json({ok:true,readOnly:true,checked_at:Date.now(),result:sanitizeReport(result)});
 });
 app.post('/api/v1/platforms/:module/run',async c=>{
  const u=user(c),module=moduleOf(c);
  const body=z.object({account_id:z.string().uuid().optional(),riskAccepted:z.boolean().default(false)}).strict().parse((await c.req.json().catch(()=>null))??{});
  const idem=c.req.header('Idempotency-Key');
  assert(idem&&idem.length>=12&&idem.length<=100,400,'IDEMPOTENCY_KEY_REQUIRED','必须提供 Idempotency-Key');
  const requestKey=await sha256(`${u.id}:platform:${module}:${idem}`),requestHash=await sha256(JSON.stringify(body));
  const replay=async()=>{
   const row=await c.env.DB.prepare('SELECT request_hash,result_json FROM platform_run_requests WHERE request_key=? AND owner_user_id=?').bind(requestKey,u.id).first<{request_hash:string;result_json:string}>();
   if(!row)return null;
   assert(row.request_hash===requestHash,409,'IDEMPOTENCY_CONFLICT','同一 Idempotency-Key 不能用于不同请求');
   const runs=jsonSafeParse<string[]>(row.result_json,[]);return {ok:true,queued:runs.length,runs,replayed:true};
  };
  const previous=await replay();if(previous)return c.json(previous);
  await moduleEnabled(c.env,module);await requireRunning(c.env);
  if(body.account_id){const account=await getAccount(c.env,body.account_id,u.id);assert(account.module_id===module,404,'NOT_FOUND','账号不属于该平台');}
  const sql=`SELECT j.* FROM jobs j JOIN accounts a ON a.id=j.account_id WHERE j.owner_user_id=? AND a.module_id=? AND j.enabled=1 AND a.enabled=1 AND a.identity_verified_at IS NOT NULL${body.account_id?' AND a.id=?':''} ORDER BY j.created_at,j.id LIMIT 21`;
  const jobs=body.account_id?await c.env.DB.prepare(sql).bind(u.id,module,body.account_id).all<JobRecord>():await c.env.DB.prepare(sql).bind(u.id,module).all<JobRecord>();
  assert(jobs.results.length,409,'NO_ACTIVE_JOB','没有可执行的功能，请先开启功能并添加账号');
  assert(jobs.results.length<=20,409,'BATCH_TOO_LARGE','单次最多运行20个任务，请选择单个账号分批执行');
  if(jobs.results.some(j=>j.task_key==='bili.exchange')){
   assert(await setting(c.env,'bili_exchange_allowed',false),403,'EXCHANGE_DISABLED','兑换功能未开放');
   assert(body.riskAccepted,403,'RISK_ACCEPTANCE_REQUIRED','兑换会实际消耗 B 币券，请先确认风险');
  }
  const now=Date.now(),specs=jobs.results.map(job=>({job,windowKey:`manual:platform:${requestKey}:${job.id}`,manual:true,at:now}));
  const before=[c.env.DB.prepare('INSERT INTO platform_run_requests(request_key,owner_user_id,module_id,request_hash,result_json,created_at) VALUES(?,?,?,?,?,?)').bind(requestKey,u.id,module,requestHash,'[]',now)];
  const after=[c.env.DB.prepare('UPDATE platform_run_requests SET result_json=(SELECT json_group_array(id) FROM (SELECT id FROM job_runs WHERE owner_user_id=? AND ('+specs.map(()=>'(job_id=? AND window_key=?)').join(' OR ')+') ORDER BY id)) WHERE request_key=? AND owner_user_id=?').bind(u.id,...specs.flatMap(v=>[v.job.id,v.windowKey]),requestKey,u.id),auditStatement(c.env,u.id,'platform.run',module,{count:specs.length})];
  let runIds:string[];
  try{runIds=await queueRunBatch(c.env,specs,{publish:true,before,after});}
  catch(error){const completed=await replay();if(completed)return c.json(completed);throw error;}
  return c.json({ok:true,queued:runIds.length,runs:runIds.sort()});
 });
 // The authorization session owns its target account and a bounded poll lease.
 app.post('/api/v1/platforms/:module/qr/start',async c=>{
  const u=user(c),module=moduleOf(c);
  assert(module==='baidu-netdisk',400,'UNSUPPORTED','该平台暂不支持扫码登录');
  const body=z.object({accountId:z.string().uuid().optional(),resumeJobs:z.boolean().default(false)}).strict().parse((await c.req.json().catch(()=>null))??{});
  await moduleEnabled(c.env,module);await requireRunning(c.env);
  await takeRate(c.env,'qr-start:'+u.id,10,3600000);
  if(body.accountId){const a=await getAccount(c.env,body.accountId,u.id);assert(a.module_id===module,404,'NOT_FOUND','账号不属于该平台');}
  else await checkLimit(c.env,u.id,'accounts',(await quotas(c.env,u.id)).max_accounts);
  const qr=await baiduQrStart();
  const now=Date.now(),id=crypto.randomUUID(),expires=now+180000;
  await c.env.DB.batch([
   c.env.DB.prepare('DELETE FROM login_challenges WHERE id IN(SELECT id FROM login_challenges WHERE expires_at<? AND (lease_until IS NULL OR lease_until<?) LIMIT 100)').bind(now,now),
   c.env.DB.prepare('INSERT INTO login_challenges(id,owner_user_id,module_id,sign,status,created_at,expires_at,target_account_id,resume_jobs) VALUES(?,?,?,?,?,?,?,?,?)').bind(id,u.id,module,qr.sign,'pending',now,expires,body.accountId??null,body.resumeJobs?1:0)
  ]);
  return c.json({id,qr:qr.qr,auth_url:baiduAuthUrl(qr.sign),expires_at:expires});
 });
 app.post('/api/v1/platforms/:module/qr/:id/poll',async c=>{
  const u=user(c),module=moduleOf(c);
  assert(module==='baidu-netdisk',400,'UNSUPPORTED','该平台暂不支持扫码登录');
  // Pause/module checks precede ANY upstream work, including unconfirmed polls.
  await requireRunning(c.env);await moduleEnabled(c.env,module);
  await takeRate(c.env,'qr-poll:'+u.id,120,180000);
  const body=z.object({label:z.string().min(1).max(50).default('百度网盘账号'),accountId:z.string().uuid().optional(),resumeJobs:z.boolean().optional()}).strict().parse((await c.req.json().catch(()=>null))??{});
  const challenge=await c.env.DB.prepare('SELECT * FROM login_challenges WHERE id=? AND owner_user_id=? AND module_id=?').bind(c.req.param('id'),u.id,module).first<any>();
  assert(challenge,404,'NOT_FOUND','扫码会话不存在');
  if(body.accountId!==undefined)assert(body.accountId===challenge.target_account_id,409,'QR_TARGET_CHANGED','不能更改扫码会话绑定的账号');
  if(body.resumeJobs!==undefined)assert(Number(body.resumeJobs)===Number(challenge.resume_jobs),409,'QR_TARGET_CHANGED','不能更改扫码会话的恢复选项');
  if(challenge.status==='confirmed'&&challenge.account_id)return c.json({status:'confirmed',account_id:challenge.account_id});
  if(challenge.status==='failed')return c.json({status:'failed',message:'本次绑定未完成，请重新扫码或导入 Cookie'});
  const now=Date.now();
  assert(Number(challenge.expires_at)>now,410,'QR_EXPIRED','二维码已过期，请重新生成');
  if(challenge.status==='processing'){
   if(Number(challenge.lease_until)>now)return c.json({status:'processing',retry_after_ms:2500});
   await c.env.DB.prepare("UPDATE login_challenges SET status='failed',last_error='PROCESSING_INTERRUPTED',lease_token=NULL,lease_until=NULL WHERE id=? AND status='processing' AND lease_until<=?").bind(challenge.id,now).run();
   return c.json({status:'failed',message:'绑定中断，请重新扫码；不会把未完成的绑定视为成功'});
  }
  assert(Number(challenge.poll_count)<60,429,'QR_POLL_LIMIT','本次二维码查询次数已用完，请重新生成');
  if(Number(challenge.lease_until)>now||Number(challenge.next_poll_at)>now)return c.json({status:'pending',retry_after_ms:2500});
  const lease=crypto.randomUUID();
  const claimed=await c.env.DB.prepare("UPDATE login_challenges SET lease_token=?,lease_until=?,poll_count=poll_count+1,next_poll_at=? WHERE id=? AND owner_user_id=? AND status='pending' AND expires_at>? AND poll_count<60 AND next_poll_at<=? AND (lease_until IS NULL OR lease_until<=?) RETURNING id").bind(lease,now+120000,now+2000,challenge.id,u.id,now,now,now).first();
  if(!claimed)return c.json({status:'pending',retry_after_ms:2500});
  let processing=false;
  try{
   const state=await baiduQrPoll(String(challenge.sign));
   if(!(state.status===0&&state.v))return c.json({status:state.status===1?'scanned':'pending',retry_after_ms:2500});
   await requireRunning(c.env);await moduleEnabled(c.env,module);
   const moved=await c.env.DB.prepare("UPDATE login_challenges SET status='processing' WHERE id=? AND lease_token=? AND status='pending' RETURNING id").bind(challenge.id,lease).first();
   assert(moved,409,'QR_STATE_CHANGED','扫码会话状态已变化，请重新生成');processing=true;
   const cookie=await baiduQrCookie(state.v);
   const group=await ensureGroup(c.env,u.id,module);
   const target=challenge.target_account_id?await getAccount(c.env,String(challenge.target_account_id),u.id):null;
   const account=await prepareAccountBinding(c.env,u.id,module,target?String(target.label):body.label,{cookie},group,challenge.target_account_id||undefined,!!challenge.resume_jobs);
   const guard=mutationGuard(c.env,"EXISTS(SELECT 1 FROM login_challenges WHERE id=? AND owner_user_id=? AND status='processing' AND lease_token=? AND lease_until>?)",[challenge.id,u.id,lease,Date.now()]);
   await c.env.DB.batch([
    guard.before,
    ...account.statements,
    c.env.DB.prepare("UPDATE login_challenges SET status='confirmed',account_id=?,consumed_at=?,lease_token=NULL,lease_until=NULL,last_error=NULL WHERE id=? AND lease_token=? AND status='processing'").bind(account.id,Date.now(),challenge.id,lease),
    auditStatement(c.env,u.id,target?'account.update':'account.create',account.id,{module_id:module,via:'qr'}),guard.after
   ]);
   return c.json({status:'confirmed',account_id:account.id});
  }catch(error){
   if(processing)await c.env.DB.prepare("UPDATE login_challenges SET status='failed',last_error='BINDING_FAILED',lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=? AND status='processing'").bind(challenge.id,lease).run();
   throw error;
  }finally{
   await c.env.DB.prepare("UPDATE login_challenges SET lease_token=NULL,lease_until=NULL,next_poll_at=? WHERE id=? AND lease_token=? AND status='pending'").bind(Date.now()+2000,challenge.id,lease).run();
  }
 });
}
