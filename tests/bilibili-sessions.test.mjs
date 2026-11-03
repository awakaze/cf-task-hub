import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,account,job} from './helpers/d1.mjs';
import {encrypt,decrypt} from '../src/core/crypto.ts';
import {verifiedIdentity,SessionExpiredError} from '../src/core/identity.ts';
import {ensureBiliSession,biliSessionStatements,credentialMutationGuard,dispatchBiliSessionChecks,BiliSessionUnavailable} from '../src/core/bilibili-sessions.ts';
import {setSetting} from '../src/core/db.ts';

const initial={cookie:'SESSDATA=old-session; bili_jct=old-csrf; DedeUserID=42; buvid3=device',refresh_token:'old-token',externalId:'42'};
async function setup(){
 const f=await fixture(),identity=await verifiedIdentity(f.env,'bilibili-vip',initial,async()=>Response.json({code:0,data:{isLogin:true,mid:42}}));
 await account(f.DB,{enc:await encrypt(f.env.DATA_KEY,'alice','account',initial),fingerprint:identity.fingerprint});await job(f.DB);
 await f.DB.batch(biliSessionStatements(f.env,'bilibili-vip','account',initial));
 f.creds=async()=>decrypt(f.env.DATA_KEY,'alice','account',(await f.DB.prepare("SELECT credentials_enc FROM accounts WHERE id='account'").first()).credentials_enc);
 f.due=()=>f.DB.prepare("UPDATE bili_sessions SET next_check_at=0 WHERE account_id='account'").run();
 return f;
}
function upstream(t,f,{refresh=true,loseRefresh=false,loseConfirm=false,mid=42,refreshError=0}={}){
 const calls=[];let posted=0,confirmed=0;
 t.mock.method(globalThis,'fetch',async(input,init={})=>{
  const url=new URL(input);calls.push(url.pathname);
  if(url.pathname.endsWith('/cookie/info'))return Response.json({code:0,data:{refresh,timestamp:Date.now()}});
  if(url.pathname.startsWith('/correspond/1/'))return new Response('<div id="1-name">refresh-csrf</div>');
  if(url.pathname.endsWith('/cookie/refresh')){
   posted++;assert.equal((await f.creds()).bili_refresh_pending.phase,'refreshing');
   assert.equal(new URLSearchParams(init.body).get('refresh_token'),'old-token');
   if(loseRefresh)throw Error('response lost');
   if(refreshError)return Response.json({code:refreshError,message:'risk rejection'});
   const headers=new Headers();for(const [k,v]of [['SESSDATA','new-session'],['bili_jct','new-csrf'],['DedeUserID','42']])headers.append('Set-Cookie',`${k}=${v}; Domain=.bilibili.com; Path=/`);
   return Response.json({code:0,data:{refresh_token:'new-token'}},{headers});
  }
  if(url.pathname==='/x/web-interface/nav')return Response.json({code:0,data:{isLogin:true,mid}});
  if(url.pathname.endsWith('/confirm/refresh')){
   confirmed++;const saved=await f.creds();assert.equal(saved.refresh_token,'new-token');assert.equal(saved.bili_refresh_pending.phase,'confirming');
   assert.equal(new URLSearchParams(init.body).get('refresh_token'),'old-token');assert.equal(new URLSearchParams(init.body).get('csrf'),'new-csrf');assert.match(new Headers(init.headers).get('Cookie'),/SESSDATA=new-session/);
   if(loseConfirm&&confirmed===1)throw Error('response lost');return Response.json({code:0});
  }
  throw Error('unexpected endpoint');
 });
 return {calls,get posted(){return posted;},get confirmed(){return confirmed;}};
}
test('renewal persists new credentials before confirming old token and daily checks do not repeat',async t=>{
 const f=await setup();try{const net=upstream(t,f);const creds=await ensureBiliSession(f.env,'account');assert.equal(creds.refresh_token,'new-token');assert.equal(creds.bili_refresh_pending,undefined);assert.match(creds.cookie,/buvid3=device/);assert.equal(net.posted,1);assert.equal(net.confirmed,1);
 const row=await f.DB.prepare("SELECT * FROM bili_sessions WHERE account_id='account'").first();assert.equal(row.status,'ready');assert.equal(row.lease_token,null);assert.ok(row.last_refreshed_at);const count=net.calls.length;await ensureBiliSession(f.env,'account');assert.equal(net.calls.length,count);
 const raw=await f.DB.prepare("SELECT credentials_enc FROM accounts WHERE id='account'").first();assert.ok(!raw.credentials_enc.includes('new-token'));
 }finally{f.DB.close();}
});
test('no-refresh response checks once without changing cookies',async t=>{
 const f=await setup();try{const net=upstream(t,f,{refresh:false});await ensureBiliSession(f.env,'account');assert.equal(net.calls.length,1);assert.equal((await f.creds()).refresh_token,'old-token');}finally{f.DB.close();}
});
test('lost refresh response is never replayed, pauses schedules and creates one notification event',async t=>{
 const f=await setup();try{const net=upstream(t,f,{loseRefresh:true});await assert.rejects(ensureBiliSession(f.env,'account'),SessionExpiredError);await f.due();await assert.rejects(ensureBiliSession(f.env,'account'),SessionExpiredError);assert.equal(net.posted,1);assert.equal(net.confirmed,0);assert.equal((await f.creds()).bili_refresh_pending.phase,'refreshing');assert.equal((await f.DB.prepare("SELECT enabled FROM accounts WHERE id='account'").first()).enabled,0);assert.equal((await f.DB.prepare('SELECT enabled FROM jobs').first()).enabled,0);assert.equal((await f.DB.prepare('SELECT count(*) n FROM job_events').first()).n,1);
 }finally{f.DB.close();}
});

