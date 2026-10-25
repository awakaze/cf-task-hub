import test from 'node:test';
import assert from 'node:assert/strict';
import {pbkdf2Sync,randomBytes} from 'node:crypto';
import {Hono} from 'hono';
import {registerAuthRoutes,currentUser} from '../../src/api/auth.ts';
import {HttpError} from '../../src/core/response.ts';
import {sha256} from '../../src/core/crypto.ts';
import {PasswordHasher} from '../../src/durable/password-hasher.ts';
import {fixture,memoryStorage} from '../helpers/d1.mjs';

const origin='https://taskhub.example.test';
function legacyHash(password){const salt=randomBytes(16);return `pbkdf2$50000$${salt.toString('base64url')}$${pbkdf2Sync(password,salt,50000,32,'sha256').toString('base64url')}`;}
async function setup(){
 const f=await fixture(),objects=new Map();f.env.APP_ORIGIN=origin;f.tokens={};
 f.env.PASSWORDS={idFromName:n=>n,get(name){if(!objects.has(name))objects.set(name,new PasswordHasher({storage:memoryStorage()},f.env));return {fetch:(input,init)=>objects.get(name).fetch(new Request(input,init))};}};
 const app=new Hono();registerAuthRoutes(app);
 app.get('/api/v1/me',async c=>{const u=await currentUser(c);return c.json({user:{id:u.id,recovery_password_reset_allowed:u.recovery_password_reset_allowed,recovery_password_reset_expires_at:u.recovery_password_reset_expires_at}});});
 app.onError((e,c)=>e instanceof HttpError?c.json({error:e.code,message:e.detail},e.status):c.json({error:'INTERNAL_ERROR'},500));
 for(const id of ['alice','bob','admin']){
  const token='hardening-session-'+id,csrf='hardening-csrf-'+id;f.tokens[id]={token,csrf};
  await f.DB.prepare('INSERT INTO sessions(id,user_id,token_hash,csrf_token_hash,created_at,expires_at) VALUES(?,?,?,?,?,?)').bind('hardening-'+id,id,await sha256(token),await sha256(csrf),Date.now(),Date.now()+3600000).run();
  await f.DB.prepare('UPDATE users SET password_hash=? WHERE id=?').bind(legacyHash('Forgotten password 2026'),id).run();
 }
 f.request=async(path,{user='alice',method='GET',body,requestOrigin=origin,headers={}}={})=>{
  const h=new Headers(headers);
  if(user){h.set('Cookie',`th_session=${f.tokens[user].token}; th_csrf=${f.tokens[user].csrf}`);if(method!=='GET')h.set('X-CSRF-Token',f.tokens[user].csrf);}
  if(body!==undefined)h.set('Content-Type','application/json');h.set('Origin',requestOrigin);
  return app.request(new Request(requestOrigin+path,{method,headers:h,...(body===undefined?{}:{body:JSON.stringify(body)})}),undefined,f.env);
 };
 f.acceptSession=async(user,response)=>{
  const data=await response.json();f.tokens[user]={token:/th_session=([^;]+)/.exec(response.headers.get('set-cookie'))[1],csrf:data.csrf};return data;
 };
 return f;
}
async function addRecovery(f,user,code){await f.DB.prepare('INSERT INTO recovery_codes(user_id,code_hash,created_at) VALUES(?,?,?)').bind(user,await sha256(`recovery:${user}:${code}`),Date.now()).run();}

test('all authentication routes reject alternate hosts and remote HTTP; local development is explicit',async()=>{
 const f=await setup();
 try{
  for(const [path,method] of [['setup-status','GET'],['login/password','POST'],['recover','POST'],['login/options','POST'],['logout','POST'],['sessions','GET']]){
   const response=await f.request('/api/v1/auth/'+path,{method,requestOrigin:'https://alias.example.test',body:method==='POST'?{}:undefined});
   assert.equal(response.status,403);assert.equal((await response.json()).error,'ORIGIN_MISMATCH');
  }
  const plain=await f.request('/api/v1/auth/login/password',{user:null,method:'POST',body:{},requestOrigin:'http://taskhub.example.test'});
  assert.equal(plain.status,403);assert.equal((await plain.json()).error,'HTTPS_REQUIRED');
  delete f.env.APP_ORIGIN;
  assert.equal((await f.request('/api/v1/auth/setup-status',{user:null})).status,503);
  assert.equal((await f.request('/api/v1/auth/setup-status',{user:null,requestOrigin:'http://127.0.0.1:8797'})).status,200);
 }finally{f.DB.close();}
});

