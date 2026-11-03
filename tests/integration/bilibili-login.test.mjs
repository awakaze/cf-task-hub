import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {app} from '../../src/index.ts';
import {fixture,account} from '../helpers/d1.mjs';
import {sha256,decrypt,encrypt,fingerprint} from '../../src/core/crypto.ts';
import {setSetting} from '../../src/core/db.ts';

const origin='https://taskhub.example.test',base='/api/v1/platforms/bilibili-vip';
const token='bili-synthetic-session',csrf='bili-synthetic-csrf',key='a'.repeat(32);
async function setup(t){
 const f=await fixture();f.env.APP_ORIGIN=origin;t.after(()=>f.DB.close());
 await f.DB.prepare('INSERT INTO sessions(id,user_id,token_hash,csrf_token_hash,created_at,expires_at) VALUES(?,?,?,?,?,?)').bind('bili-test','alice',await sha256(token),await sha256(csrf),Date.now(),Date.now()+3600000).run();
 f.request=(path,{method='POST',body={},user=true}={})=>app.request(new Request(origin+path,{method,headers:{Origin:origin,'Content-Type':'application/json',...(user?{Cookie:`th_session=${token}; th_csrf=${csrf}`,'X-CSRF-Token':csrf}:{})},...(method==='GET'?{}:{body:JSON.stringify(body)})}),undefined,f.env);
 f.calls=[];
 t.mock.method(globalThis,'fetch',async(input,init={})=>{
  const path=new URL(input).pathname;f.calls.push(path);
  if(path.endsWith('/qrcode/generate'))return Response.json({code:0,data:{qrcode_key:key,url:'https://account.bilibili.com/h5/account-h5/auth/scan-web?navhide=1&qrcode_key='+key}});
  if(path.endsWith('/qrcode/poll')){
   const headers=new Headers();for(const [k,v]of [['SESSDATA','synthetic-session'],['bili_jct','synthetic-csrf'],['DedeUserID','42']])headers.append('Set-Cookie',`${k}=${v}; Domain=.bilibili.com; Path=/`);
   return Response.json({code:0,data:{code:0,refresh_token:'synthetic-refresh-token'}},{headers});
  }
  if(path==='/x/web-interface/nav')return Response.json({code:0,data:{isLogin:true,mid:42}});
  throw Error('Unexpected endpoint');
 });return f;
}
test('Bilibili QR atomically binds encrypted refresh credentials, schedules jobs and replays safely',async t=>{
 const f=await setup(t),start=await f.request(base+'/qr/start');assert.equal(start.status,200);const qr=await start.json();assert.ok(qr.qr.startsWith('data:image/svg+xml;'));
 const poll=await f.request(base+`/qr/${qr.id}/poll`,{body:{label:'B站'}});assert.equal(poll.status,200);const bound=await poll.json();assert.equal(bound.status,'confirmed');assert.ok(bound.account_id);
 const a=await f.DB.prepare('SELECT * FROM accounts WHERE id=?').bind(bound.account_id).first(),creds=await decrypt(f.env.DATA_KEY,'alice',a.id,a.credentials_enc);assert.equal(creds.refresh_token,'synthetic-refresh-token');assert.match(creds.cookie,/SESSDATA=synthetic-session/);assert.ok(!a.credentials_enc.includes('synthetic-refresh-token'));
 assert.equal((await f.DB.prepare('SELECT status FROM bili_sessions WHERE account_id=?').bind(a.id).first()).status,'ready');assert.equal((await f.DB.prepare('SELECT count(*) n FROM jobs WHERE account_id=?').bind(a.id).first()).n,1);
 const calls=f.calls.length;assert.deepEqual(await(await f.request(base+`/qr/${qr.id}/poll`)).json(),bound);assert.equal(f.calls.length,calls);
 for(const path of [base,'/api/v1/accounts']){
  const data=await(await f.request(path,{method:'GET'})).json(),text=JSON.stringify(data.accounts??data.items);assert.ok(text.includes('session_status'));for(const denied of ['synthetic-refresh-token','synthetic-session','credentials_enc','refresh_token'])assert.ok(!text.includes(denied));
 }
});
test('QR update preserves existing identity and records; another UID cannot replace the account',async t=>{
 const f=await setup(t),id=randomUUID(),old={cookie:'SESSDATA=old-session; bili_jct=old-csrf'};
 await account(f.DB,{id,enc:await encrypt(f.env.DATA_KEY,'alice',id,old),fingerprint:await fingerprint(f.env.DATA_KEY,'identity-v2:bilibili-vip','99')});
 const qr=await(await f.request(base+'/qr/start',{body:{accountId:id,resumeJobs:true}})).json();
 const result=await f.request(base+`/qr/${qr.id}/poll`);assert.equal(result.status,409);assert.deepEqual(await decrypt(f.env.DATA_KEY,'alice',id,(await f.DB.prepare('SELECT credentials_enc FROM accounts WHERE id=?').bind(id).first()).credentials_enc),old);assert.equal((await f.DB.prepare('SELECT status FROM login_challenges WHERE id=?').bind(qr.id).first()).status,'failed');
});
test('manual imports accept optional refresh token on both APIs and replacing cookie alone removes renewal',async t=>{
 const f=await setup(t);const added=await f.request(base+'/accounts',{body:{label:'Manual',credentials:{cookie:'SESSDATA=manual-session; bili_jct=manual-csrf',refresh_token:'manual-token'}}});assert.equal(added.status,201);const {id}=await added.json();
 assert.ok(await f.DB.prepare('SELECT * FROM bili_sessions WHERE account_id=?').bind(id).first());
 let result=await f.request('/api/v1/accounts/'+id,{method:'PATCH',body:{credentials:{cookie:'SESSDATA=replaced; bili_jct=replaced',refresh_token:'legacy-api-token'}}});assert.equal(result.status,200);
 let creds=await decrypt(f.env.DATA_KEY,'alice',id,(await f.DB.prepare('SELECT credentials_enc FROM accounts WHERE id=?').bind(id).first()).credentials_enc);assert.equal(creds.refresh_token,'legacy-api-token');
 result=await f.request(base+'/accounts/'+id,{method:'PATCH',body:{credentials:{cookie:'SESSDATA=without-token; bili_jct=without-token'}}});assert.equal(result.status,200);assert.equal(await f.DB.prepare('SELECT * FROM bili_sessions WHERE account_id=?').bind(id).first(),null);
 creds=await decrypt(f.env.DATA_KEY,'alice',id,(await f.DB.prepare('SELECT credentials_enc FROM accounts WHERE id=?').bind(id).first()).credentials_enc);assert.equal(creds.refresh_token,undefined);
});
test('active rotation rejects both public mutation APIs without overwriting encrypted credentials',async t=>{
 const f=await setup(t);const added=await f.request(base+'/accounts',{body:{label:'Original',credentials:{cookie:'SESSDATA=manual-session; bili_jct=manual-csrf',refresh_token:'manual-token'}}});const {id}=await added.json();
 const old=await f.DB.prepare('SELECT credentials_enc FROM accounts WHERE id=?').bind(id).first();await f.DB.prepare('UPDATE bili_sessions SET lease_token=?,lease_until=? WHERE account_id=?').bind('rotation',Date.now()+60000,id).run();
 for(const path of [base+'/accounts/'+id,'/api/v1/accounts/'+id]){assert.equal((await f.request(path,{method:'PATCH',body:{label:'Wrong'}})).status,409);assert.equal((await f.DB.prepare('SELECT credentials_enc FROM accounts WHERE id=?').bind(id).first()).credentials_enc,old.credentials_enc);}
});

