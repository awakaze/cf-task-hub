import type {Hono,Context} from 'hono';
import {z} from 'zod';
import type {Env,CurrentUser} from '../core/types.ts';
import {assert,HttpError} from '../core/response.ts';
import {setting,setSetting,audit,quotas} from '../core/db.ts';
import {DEFAULT_QUOTAS} from '../core/quotas.ts';
import {randomToken,sha256,encrypt,decrypt} from '../core/crypto.ts';
import {hashPasswordForUser} from '../core/password-service.ts';
import {takeRate,sanitizeReport} from '../core/safety.ts';
import {manifests} from '../core/registry.ts';
import {validateWebhookTarget} from '../core/notifications.ts';

type AppContext={Bindings:Env;Variables:{user:CurrentUser}};
type App=Hono<AppContext>;
function admin(c:Context<AppContext>){const u=c.get('user') as CurrentUser;assert(u.role==='admin',403,'ADMIN_ONLY','只有平台管理员可以操作');return u;}
const quotaSchema=z.object({max_accounts:z.number().int().min(1).max(100),max_jobs:z.number().int().min(1).max(1000),max_manual_runs:z.number().int().min(0).max(100),max_auto_runs:z.number().int().min(0).max(1000).default(10),max_notifications:z.number().int().min(0).max(500),max_channels:z.number().int().min(1).max(20)});
export function registerAdminRoutes(app:App){
 app.get('/api/v1/admin/stats',async c=>{
  admin(c);const since=Date.now()-86400000;
  const stats=await c.env.DB.batch([
   c.env.DB.prepare("SELECT count(*) n FROM users WHERE role='user' AND status='active'"),
   c.env.DB.prepare("SELECT count(*) n FROM users WHERE role='user' AND status='suspended'"),
   c.env.DB.prepare('SELECT count(*) n FROM accounts'),
   c.env.DB.prepare('SELECT count(*) n FROM jobs WHERE enabled=1'),
   c.env.DB.prepare("SELECT count(*) n FROM job_runs WHERE status IN ('succeeded','already_done') AND created_at>?").bind(since),
   c.env.DB.prepare("SELECT count(*) n FROM job_runs WHERE status IN ('failed','waiting_verification') AND created_at>?").bind(since),
   c.env.DB.prepare("SELECT count(*) n FROM outbox WHERE status IN ('pending','sending')"),
   c.env.DB.prepare("SELECT count(*) n FROM notification_deliveries WHERE status='failed'"),
  ]);
  const daily=await c.env.DB.prepare("SELECT date(created_at/1000,'unixepoch') AS day,status,count(*) AS total FROM job_runs WHERE created_at>? GROUP BY day,status ORDER BY day DESC LIMIT 50").bind(Date.now()-7*86400000).all();
  const latest=await c.env.DB.prepare("SELECT action,created_at,actor_user_id,target_id,meta_json FROM audit_logs ORDER BY created_at DESC LIMIT 30").all();
  return c.json({stats:stats.map(r=>(r.results[0] as any)?.n||0),daily:daily.results,audit:latest.results.map((v:any)=>({...v,meta_json:JSON.parse(v.meta_json)})),quotas:{...DEFAULT_QUOTAS,...await setting(c.env,'global_quotas',DEFAULT_QUOTAS)},health:{scheduler_heartbeat:await setting(c.env,'scheduler_heartbeat',null),maintenance_heartbeat:await setting(c.env,'maintenance_heartbeat',null),schema_version:await setting(c.env,'schema_version',null),note:'Application counters, not Cloudflare billing metrics'},usage:(await c.env.DB.prepare("SELECT day,kind,count FROM usage_daily WHERE scope='global' AND day>=date('now','-7 day') ORDER BY day DESC").all()).results});
 });
 app.get('/api/v1/admin/audit',async c=>{
  admin(c);const page=Number(c.req.query('page')||0);assert(Number.isSafeInteger(page)&&page>=0&&page<=10000,400,'INVALID_PAGE','Invalid page');
  const rows=await c.env.DB.prepare('SELECT id,actor_user_id,action,target_id,meta_json,created_at FROM audit_logs ORDER BY created_at DESC,id LIMIT 50 OFFSET ?').bind(page*50).all<any>();
  return c.json({items:rows.results.map(v=>({...v,meta:JSON.parse(v.meta_json),meta_json:undefined})),page,next_page:rows.results.length===50?page+1:null});
 });
 app.get('/api/v1/admin/users',async c=>{
  admin(c);const page=Math.max(0,Math.min(1000,Math.floor(Number(c.req.query('page')||0))));
  assert(Number.isFinite(page),400,'INVALID_PAGE','Invalid page');
  const results=await c.env.DB.prepare(`SELECT u.id,u.username,u.role,u.status,u.created_at,u.last_login_at,
   (SELECT count(*) FROM accounts a WHERE a.owner_user_id=u.id) accounts_count,
   (SELECT count(*) FROM jobs j WHERE j.owner_user_id=u.id) jobs_count,
   (SELECT count(*) FROM job_runs r WHERE r.owner_user_id=u.id AND r.created_at>?) daily_runs
   FROM users u ORDER BY u.created_at DESC LIMIT 30 OFFSET ?`).bind(Date.now()-86400000,page*30).all();
  return c.json({items:results.results,page,next_page:results.results.length===30?page+1:null});
 });
 app.post('/api/v1/admin/users/:id/status',async c=>{
  const actor=admin(c),id=c.req.param('id');assert(id!==actor.id,403,'FORBIDDEN','不能冻结自己的管理员账号');
  const body=z.object({status:z.enum(['active','suspended'])}).parse(await c.req.json());
  const target=await c.env.DB.prepare("SELECT * FROM users WHERE id=? AND role='user'").bind(id).first();assert(target,404,'NOT_FOUND','用户不存在');
  await c.env.DB.batch([
   c.env.DB.prepare("UPDATE users SET status=? WHERE id=? AND role='user'").bind(body.status,id),
   ...(body.status==='suspended'?[c.env.DB.prepare('UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').bind(Date.now(),id)]:[]),
  ]);
  await audit(c.env,actor.id,`user.${body.status}`,id);return c.json({ok:true});
 });
 app.post('/api/v1/admin/users/:id/password',async c=>{
  const actor=admin(c),id=c.req.param('id');
  const session=await c.env.DB.prepare('SELECT created_at FROM sessions WHERE id=?').bind(actor.sessionId).first<{created_at:number}>();assert(session&&session.created_at>Date.now()-900000,403,'REAUTH_REQUIRED','Log in again within 15 minutes before resetting a password');
  const body=z.object({password:z.string().min(1).max(128)}).strict().parse(await c.req.json());
  const target=await c.env.DB.prepare("SELECT id FROM users WHERE id=? AND role='user'").bind(id).first();assert(target,404,'NOT_FOUND','用户不存在');
  await c.env.DB.batch([
   c.env.DB.prepare('UPDATE users SET password_hash=? WHERE id=?').bind(await hashPasswordForUser(c.env,id,body.password),id),
   c.env.DB.prepare('UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').bind(Date.now(),id),
  ]);
  await audit(c.env,actor.id,'user.password_reset',id);return c.json({ok:true});
 });
 app.get('/api/v1/admin/invites',async c=>{
  admin(c);const page=Math.max(0,Math.min(1000,Math.floor(Number(c.req.query('page')||0))));assert(Number.isFinite(page),400,'INVALID_PAGE','Invalid page');
  const rs=await c.env.DB.prepare('SELECT id,label,max_uses,used_count,enabled,expires_at,created_at,created_by,code_enc FROM invites ORDER BY created_at DESC,id LIMIT 50 OFFSET ?').bind(page*50).all<any>();
  const items=await Promise.all(rs.results.map(async (v:any)=>{let code='';if(v.code_enc){try{code=(await decrypt<{code:string}>(c.env.DATA_KEY,v.created_by||'',`invite:${v.id}`,v.code_enc)).code;}catch{}}delete v.code_enc;return {...v,code};}));
  return c.json({items,page,next_page:rs.results.length===50?page+1:null});
 });
 app.post('/api/v1/admin/invites',async c=>{
  const actor=admin(c);
  const body=z.object({label:z.string().max(50).default(''),max_uses:z.number().int().min(1).max(1000).default(1),expires_in_days:z.number().int().min(1).max(365).nullable().default(30),code:z.string().trim().regex(/^[A-Za-z0-9_-]+$/,'邀请码只能包含字母、数字、下划线和短横线').optional()}).parse(await c.req.json());
  const users=await c.env.DB.prepare("SELECT count(*) n FROM users WHERE role='user' AND status<>'deleted'").first<{n:number}>();
  const limit=await setting(c.env,'max_users',100);assert((users?.n||0)<limit,429,'USER_LIMIT','平台用户已达到限制');
  const code=body.code||('TH-'+randomToken(18)),id=crypto.randomUUID(),expires=body.expires_in_days===null?null:Date.now()+body.expires_in_days*86400000;
  const hash=await sha256(code);
  const duplicate=await c.env.DB.prepare('SELECT id FROM invites WHERE code_hash=?').bind(hash).first();assert(!duplicate,409,'INVITE_EXISTS','该邀请码已存在，请换一个');
  // The custom code is encrypted so administrators can read it back in the invite list.
  await c.env.DB.prepare('INSERT INTO invites(id,code_hash,code_enc,label,max_uses,expires_at,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(id,hash,await encrypt(c.env.DATA_KEY,actor.id,`invite:${id}`,{code}),body.label,body.max_uses,expires,actor.id,Date.now()).run();
  await audit(c.env,actor.id,'invite.create',id,{label:body.label,max_uses:body.max_uses});
  return c.json({ok:true,id,code,expires_at:expires},201);
 });
 app.patch('/api/v1/admin/invites/:id',async c=>{
  const actor=admin(c),id=c.req.param('id');const body=z.object({enabled:z.boolean().optional(),max_uses:z.number().int().min(1).max(1000).optional(),expires_at:z.number().int().nonnegative().nullable().optional(),label:z.string().max(50).optional()}).parse(await c.req.json());
  const i=await c.env.DB.prepare('SELECT * FROM invites WHERE id=?').bind(id).first<any>();assert(i,404,'NOT_FOUND','邀请码不存在');
  const max=body.max_uses??i.max_uses;assert(max>=i.used_count,400,'INVALID_MAX_USES','总使用次数不能小于已使用次数');
  await c.env.DB.prepare('UPDATE invites SET enabled=?,max_uses=?,expires_at=?,label=? WHERE id=?').bind(body.enabled===undefined?i.enabled:body.enabled?1:0,max,body.expires_at===undefined?i.expires_at:body.expires_at,body.label??i.label,id).run();
  await audit(c.env,actor.id,'invite.update',id,{enabled:body.enabled,max_uses:body.max_uses});return c.json({ok:true});
 });
 app.get('/api/v1/admin/settings',async c=>{
  admin(c);return c.json({modules_enabled:await setting(c.env,'modules_enabled',{'baidu-netdisk':true,'bilibili-vip':true}),bili_exchange_allowed:await setting(c.env,'bili_exchange_allowed',false),webhook_allowed_hosts:await setting(c.env,'webhook_allowed_hosts',[]),global_quotas:{...DEFAULT_QUOTAS,...await setting(c.env,'global_quotas',DEFAULT_QUOTAS)},health:{scheduler_heartbeat:await setting(c.env,'scheduler_heartbeat',null),maintenance_heartbeat:await setting(c.env,'maintenance_heartbeat',null),schema_version:await setting(c.env,'schema_version',null),note:'Application counters, not Cloudflare billing metrics'},usage:(await c.env.DB.prepare("SELECT day,kind,count FROM usage_daily WHERE scope='global' AND day>=date('now','-7 day') ORDER BY day DESC").all()).results,max_users:await setting(c.env,'max_users',100),maintenance:await setting(c.env,'maintenance',false),platform_budget:await setting(c.env,'platform_budget',{max_daily_runs:500,max_daily_notifications:500}),max_invites:await setting(c.env,'max_invites',200)});
 });
 app.put('/api/v1/admin/settings',async c=>{

  const actor=admin(c);const body=z.object({
   modules_enabled:z.record(z.string(),z.boolean()).optional(),bili_exchange_allowed:z.boolean().optional(),
   webhook_allowed_hosts:z.array(z.string().min(3).max(253)).max(100).optional(),
   global_quotas:quotaSchema.optional(),max_users:z.number().int().min(1).max(10000).optional(),
   maintenance:z.boolean().optional(),max_invites:z.number().int().min(1).max(1000).optional(),
   platform_budget:z.object({max_daily_runs:z.number().int().min(1).max(2000),max_daily_notifications:z.number().int().min(1).max(2000)}).strict().optional()
  }).strict().parse(await c.req.json());
  if(body.modules_enabled)assert(Object.keys(body.modules_enabled).every(k=>manifests.some(m=>m.id===k)),400,'INVALID_MODULE','Unknown module');
  if(body.webhook_allowed_hosts){body.webhook_allowed_hosts=[...new Set(body.webhook_allowed_hosts.map(v=>v.toLowerCase().trim()))];
   for(const host of body.webhook_allowed_hosts){assert(/^[a-z0-9.-]+$/.test(host),400,'INVALID_DOMAIN','Use a hostname without a scheme or path');try{validateWebhookTarget('https://'+host+'/',body.webhook_allowed_hosts);}catch{throw new HttpError(400,'INVALID_DOMAIN','Unsafe webhook domain');}}
  }
  const statements=Object.entries(body).map(([key,value])=>c.env.DB.prepare('INSERT INTO system_settings(key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at').bind(key,JSON.stringify(value),Date.now()));
  if(statements.length)await c.env.DB.batch(statements);
  await audit(c.env,actor.id,'system.update','global');return c.json({ok:true});
 });
 app.get('/api/v1/admin/runs',async c=>{
  admin(c);const status=c.req.query('status')||'waiting_verification',page=Number(c.req.query('page')||0);
  assert(status==='waiting_verification',400,'INVALID_STATUS','Only pending review is available here');
  assert(Number.isSafeInteger(page)&&page>=0&&page<=10000,400,'INVALID_PAGE','Invalid page');
  const rows=await c.env.DB.prepare("SELECT r.id,r.status,r.created_at,r.result_json,u.username owner_username,a.label account_label,j.task_key FROM job_runs r JOIN users u ON u.id=r.owner_user_id JOIN jobs j ON j.id=r.job_id JOIN accounts a ON a.id=j.account_id WHERE r.status='waiting_verification' ORDER BY r.created_at,r.id LIMIT 30 OFFSET ?").bind(page*30).all<any>();
  return c.json({items:rows.results.map(({result_json,...row})=>{let summary='';try{summary=String(JSON.parse(result_json||'{}').summary||'');}catch{}return {...row,summary:sanitizeReport(summary)};}),page,next_page:rows.results.length===30?page+1:null});
 });
 app.post('/api/v1/admin/runs/:id/resolve',async c=>{
  const actor=admin(c),id=c.req.param('id');
  const session=await c.env.DB.prepare('SELECT created_at FROM sessions WHERE id=?').bind(actor.sessionId).first<{created_at:number}>();
  assert(session&&session.created_at>Date.now()-900000,403,'REAUTH_REQUIRED','请在最近15分钟内重新登录后记录人工核对结果');
  const body=z.object({outcome:z.enum(['succeeded','failed']),evidence:z.string().trim().min(20).max(2000),confirmNoRepeat:z.literal(true)}).strict().parse(await c.req.json());
  assert(!/(?:BDUSS|STOKEN|SESSDATA|bili_jct|authorization|cookie|password|token)\s*[:=]\s*\S+/i.test(body.evidence),400,'SECRET_IN_EVIDENCE','核对说明不得包含 Cookie、密码或 Token；请只记录交易号、时间和实际结果');
  await takeRate(c.env,'manual-resolve:'+actor.id,20,3600000);
  const row=await c.env.DB.prepare('SELECT r.id,a.fingerprint FROM job_runs r JOIN jobs j ON j.id=r.job_id JOIN accounts a ON a.id=j.account_id WHERE r.id=?').bind(id).first<any>();
  assert(row,404,'NOT_FOUND','运行记录不存在');
  const response=await c.env.ACCOUNTS.get(c.env.ACCOUNTS.idFromName('account:'+row.fingerprint)).fetch('https://internal/resolve',{method:'POST',body:JSON.stringify({...body,runId:id,actorId:actor.id})});
  const result=await response.json<any>();
  if(!response.ok)throw new HttpError(response.status,typeof result.error==='string'?result.error:'RESOLUTION_FAILED','人工结案未完成；原检查点仍保留，请核对状态或重试同一声明');
  await audit(c.env,actor.id,'run.manual_resolution',id,{outcome:body.outcome,resolution_id:result.resolutionId});
  return c.json(result);
 });
 app.post('/api/v1/admin/maintenance/cleanup',async c=>{
  const actor=admin(c),body=z.object({beforeDays:z.number().int().min(90).max(3650).default(90),confirm:z.literal(true)}).strict().parse(await c.req.json());
  await takeRate(c.env,'cleanup:'+actor.id,5,3600000);
  const now=Date.now(),cutoff=now-body.beforeDays*86400000,assetCutoff=now-Math.max(365,body.beforeDays)*86400000;
  const rows=await c.env.DB.batch([
   c.env.DB.prepare("DELETE FROM job_runs WHERE id IN(SELECT r.id FROM job_runs r JOIN jobs j ON j.id=r.job_id WHERE r.status IN('succeeded','already_done','failed','canceled') AND r.created_at<? AND (j.task_key<>'bili.exchange' OR r.created_at<?) LIMIT 100) RETURNING id").bind(cutoff,assetCutoff),
   c.env.DB.prepare("DELETE FROM outbox WHERE id IN(SELECT id FROM outbox WHERE status IN('done','dead','canceled') AND updated_at<? LIMIT 100) RETURNING id").bind(cutoff),
   c.env.DB.prepare('DELETE FROM audit_logs WHERE id IN(SELECT id FROM audit_logs WHERE created_at<? LIMIT 100) RETURNING id').bind(assetCutoff)
  ]);
  const deleted=rows.map(r=>r.results.length);await audit(c.env,actor.id,'maintenance.cleanup','global',{before_days:body.beforeDays,deleted});
  return c.json({ok:true,deleted:{runs:deleted[0],outbox:deleted[1],audit:deleted[2]},bounded:true,protectedEvidenceRetained:true});
 });
 app.get('/api/v1/admin/quotas',async c=>{admin(c);const rows=await c.env.DB.prepare('SELECT * FROM user_quotas ORDER BY user_id LIMIT 200').all();return c.json({items:rows.results});});
 app.put('/api/v1/admin/quotas/:id',async c=>{
  const actor=admin(c),id=c.req.param('id');const b=quotaSchema.parse(await c.req.json());
  const target=await c.env.DB.prepare("SELECT id FROM users WHERE id=? AND role='user'").bind(id).first();assert(target,404,'NOT_FOUND','普通用户不存在');
  await c.env.DB.prepare('INSERT INTO user_quotas(user_id,max_accounts,max_jobs,max_manual_runs,max_auto_runs,max_notifications,max_channels) VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET max_accounts=excluded.max_accounts,max_jobs=excluded.max_jobs,max_manual_runs=excluded.max_manual_runs,max_auto_runs=excluded.max_auto_runs,max_notifications=excluded.max_notifications,max_channels=excluded.max_channels').bind(id,b.max_accounts,b.max_jobs,b.max_manual_runs,b.max_auto_runs,b.max_notifications,b.max_channels).run();
  await audit(c.env,actor.id,'quota.update',id);return c.json({ok:true});
 });
 app.get('/api/v1/admin/quotas/:id',async c=>{admin(c);const id=c.req.param('id'),u=await c.env.DB.prepare('SELECT id FROM users WHERE id=?').bind(id).first();assert(u,404,'NOT_FOUND','User not found');return c.json({effective:await quotas(c.env,id)});});
 app.delete('/api/v1/admin/invites/:id',async c=>{
  const u=admin(c),id=c.req.param('id');
  const used=await c.env.DB.prepare('SELECT id FROM users WHERE invite_id=? LIMIT 1').bind(id).first();assert(!used,409,'INVITE_IN_USE','Disable this invitation instead; registered users still reference it');
  await c.env.DB.prepare('DELETE FROM invites WHERE id=?').bind(id).run();await audit(c.env,u.id,'invite.delete',id);return c.json({ok:true});
 });
}