for(const username of ['alice','admin'])test(`recovery login can reset ${username}'s forgotten password exactly once and revokes other sessions`,async()=>{
 const f=await setup();
 try{
  await addRecovery(f,username,'single-use-recovery');
  const recovered=await f.request('/api/v1/auth/recover',{user:null,method:'POST',body:{username,code:'single-use-recovery'}});
  assert.equal(recovered.status,200);
  const data=await f.acceptSession(username,recovered);assert.equal(data.user.recovery_password_reset_allowed,true);
  assert.ok(data.user.recovery_password_reset_expires_at>Date.now());
  assert.ok((await f.DB.prepare('SELECT revoked_at FROM sessions WHERE id=?').bind('hardening-'+username).first()).revoked_at);
  await f.DB.prepare('INSERT INTO sessions(id,user_id,token_hash,csrf_token_hash,created_at,expires_at) VALUES(?,?,?,?,?,?)').bind('parallel-'+username,username,'parallel-token-'+username,'parallel-csrf',Date.now(),Date.now()+3600000).run();
  const changed=await f.request('/api/v1/auth/password',{user:username,method:'POST',body:{newPassword:'Replacement password 2026',recoveryReset:true}});
  assert.equal(changed.status,200);assert.equal((await changed.json()).recoveryPasswordResetConsumed,true);
  const stored=(await f.DB.prepare('SELECT password_hash FROM users WHERE id=?').bind(username).first()).password_hash;
  const [,iterations,salt,expected]=stored.split('$');assert.equal(Number(iterations),600000);
  assert.equal(pbkdf2Sync('Replacement password 2026',Buffer.from(salt,'base64url'),600000,32,'sha256').toString('base64url'),expected);
  assert.ok((await f.DB.prepare('SELECT revoked_at FROM sessions WHERE id=?').bind('parallel-'+username).first()).revoked_at);
  assert.equal((await(await f.request('/api/v1/me',{user:username})).json()).user.recovery_password_reset_allowed,false);
  assert.equal((await f.request('/api/v1/auth/password',{user:username,method:'POST',body:{newPassword:'Another password 2026',recoveryReset:true}})).status,403);
  assert.equal((await f.request('/api/v1/auth/recover',{user:null,method:'POST',body:{username,code:'single-use-recovery'}})).status,401);
 }finally{f.DB.close();}
});

test('ordinary or expired sessions cannot bypass the current password',async()=>{
 const f=await setup();
 try{
  const change={method:'POST',body:{newPassword:'New password 2026',recoveryReset:true}};
  assert.equal((await f.request('/api/v1/auth/password',change)).status,403);
  assert.equal((await f.request('/api/v1/auth/password',{method:'POST',body:{newPassword:'New password 2026'}})).status,403);
  await f.DB.prepare('UPDATE sessions SET recovery_reset_expires_at=? WHERE id=?').bind(Date.now()-1,'hardening-alice').run();
  assert.equal((await f.request('/api/v1/auth/password',change)).status,403);
 }finally{f.DB.close();}
});

test('recovery code consumption and session replacement roll back together',async()=>{
 const f=await setup();
 try{
  await addRecovery(f,'alice','rollback-recovery');f.DB.failBatchAt=1;
  const args={user:null,method:'POST',body:{username:'alice',code:'rollback-recovery'}};
  assert.equal((await f.request('/api/v1/auth/recover',args)).status,500);
  f.DB.failBatchAt=null;
  assert.equal((await f.DB.prepare("SELECT used_at FROM recovery_codes WHERE user_id='alice'").first()).used_at,null);
  assert.equal((await f.DB.prepare("SELECT revoked_at FROM sessions WHERE id='hardening-alice'").first()).revoked_at,null);
  assert.equal((await f.request('/api/v1/auth/recover',args)).status,200);
 }finally{f.DB.close();}
});

test('password login upgrades the legacy hash after successful verification',async()=>{
 const f=await setup();
 try{
  const response=await f.request('/api/v1/auth/login/password',{user:null,method:'POST',body:{username:'alice',password:'Forgotten password 2026'}});
  assert.equal(response.status,200);assert.match(response.headers.get('set-cookie'),/; Secure/);
  assert.equal((await response.json()).user.recovery_password_reset_allowed,false);
  assert.match((await f.DB.prepare("SELECT password_hash FROM users WHERE id='alice'").first()).password_hash,/^pbkdf2\$600000\$/);
 }finally{f.DB.close();}
});

test('rotating IP addresses and username case cannot bypass account failure backoff',async()=>{
 const f=await setup();
 try{
  for(let i=0;i<3;i++)assert.equal((await f.request('/api/v1/auth/recover',{user:null,method:'POST',headers:{'CF-Connecting-IP':`192.0.2.${i+1}`},body:{username:i%2?'ALICE':'alice',code:'incorrect'}})).status,401);
  const blocked=await f.request('/api/v1/auth/recover',{user:null,method:'POST',headers:{'CF-Connecting-IP':'198.51.100.25'},body:{username:'Alice',code:'incorrect'}});
  assert.equal(blocked.status,429);assert.equal((await blocked.json()).error,'AUTH_RATE_LIMIT');
 }finally{f.DB.close();}
});