test('a known risk-control rejection backs off without marking the login expired',async t=>{
 const f=await setup();try{const net=upstream(t,f,{refreshError:-352});await assert.rejects(ensureBiliSession(f.env,'account'),BiliSessionUnavailable);assert.equal(net.posted,1);assert.equal(net.confirmed,0);assert.equal((await f.creds()).bili_refresh_pending,undefined);assert.equal((await f.creds()).refresh_token,'old-token');assert.equal((await f.DB.prepare('SELECT enabled FROM accounts').first()).enabled,1);assert.equal((await f.DB.prepare('SELECT status FROM bili_sessions').first()).status,'retry');assert.equal((await f.DB.prepare('SELECT count(*) n FROM job_events').first()).n,0);
 }finally{f.DB.close();}
});
test('confirmation interruption retains new cookies and resumes only confirmation after restart',async t=>{
 const f=await setup();try{const net=upstream(t,f,{loseConfirm:true});await assert.rejects(ensureBiliSession(f.env,'account'),BiliSessionUnavailable);assert.equal((await f.creds()).refresh_token,'new-token');assert.equal((await f.creds()).bili_refresh_pending.phase,'confirming');await assert.rejects(ensureBiliSession(f.env,'account'),BiliSessionUnavailable);await f.due();await ensureBiliSession(f.env,'account');assert.equal(net.posted,1);assert.equal(net.confirmed,2);assert.equal((await f.creds()).bili_refresh_pending,undefined);
 }finally{f.DB.close();}
});

test('interrupted submission recovered from durable storage never issues refresh again',async t=>{
 const f=await setup();try{const net=upstream(t,f);await f.DB.prepare("UPDATE accounts SET credentials_enc=? WHERE id='account'").bind(await encrypt(f.env.DATA_KEY,'alice','account',{...initial,bili_refresh_pending:{phase:'refreshing'}})).run();await f.DB.prepare("UPDATE bili_sessions SET lease_token='abandoned',lease_until=0").run();await assert.rejects(ensureBiliSession(f.env,'account'),SessionExpiredError);assert.equal(net.calls.length,0);assert.equal((await f.DB.prepare('SELECT status FROM bili_sessions').first()).status,'needs_login');}finally{f.DB.close();}
});

test('confirmation retry budget eventually requests a new login without refreshing again',async t=>{
 const f=await setup();try{const net=upstream(t,f);await f.DB.prepare("UPDATE accounts SET credentials_enc=? WHERE id='account'").bind(await encrypt(f.env.DATA_KEY,'alice','account',{...initial,bili_refresh_pending:{phase:'confirming',old_token:'old-token',attempts:3}})).run();await assert.rejects(ensureBiliSession(f.env,'account'),SessionExpiredError);assert.equal(net.calls.length,0);}finally{f.DB.close();}
});
test('failed persistence after refresh never confirms or replays the refresh POST',async t=>{
 const f=await setup();try{const net=upstream(t,f),prepare=f.DB.prepare.bind(f.DB);let writes=0;
 t.mock.method(f.DB,'prepare',sql=>{const statement=prepare(sql);if(sql.startsWith('UPDATE accounts SET credentials_enc=')){writes++;if(writes===2){const bind=statement.bind;statement.bind=function(...args){const bound=bind.apply(this,args);bound.first=async()=>{throw Error('disk failed');};return bound;};}}return statement;});
 await assert.rejects(ensureBiliSession(f.env,'account'),SessionExpiredError);assert.equal(net.posted,1);assert.equal(net.confirmed,0);await assert.rejects(ensureBiliSession(f.env,'account'),SessionExpiredError);assert.equal(net.posted,1);
 }finally{f.DB.close();}
});
test('credentials cannot be overwritten during an active rotation or by a stale snapshot',async()=>{
 const f=await setup();try{const old=await f.DB.prepare("SELECT * FROM accounts WHERE id='account'").first();await f.DB.prepare("UPDATE bili_sessions SET lease_token='busy',lease_until=?").bind(Date.now()+60000).run();let guard=credentialMutationGuard(f.env,old);await assert.rejects(f.DB.batch([guard.before,f.DB.prepare("UPDATE accounts SET label='wrong'"),guard.after]));assert.equal((await f.DB.prepare('SELECT label FROM accounts').first()).label,'Test');await f.DB.prepare('UPDATE bili_sessions SET lease_until=0').run();await f.DB.prepare("UPDATE accounts SET credentials_enc='new ciphertext'").run();guard=credentialMutationGuard(f.env,old);await assert.rejects(f.DB.batch([guard.before,guard.after]));
 }finally{f.DB.close();}
});
test('new cookie UID mismatch fails before confirmation',async t=>{
 const f=await setup();try{const net=upstream(t,f,{mid:99});await assert.rejects(ensureBiliSession(f.env,'account'),SessionExpiredError);assert.equal(net.confirmed,0);}finally{f.DB.close();}
});
test('maintenance dispatch respects pause/module/owner state and sends no secrets',async()=>{
 const f=await setup();try{await dispatchBiliSessionChecks(f.env);assert.deepEqual(f.queued.map(x=>x.body),[{kind:'credential',id:'account'}]);f.queued.length=0;
 for(const stop of ['background','maintenance','module','owner']){
  f.env.BACKGROUND_PAUSED=stop==='background'?'true':'false';await setSetting(f.env,'maintenance',stop==='maintenance');await setSetting(f.env,'modules_enabled',{'bilibili-vip':stop!=='module'});await f.DB.prepare('UPDATE users SET status=? WHERE id=?').bind(stop==='owner'?'suspended':'active','alice').run();await dispatchBiliSessionChecks(f.env);assert.equal(f.queued.length,0);
 }
 }finally{f.DB.close();}
});