test('a session requiring login cannot be resumed without new credentials',async t=>{
 const f=await setup(t),created=await f.request(base+'/accounts',{body:{label:'Expired',credentials:{cookie:'SESSDATA=session; bili_jct=csrf',refresh_token:'token'}}}),{id}=await created.json();
 await f.DB.prepare("UPDATE bili_sessions SET status='needs_login' WHERE account_id=?").bind(id).run();await f.DB.prepare('UPDATE accounts SET enabled=0 WHERE id=?').bind(id).run();
 for(const path of [base+'/accounts/'+id,'/api/v1/accounts/'+id]){const response=await f.request(path,{method:'PATCH',body:{enabled:true}});assert.equal(response.status,409);assert.equal((await response.json()).error,'BILI_RELOGIN_REQUIRED');}
});
test('Bilibili QR obeys authorization, module and maintenance gates before upstream calls',async t=>{
 const f=await setup(t);assert.equal((await f.request(base+'/qr/start',{user:false})).status,401);await setSetting(f.env,'modules_enabled',{'bilibili-vip':false});assert.equal((await f.request(base+'/qr/start')).status,403);await setSetting(f.env,'modules_enabled',{'bilibili-vip':true});await setSetting(f.env,'maintenance',true);assert.equal((await f.request(base+'/qr/start')).status,503);assert.equal(f.calls.length,0);
});
