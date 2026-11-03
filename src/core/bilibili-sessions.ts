import type {Env} from './types.ts';
import {encrypt} from './crypto.ts';
import {decryptConfig} from './secrets.ts';
import {setting} from './db.ts';
import {mutationGuard} from './mutation-guard.ts';
import {upstreamFetch} from './upstream-fetch.ts';
import {verifiedIdentity,SessionExpiredError} from './identity.ts';
import {BiliAuthError,biliRefreshInfo,biliRefreshCsrf,biliRefresh,biliConfirm} from './bilibili-auth.ts';

const DAY=86400000,RETRY=900000;
type Credentials=Record<string,unknown>&{cookie:string;refresh_token?:string;bili_refresh_pending?:{phase:'refreshing'|'confirming';old_token?:string;attempts?:number}};
export class BiliSessionUnavailable extends Error{constructor(){super('B站登录状态正在续期或稍后重试，尚未执行任务');}}

// These statements must share the account mutation's transaction. Even metadata
// edits must not write a stale credentials_enc snapshot over a completed rotation.
export function credentialMutationGuard(env:Env,account:any){
 return mutationGuard(env,'EXISTS(SELECT 1 FROM accounts WHERE id=? AND owner_user_id=? AND credentials_enc=?) AND NOT EXISTS(SELECT 1 FROM bili_sessions WHERE account_id=? AND lease_until>?)',[account.id,account.owner_user_id,account.credentials_enc,account.id,Date.now()]);
}
export function biliSessionStatements(env:Env,module:string,id:string,credentials:{refresh_token?:string}){
 if(module!=='bilibili-vip')return [];
 return credentials.refresh_token?[env.DB.prepare("INSERT INTO bili_sessions(account_id,status,next_check_at) VALUES(?,'ready',?) ON CONFLICT(account_id) DO UPDATE SET status='ready',next_check_at=excluded.next_check_at,last_checked_at=NULL,last_refreshed_at=NULL,lease_token=NULL,lease_until=NULL").bind(id,Date.now())]:[env.DB.prepare('DELETE FROM bili_sessions WHERE account_id=?').bind(id)];
}
export async function dispatchBiliSessionChecks(env:Env){
 if(env.BACKGROUND_PAUSED==='true'||env.MAINTENANCE_MODE==='true'||await setting(env,'maintenance',false))return;
 const flags=await setting<any>(env,'modules_enabled',{});if(flags['bilibili-vip']===false)return;
 const now=Date.now();
 const rows=await env.DB.prepare("SELECT s.account_id FROM bili_sessions s JOIN accounts a ON a.id=s.account_id JOIN users u ON u.id=a.owner_user_id WHERE s.status<>'needs_login' AND s.next_check_at<=? AND (s.lease_until IS NULL OR s.lease_until<=?) AND a.enabled=1 AND a.module_id='bilibili-vip' AND a.identity_verified_at IS NOT NULL AND u.status='active' ORDER BY s.next_check_at,s.account_id LIMIT 10").bind(now,now).all<{account_id:string}>();
 for(const row of rows.results)await env.TASK_QUEUE.send({kind:'credential',id:row.account_id});
}

