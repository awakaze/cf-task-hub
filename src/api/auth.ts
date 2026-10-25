import type {Hono,Context} from 'hono';
import {getCookie,setCookie,deleteCookie} from 'hono/cookie';
import {generateRegistrationOptions,verifyRegistrationResponse,generateAuthenticationOptions,verifyAuthenticationResponse} from '@simplewebauthn/server';
import type {Env,User,CurrentUser} from '../core/types.ts';
import {sha256,randomToken,toB64,fromB64} from '../core/crypto.ts';
import {validPassword} from '../core/password.ts';
import {hashPasswordForUser,verifyPasswordForUser,beginAuthAttempt,finishAuthAttempt} from '../core/password-service.ts';
import {assert,HttpError} from '../core/response.ts';
import {audit} from '../core/db.ts';

type AppContext={Bindings:Env;Variables:{user:CurrentUser}};
type App=Hono<AppContext>;
type Ctx=Context<AppContext>;
const SESSION_AGE=30*86400,CHALLENGE_AGE=5*60*1000,RECOVERY_RESET_AGE=10*60*1000;
async function originOf(c:Ctx){
 const u=new URL(c.req.url),local=['localhost','127.0.0.1'].includes(u.hostname),pinned=c.env.APP_ORIGIN?.trim();
 assert(u.protocol==='https:'||(local&&u.protocol==='http:'),403,'HTTPS_REQUIRED','Authentication requires HTTPS');
 assert(pinned||local,503,'APP_ORIGIN_REQUIRED','Configure the final HTTPS APP_ORIGIN before using authentication');
 if(pinned){
  let configured:URL;try{configured=new URL(pinned);}catch{throw new HttpError(503,'INVALID_APP_ORIGIN','APP_ORIGIN must be an absolute HTTPS origin');}
  const configuredLocal=['localhost','127.0.0.1'].includes(configured.hostname);
  assert((configured.protocol==='https:'||(configuredLocal&&configured.protocol==='http:'))&&!configured.username&&!configured.password&&configured.pathname==='/'&&!configured.search&&!configured.hash,503,'INVALID_APP_ORIGIN','APP_ORIGIN must contain only the approved origin');
  assert(u.origin===configured.origin,403,'ORIGIN_MISMATCH','Use the configured login domain');
 }
 return {rpID:u.hostname,origin:u.origin};
}
async function freshSession(c:Ctx,u:CurrentUser){const s=await c.env.DB.prepare('SELECT created_at FROM sessions WHERE id=?').bind(u.sessionId).first<{created_at:number}>();assert(s&&s.created_at>Date.now()-900000,403,'REAUTH_REQUIRED','Log in again within 15 minutes before changing security settings');}