// Called only inside AccountCoordinator.exclusive, sharing the UID lock with
// business tasks. The D1 lease also excludes public credential import endpoints.
export async function ensureBiliSession(env:Env,accountId:string,notify=true):Promise<Credentials>{
 const account=await env.DB.prepare('SELECT * FROM accounts WHERE id=?').bind(accountId).first<any>();
 if(!account)throw new BiliSessionUnavailable();
 const credentials=await decryptConfig<Credentials>(env,account.owner_user_id,account.id,account.credentials_enc);
 if(account.module_id!=='bilibili-vip'||!credentials.refresh_token)return credentials;
 const session=await env.DB.prepare('SELECT * FROM bili_sessions WHERE account_id=?').bind(account.id).first<any>();
 if(!session)return credentials;
 if(session.status==='needs_login')throw new SessionExpiredError();
 const now=Date.now();
 if(session.next_check_at>now){if(credentials.bili_refresh_pending||session.status==='retry')throw new BiliSessionUnavailable();return credentials;}
 const flags=await setting<any>(env,'modules_enabled',{}),owner=await env.DB.prepare('SELECT status FROM users WHERE id=?').bind(account.owner_user_id).first<any>();
 if(!account.enabled||!account.identity_verified_at||owner?.status!=='active'||flags['bilibili-vip']===false||env.BACKGROUND_PAUSED==='true'||env.MAINTENANCE_MODE==='true'||await setting(env,'maintenance',false))throw new BiliSessionUnavailable();
 const fetcher=upstreamFetch(env),lease=crypto.randomUUID();
 const taken=await env.DB.prepare("UPDATE bili_sessions SET lease_token=?,lease_until=? WHERE account_id=? AND status<>'needs_login' AND next_check_at<=? AND (lease_until IS NULL OR lease_until<=?) RETURNING account_id").bind(lease,now+180000,account.id,now,now).first();
 if(!taken)throw new BiliSessionUnavailable();
 let current=credentials,packed=String(account.credentials_enc),ambiguous=false;
 async function save(value:Credentials){
  const next=await encrypt(env.DATA_KEY,account.owner_user_id,account.id,value);
  const changed=await env.DB.prepare('UPDATE accounts SET credentials_enc=?,updated_at=? WHERE id=? AND credentials_enc=? AND EXISTS(SELECT 1 FROM bili_sessions WHERE account_id=? AND lease_token=? AND lease_until>?) RETURNING id').bind(next,Date.now(),account.id,packed,account.id,lease,Date.now()).first();
  if(!changed)throw new BiliSessionUnavailable();
  current=value;packed=next;
 }
 try{
  const latest=await env.DB.prepare('SELECT credentials_enc FROM accounts WHERE id=?').bind(account.id).first<any>();
  if(latest?.credentials_enc!==packed)throw new BiliSessionUnavailable();
  // A crash/timeout after submitting refresh has an unknown result. It is never
  // safe to replay that POST using the old token, even after the lease expires.
  if(current.bili_refresh_pending?.phase==='refreshing')throw new BiliAuthError(true);
  if(!current.bili_refresh_pending){
   const info=await biliRefreshInfo(current.cookie,fetcher);
   if(info.refresh){
    const csrf=await biliRefreshCsrf(current.cookie,info.timestamp,fetcher),oldToken=current.refresh_token!;
    await save({...current,bili_refresh_pending:{phase:'refreshing'}});
    ambiguous=true;
    const fresh=await biliRefresh(current.cookie,oldToken,csrf,fetcher);
    await save({...current,...fresh,bili_refresh_pending:{phase:'confirming',old_token:oldToken}});
    ambiguous=false;
   }
  }
  if(current.bili_refresh_pending?.phase==='confirming'){
   if((current.bili_refresh_pending.attempts||0)>=3)throw new BiliAuthError(true);
   const identity=await verifiedIdentity(env,'bilibili-vip',current,fetcher);
   if(identity.fingerprint!==account.fingerprint)throw new BiliAuthError(true);
   await save({...current,bili_refresh_pending:{...current.bili_refresh_pending,attempts:(current.bili_refresh_pending.attempts||0)+1}});
   await biliConfirm(current.cookie,current.bili_refresh_pending.old_token!,fetcher);
   const clean={...current};delete clean.bili_refresh_pending;await save(clean);
   await env.DB.prepare('UPDATE bili_sessions SET last_refreshed_at=? WHERE account_id=? AND lease_token=?').bind(Date.now(),account.id,lease).run();
  }
  await env.DB.prepare("UPDATE bili_sessions SET status='ready',last_checked_at=?,next_check_at=? WHERE account_id=? AND lease_token=?").bind(Date.now(),Date.now()+DAY,account.id,lease).run();
  return current;
 }catch(error){
  // A documented risk/rate-limit rejection is distinct from a lost response.
  // Keep the old credentials and retry later; do not label it an expired login.
  if(ambiguous&&error instanceof BiliAuthError&&[-352,-412,-509,403,412,429].includes(error.code??0)){
   const clean={...current};delete clean.bili_refresh_pending;await save(clean);ambiguous=false;
  }
  if(ambiguous||error instanceof SessionExpiredError||error instanceof BiliAuthError&&error.relogin){
   await expireBiliSession(env,account.id,lease,notify);
   throw new SessionExpiredError();
  }
  await env.DB.prepare("UPDATE bili_sessions SET status='retry',next_check_at=? WHERE account_id=? AND lease_token=?").bind(Date.now()+RETRY,account.id,lease).run();
  throw new BiliSessionUnavailable();
 }finally{await env.DB.prepare('UPDATE bili_sessions SET lease_token=NULL,lease_until=NULL WHERE account_id=? AND lease_token=?').bind(account.id,lease).run();}
}

async function expireBiliSession(env:Env,accountId:string,lease:string,notify:boolean){
 const now=Date.now(),summary='B站登录凭据无法自动续期，账号和计划已暂停，请在账号设置中重新扫码登录。';
 // One failed check per credential generation, using existing event routing and
 // notification preferences. No run quota is charged for a session check.
 const job=notify?await env.DB.prepare('SELECT id,owner_user_id FROM jobs WHERE account_id=? ORDER BY id LIMIT 1').bind(accountId).first<any>():null;
 const id=crypto.randomUUID();
 const guard=mutationGuard(env,'EXISTS(SELECT 1 FROM bili_sessions WHERE account_id=? AND lease_token=?)',[accountId,lease]);
 await env.DB.batch([
  guard.before,
  env.DB.prepare("UPDATE bili_sessions SET status='needs_login',last_checked_at=? WHERE account_id=? AND lease_token=?").bind(now,accountId,lease),
  env.DB.prepare('UPDATE accounts SET enabled=0 WHERE id=?').bind(accountId),
  env.DB.prepare('UPDATE jobs SET enabled=0 WHERE account_id=?').bind(accountId),
  ...(job?[
   env.DB.prepare("INSERT INTO job_runs(id,owner_user_id,job_id,window_key,status,manual,scheduled_for,finished_at,result_json,error_code,created_at) VALUES(?,?,?,?,'failed',0,?,?,?,'BILI_RELOGIN_REQUIRED',?)").bind(id,job.owner_user_id,job.id,'session:'+id,now,now,JSON.stringify({summary}),now),
   env.DB.prepare("INSERT INTO job_events(id,owner_user_id,run_id,event_type,summary,created_at) VALUES(?,?,?,'exception',?,?)").bind(crypto.randomUUID(),job.owner_user_id,id,summary,now),
  ]:[]),
  guard.after,
 ]);
}