export async function rate(env:Env,key:string,limit:number,windowMs:number){
 const stub=env.ACCOUNTS.get(env.ACCOUNTS.idFromName('global-rate'));
 const r=await stub.fetch('https://internal/rate',{method:'POST',body:JSON.stringify({key,limit,windowMs})});
 if(!r.ok)throw new HttpError(429,'RATE_LIMIT','操作过于频繁，请稍后再试');
}
async function clientRate(c:Ctx,category:string,limit=12){
 const address=c.req.header('CF-Connecting-IP')||'unknown';
 await rate(c.env,`${category}:${await sha256(address)}`,limit,15*60000);
}
export async function currentUser(c:Ctx):Promise<CurrentUser> {
 await originOf(c);
 const token=getCookie(c,'th_session');assert(token,401,'LOGIN_REQUIRED','请先登录');
 const hash=await sha256(token);
 const row=await c.env.DB.prepare(`SELECT s.id AS sessionId,s.csrf_token_hash AS csrfHash,s.recovery_reset_expires_at,s.recovery_reset_used_at,u.* FROM sessions s JOIN users u ON s.user_id=u.id WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>? AND u.status='active'`).bind(hash,Date.now()).first<CurrentUser&{recovery_reset_expires_at:number|null;recovery_reset_used_at:number|null}>();
 assert(row,401,'SESSION_EXPIRED','登录已过期，请重新登录');
 const allowed=row.recovery_reset_used_at===null&&Number(row.recovery_reset_expires_at)>Date.now();
 return {...row,recovery_password_reset_allowed:allowed,recovery_password_reset_expires_at:allowed?row.recovery_reset_expires_at:null};
}
export async function assertCsrf(c:Ctx,user:CurrentUser):Promise<void>{
 const method=c.req.method;
 if(['GET','HEAD','OPTIONS'].includes(method))return;
 const sent=c.req.header('X-CSRF-Token')||'';
 const cookie=getCookie(c,'th_csrf')||'';
 assert(sent&&cookie&&sent===cookie&&await sha256(sent)===user.csrfHash,403,'INVALID_CSRF','CSRF 校验失败');
}
async function prepareSession(user:User,recovery=false){
 const token=randomToken(32),csrf=randomToken(24),now=Date.now();
 return {id:crypto.randomUUID(),user,token,csrf,tokenHash:await sha256(token),csrfHash:await sha256(csrf),now,expires:now+SESSION_AGE*1000,resetExpires:recovery?now+RECOVERY_RESET_AGE:null};
}
function sendSession(c:Ctx,s:Awaited<ReturnType<typeof prepareSession>>){
 const secure=new URL(c.req.url).protocol==='https:';
 setCookie(c,'th_session',s.token,{httpOnly:true,sameSite:'Strict',secure,path:'/',maxAge:SESSION_AGE});
 setCookie(c,'th_csrf',s.csrf,{httpOnly:false,sameSite:'Strict',secure,path:'/',maxAge:SESSION_AGE});
 return {user:{id:s.user.id,username:s.user.username,role:s.user.role,timezone:s.user.timezone,recovery_password_reset_allowed:!!s.resetExpires,recovery_password_reset_expires_at:s.resetExpires},csrf:s.csrf};
}
async function establishSession(c:Ctx,user:User,expectedPasswordHash?:string){
 const s=await prepareSession(user);
 await c.env.DB.prepare('INSERT INTO sessions(id,user_id,token_hash,csrf_token_hash,created_at,expires_at) SELECT ?,id,?,?,?,? FROM users WHERE id=? AND status=\'active\' AND (? IS NULL OR password_hash=?)').bind(s.id,s.tokenHash,s.csrfHash,s.now,s.expires,user.id,expectedPasswordHash??null,expectedPasswordHash??null).run();
 const created=await c.env.DB.prepare('SELECT id FROM sessions WHERE id=?').bind(s.id).first();assert(created,401,'INVALID_LOGIN','无法登录');
 return sendSession(c,s);
}
async function recoveryCodes(env:Env,userId:string):Promise<{display:string[];stmts:D1PreparedStatement[]}> {
 const display=Array.from({length:8},()=>randomToken(15));
 const stmts=await Promise.all(display.map(async code=>env.DB.prepare('INSERT INTO recovery_codes(user_id,code_hash,created_at) VALUES(?,?,?)').bind(userId,await sha256(`recovery:${userId}:${code}`),Date.now())));
 return {display,stmts};
}
function validUsername(s:string){return /^[a-zA-Z][a-zA-Z0-9_-]{2,23}$/.test(s);}
async function liveChallenge(c:Ctx,id:string,purpose:string){
 const r=await c.env.DB.prepare('DELETE FROM auth_challenges WHERE id=? AND purpose=? AND expires_at>? RETURNING *').bind(id,purpose,Date.now()).first<any>();
 assert(r,409,'CHALLENGE_EXPIRED','挑战已失效，请重新操作');return r;
}
export function registerAuthRoutes(app:App){
 // Applies to password, Passkey, recovery, status and session-management routes.
 // An approved Origin header alone is insufficient when an alternate hostname
 // still routes to the same Worker.
 app.use('/api/v1/auth/*',async(c,next)=>{await originOf(c);await next();});
 app.get('/api/v1/auth/setup-status',async c=>{
  const row=await c.env.DB.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").first();
  return c.json({needsSetup:!row,registration:'invite',password:true,passkey:'optional',version:'0.1.0',ready:true});
 });
 app.post('/api/v1/auth/register/password',async c=>{
  await clientRate(c,'register',8);
  const body=await c.req.json<any>();const username=String(body.username||'').trim();
  assert(validUsername(username),400,'INVALID_USERNAME','用户名需为 3–24 位英文、数字、下划线或短横线，且以字母开头');
  const password=String(body.password||'');
  assert(validPassword(password),400,'INVALID_PASSWORD','密码不能为空（最多 128 位）');
  const admin=await c.env.DB.prepare("SELECT id FROM users WHERE role='admin'").first();
  const isBootstrap=!admin;
  let inviteId:string|null=null;
  if(isBootstrap){
   assert(c.env.BOOTSTRAP_TOKEN&&String(body.bootstrapToken||'')===c.env.BOOTSTRAP_TOKEN,403,'BOOTSTRAP_DENIED','首次安装口令不正确');
  }else{
   const hash=await sha256(String(body.inviteCode||''));
   const invite=await c.env.DB.prepare('SELECT id FROM invites WHERE code_hash=? AND enabled=1 AND used_count<max_uses AND (expires_at IS NULL OR expires_at>?)').bind(hash,Date.now()).first<{id:string}>();
   assert(invite,403,'INVALID_INVITE','邀请码无效、已停用、已过期或已用完');inviteId=invite.id;
  }
  // Do not expose the user directory before the caller proves invitation/setup access.
  const conflict=await c.env.DB.prepare('SELECT id FROM users WHERE username=?').bind(username).first();assert(!conflict,409,'USERNAME_EXISTS','用户名已存在');
  const {origin}=await originOf(c);
  const now=Date.now();
  const user:User={id:crypto.randomUUID(),username,role:isBootstrap?'admin':'user',status:'active',timezone:'Asia/Shanghai',created_at:now};
  const codes=await recoveryCodes(c.env,user.id);
  // D1 batch transactions guarantee that invitation usage is rolled back if the user insert fails.
  const passwordHash=await hashPasswordForUser(c.env,user.id,password);
  try{
   await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO users(id,username,role,status,invite_id,timezone,password_hash,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(user.id,user.username,user.role,'active',inviteId,user.timezone,passwordHash,now),
    ...codes.stmts,
    ...(user.role==='admin'?[c.env.DB.prepare("INSERT OR IGNORE INTO system_settings(key,value_json,updated_at) VALUES('public_origin',?,?)").bind(JSON.stringify(origin),now)]:[]),
   ]);
  }catch {throw new HttpError(409,'REGISTRATION_FAILED','注册失败：邀请码已用完或用户名重复');}
  return c.json({...await establishSession(c,user,passwordHash),recoveryCodes:codes.display},201);
 });
 // Compared against when the username does not exist so failed logins take similar time.
 const DUMMY_HASH='pbkdf2$600000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
 app.post('/api/v1/auth/login/password',async c=>{
  await clientRate(c,'login',12);
  const body=await c.req.json<any>();
  const username=String(body.username||'').trim(),password=String(body.password||'');
  assert(username.length>0&&username.length<=64&&password.length>0&&password.length<=128,401,'INVALID_LOGIN','用户名或密码不正确');
  const attempt=await beginAuthAttempt(c.env,username);
  let outcome:'success'|'failure'|'error'='error';
  try{
   const user=await c.env.DB.prepare("SELECT * FROM users WHERE username=? AND status='active'").bind(username).first<User>();
   const checked=await verifyPasswordForUser(c.env,user?.id||'unknown:'+username.toLowerCase(),password,user?.password_hash||DUMMY_HASH);
   if(!user||!checked.ok){outcome='failure';throw new HttpError(401,'INVALID_LOGIN','用户名或密码不正确');}
   // Revalidate the authenticated hash/status after expensive work. A parallel
   // admin reset or suspension must not authenticate with the obsolete secret.
   const updated=await c.env.DB.prepare("UPDATE users SET last_login_at=?,password_hash=? WHERE id=? AND status='active' AND password_hash=? RETURNING id").bind(Date.now(),checked.upgradedHash||user.password_hash,user.id,user.password_hash).first();
   assert(updated,409,'AUTH_CHANGED','账号安全状态已更新，请重新登录');
   const session=await establishSession(c,user,checked.upgradedHash||user.password_hash||'');outcome='success';return c.json(session);
  }finally{await finishAuthAttempt(c.env,attempt,outcome);}
 });
 app.post('/api/v1/auth/password',async c=>{
  const u=await currentUser(c);await assertCsrf(c,u);await freshSession(c,u);await clientRate(c,'password',5);
  const body=await c.req.json<any>();const next=String(body.newPassword||'');
  assert(validPassword(next),400,'INVALID_PASSWORD','密码不能为空（最多 128 位）');
  const row=await c.env.DB.prepare('SELECT password_hash FROM users WHERE id=?').bind(u.id).first<{password_hash:string|null}>();
  const recoveryReset=body.recoveryReset===true;
  if(recoveryReset)assert(u.recovery_password_reset_allowed,403,'RECOVERY_RESET_EXPIRED','恢复授权已使用或已过期，请重新使用恢复码');
  else if(row?.password_hash){
   const current=String(body.currentPassword||'');assert(current.length>0&&current.length<=128,403,'INVALID_PASSWORD','当前密码不正确');
   assert((await verifyPasswordForUser(c.env,u.id,current,row.password_hash)).ok,403,'INVALID_PASSWORD','当前密码不正确');
  }
  const passwordHash=await hashPasswordForUser(c.env,u.id,next),now=Date.now();
  if(recoveryReset){
   const result=await c.env.DB.batch([
    c.env.DB.prepare('UPDATE sessions SET recovery_reset_used_at=? WHERE id=? AND user_id=? AND revoked_at IS NULL AND expires_at>? AND recovery_reset_expires_at>? AND recovery_reset_used_at IS NULL RETURNING id').bind(now,u.sessionId,u.id,now,now),
    // changes() couples the mutation to this exact one-time claim, including
    // two requests that happen to have the same millisecond timestamp.
    c.env.DB.prepare("UPDATE users SET password_hash=? WHERE id=? AND status='active' AND changes()=1 RETURNING id").bind(passwordHash,u.id),
    c.env.DB.prepare('UPDATE sessions SET revoked_at=? WHERE user_id=? AND id<>? AND revoked_at IS NULL AND changes()=1').bind(now,u.id,u.sessionId),
   ]);
   assert(result[0].results.length===1&&result[1].results.length===1,403,'RECOVERY_RESET_EXPIRED','恢复授权已使用或已过期');
  }else{
   const result=await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET password_hash=? WHERE id=? AND status='active' AND password_hash IS ? AND EXISTS(SELECT 1 FROM sessions WHERE id=? AND user_id=? AND revoked_at IS NULL AND expires_at>?) RETURNING id").bind(passwordHash,u.id,row?.password_hash??null,u.sessionId,u.id,now),
    c.env.DB.prepare('UPDATE sessions SET revoked_at=? WHERE user_id=? AND id<>? AND revoked_at IS NULL AND changes()=1').bind(now,u.id,u.sessionId),
    c.env.DB.prepare('UPDATE sessions SET recovery_reset_used_at=? WHERE id=? AND user_id=? AND EXISTS(SELECT 1 FROM users WHERE id=? AND password_hash=?)').bind(now,u.sessionId,u.id,u.id,passwordHash),
   ]);
   assert(result[0].results.length===1,409,'AUTH_CHANGED','账号安全状态已更新，请重新登录');
  }
  await audit(c.env,u.id,recoveryReset?'auth.password_recovery_reset':row?.password_hash?'auth.password_change':'auth.password_set',u.id);
  return c.json({ok:true,recoveryPasswordResetConsumed:recoveryReset});
 });
 app.post('/api/v1/auth/login/options',async c=>{
  await clientRate(c,'login',12);
  const body=await c.req.json<any>();const username=String(body.username||'').trim();
  assert(username.length>0&&username.length<=64,401,'INVALID_LOGIN','无法登录，请使用密码或检查 Passkey');
  await rate(c.env,'passkey-account:'+await sha256(username.toLowerCase()),12,15*60000);
  const user=await c.env.DB.prepare('SELECT * FROM users WHERE username=? AND status=\'active\'').bind(username).first<User>();
  assert(user,401,'INVALID_LOGIN','无法登录，请检查用户名或 Passkey');
  const keys=await c.env.DB.prepare('SELECT * FROM passkeys WHERE user_id=?').bind(user.id).all<any>();
  assert(keys.results.length>0,401,'INVALID_LOGIN','无法登录，请使用密码或检查 Passkey');
  const rp=await originOf(c);
  const opts=await generateAuthenticationOptions({rpID:rp.rpID,allowCredentials:keys.results.map((v:any)=>({id:v.credential_id,transports:JSON.parse(v.transports_json)})),userVerification:'required'});
  const challengeId=crypto.randomUUID();
  await c.env.DB.prepare('INSERT INTO auth_challenges(id,purpose,username,user_id,challenge,rp_id,origin,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(challengeId,'login',username,user.id,opts.challenge,rp.rpID,rp.origin,Date.now()+CHALLENGE_AGE,Date.now()).run();
  return c.json({challengeId,options:opts});
 });
 app.post('/api/v1/auth/login/verify',async c=>{
  await clientRate(c,'login-verify',12);
  const body=await c.req.json<any>();const ch=await liveChallenge(c,String(body.challengeId||''),'login');
  const rp=await originOf(c);assert(ch.rp_id===rp.rpID&&ch.origin===rp.origin,403,'ORIGIN_MISMATCH','登录域名不匹配');
  const user=await c.env.DB.prepare("SELECT * FROM users WHERE id=? AND status='active'").bind(ch.user_id).first<User>();assert(user,401,'INVALID_LOGIN','无法登录');
  const k=await c.env.DB.prepare('SELECT * FROM passkeys WHERE user_id=? AND credential_id=?').bind(user.id,String(body.response?.id||'')).first<any>();assert(k,401,'INVALID_LOGIN','凭据不属于当前用户');
  const result=await verifyAuthenticationResponse({response:body.response,expectedChallenge:ch.challenge,expectedOrigin:rp.origin,expectedRPID:rp.rpID,credential:{id:k.credential_id,publicKey:fromB64(k.public_key),counter:k.counter,transports:JSON.parse(k.transports_json)},requireUserVerification:true});
  assert(result.verified,401,'INVALID_LOGIN','Passkey 验证未通过');
  await c.env.DB.batch([c.env.DB.prepare('UPDATE passkeys SET counter=?,last_used_at=? WHERE id=?').bind(result.authenticationInfo.newCounter,Date.now(),k.id),c.env.DB.prepare('UPDATE users SET last_login_at=? WHERE id=?').bind(Date.now(),user.id)]);
  return c.json(await establishSession(c,user));
 });
 app.post('/api/v1/auth/recover',async c=>{
  await clientRate(c,'recover',5);
  const body=await c.req.json<any>();
  const username=String(body.username||'').trim(),code=String(body.code||'');
  assert(username.length>0&&username.length<=64&&code.length>0&&code.length<=128,401,'RECOVERY_DENIED','用户名或恢复码无效');
  const attempt=await beginAuthAttempt(c.env,username);let outcome:'success'|'failure'|'error'='error';
  try{
   const u=await c.env.DB.prepare("SELECT * FROM users WHERE username=? AND status='active'").bind(username).first<User>();
   if(!u){outcome='failure';throw new HttpError(401,'RECOVERY_DENIED','用户名或恢复码无效');}
   const h=await sha256(`recovery:${u.id}:${code}`),s=await prepareSession(u,true);
   const result=await c.env.DB.batch([
    c.env.DB.prepare("UPDATE recovery_codes SET used_at=? WHERE user_id=? AND code_hash=? AND used_at IS NULL AND EXISTS(SELECT 1 FROM users WHERE id=? AND status='active') RETURNING code_hash").bind(s.now,u.id,h,u.id),
    c.env.DB.prepare('INSERT INTO sessions(id,user_id,token_hash,csrf_token_hash,created_at,expires_at,recovery_reset_expires_at) SELECT ?,?,?,?,?,?,? WHERE changes()=1').bind(s.id,u.id,s.tokenHash,s.csrfHash,s.now,s.expires,s.resetExpires),
    c.env.DB.prepare('UPDATE sessions SET revoked_at=? WHERE user_id=? AND id<>? AND revoked_at IS NULL AND EXISTS(SELECT 1 FROM sessions WHERE id=? AND user_id=?)').bind(s.now,u.id,s.id,s.id,u.id),
    c.env.DB.prepare("INSERT INTO audit_logs(id,actor_user_id,action,target_id,meta_json,created_at) SELECT ?,?,'auth.recovery',?,'{}',? WHERE EXISTS(SELECT 1 FROM sessions WHERE id=? AND user_id=?)").bind(crypto.randomUUID(),u.id,u.id,s.now,s.id,u.id),
   ]);
   if(result[0].results.length!==1){outcome='failure';throw new HttpError(401,'RECOVERY_DENIED','用户名或恢复码无效');}
   outcome='success';return c.json(sendSession(c,s));
  }finally{await finishAuthAttempt(c.env,attempt,outcome);}
 });
 app.post('/api/v1/auth/passkey/options',async c=>{
  const u=await currentUser(c);await assertCsrf(c,u);await freshSession(c,u);
  await clientRate(c,'add-passkey',10);
  const rp=await originOf(c);const opts=await generateRegistrationOptions({rpName:'CF Task Hub',rpID:rp.rpID,userName:u.username,userDisplayName:u.username,userID:new TextEncoder().encode(u.id),attestationType:'none',authenticatorSelection:{residentKey:'preferred',userVerification:'required'}});
  const keys=await c.env.DB.prepare('SELECT credential_id FROM passkeys WHERE user_id=?').bind(u.id).all<any>();
  // The server rejects duplicate credential IDs after verification.
  const id=crypto.randomUUID();await c.env.DB.prepare('INSERT INTO auth_challenges(id,purpose,user_id,challenge,rp_id,origin,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(id,'add_passkey',u.id,opts.challenge,rp.rpID,rp.origin,Date.now()+CHALLENGE_AGE,Date.now()).run();
  return c.json({challengeId:id,options:opts,existingKeys:keys.results.length});
 });
 app.post('/api/v1/auth/passkey/verify',async c=>{
  const u=await currentUser(c);await assertCsrf(c,u);await freshSession(c,u);const body=await c.req.json<any>();
  const ch=await liveChallenge(c,String(body.challengeId||''),'add_passkey');assert(ch.user_id===u.id,403,'FORBIDDEN','凭据注册会话不匹配');
  const rp=await originOf(c);assert(ch.origin===rp.origin&&ch.rp_id===rp.rpID,403,'ORIGIN_MISMATCH','Credential enrollment domain mismatch');const result=await verifyRegistrationResponse({response:body.response,expectedChallenge:ch.challenge,expectedOrigin:rp.origin,expectedRPID:rp.rpID,requireUserVerification:true});
  assert(result.verified&&result.registrationInfo,403,'INVALID_PASSKEY','Passkey 验证失败');const credential=result.registrationInfo.credential;
  await c.env.DB.prepare('INSERT INTO passkeys(id,user_id,credential_id,public_key,counter,transports_json,created_at) VALUES(?,?,?,?,?,?,?)').bind(crypto.randomUUID(),u.id,credential.id,toB64(credential.publicKey),credential.counter,JSON.stringify(credential.transports||[]),Date.now()).run();
  return c.json({ok:true});
 });
 app.post('/api/v1/auth/logout',async c=>{
  const u=await currentUser(c);await assertCsrf(c,u);
  const token=getCookie(c,'th_session');if(token){await c.env.DB.prepare('UPDATE sessions SET revoked_at=? WHERE token_hash=?').bind(Date.now(),await sha256(token)).run();}
  deleteCookie(c,'th_session',{path:'/'});deleteCookie(c,'th_csrf',{path:'/'});return c.json({ok:true});
 });
 app.get('/api/v1/auth/passkeys',async c=>{
  const u=await currentUser(c);const rows=await c.env.DB.prepare('SELECT id,name,created_at,last_used_at FROM passkeys WHERE user_id=? ORDER BY created_at').bind(u.id).all();return c.json({items:rows.results});
 });
 app.patch('/api/v1/auth/passkeys/:id',async c=>{
  const u=await currentUser(c);await assertCsrf(c,u);const b=await c.req.json<any>();
  const name=String(b.name||'').trim();assert(name.length>0&&name.length<=60,400,'INVALID_NAME','Name must have 1 to 60 characters');
  const r=await c.env.DB.prepare('UPDATE passkeys SET name=? WHERE id=? AND user_id=? RETURNING id').bind(name,c.req.param('id'),u.id).first();assert(r,404,'NOT_FOUND','Passkey not found');return c.json({ok:true});
 });
 app.delete('/api/v1/auth/passkeys/:id',async c=>{
  const u=await currentUser(c);await assertCsrf(c,u);await freshSession(c,u);
  const n=await c.env.DB.prepare('SELECT count(*) n FROM passkeys WHERE user_id=?').bind(u.id).first<{n:number}>();
  assert((n?.n||0)>1||!!u.password_hash,409,'LAST_PASSKEY','Set a login password or add another Passkey before removing this one');
  const r=await c.env.DB.prepare('DELETE FROM passkeys WHERE id=? AND user_id=? RETURNING id').bind(c.req.param('id'),u.id).first();assert(r,404,'NOT_FOUND','Passkey not found');await audit(c.env,u.id,'passkey.delete',c.req.param('id'));return c.json({ok:true});
 });
 app.get('/api/v1/auth/sessions',async c=>{
  const u=await currentUser(c);const rows=await c.env.DB.prepare('SELECT id,created_at,expires_at FROM sessions WHERE user_id=? AND revoked_at IS NULL AND expires_at>? ORDER BY created_at DESC LIMIT 30').bind(u.id,Date.now()).all();return c.json({items:rows.results,currentSession:u.sessionId});
 });
 app.delete('/api/v1/auth/sessions/:id',async c=>{
  const u=await currentUser(c);await assertCsrf(c,u);await c.env.DB.prepare('UPDATE sessions SET revoked_at=? WHERE id=? AND user_id=?').bind(Date.now(),c.req.param('id'),u.id).run();return c.json({ok:true});
 });
 app.post('/api/v1/auth/recovery-codes',async c=>{
  const u=await currentUser(c);await assertCsrf(c,u);await freshSession(c,u);await clientRate(c,'recovery-rotate',3);
  const b=await c.req.json<any>();assert(b.confirm===true,400,'CONFIRMATION_REQUIRED','Confirm invalidating all old recovery codes');
  const codes=await recoveryCodes(c.env,u.id);
  await c.env.DB.batch([c.env.DB.prepare('DELETE FROM recovery_codes WHERE user_id=?').bind(u.id),...codes.stmts]);
  await audit(c.env,u.id,'recovery.rotate',u.id);return c.json({recoveryCodes:codes.display});
 });

}
