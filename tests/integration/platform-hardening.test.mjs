// Real Hono/Zod + SQLite regression tests. D1/DO/Queue bindings are local
// adapters; upstream responses are synthetic and no external account is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {app} from '../../src/index.ts';
import {fixture,account,job} from '../helpers/d1.mjs';
import {sha256,encrypt,decrypt,fingerprint} from '../../src/core/crypto.ts';
import {setSetting} from '../../src/core/db.ts';

const origin='https://taskhub.example.test';
const bili='/api/v1/platforms/bilibili-vip';
const baidu='/api/v1/platforms/baidu-netdisk';
const daily={type:'daily',hour:9,minute:0,timezone:'Asia/Shanghai'};
async function setup(t){
 const f=await fixture();f.env.APP_ORIGIN=origin;
 const token='platform-hardening-session',csrf='platform-hardening-csrf';
 await f.DB.prepare('INSERT INTO sessions(id,user_id,token_hash,csrf_token_hash,created_at,expires_at) VALUES(?,?,?,?,?,?)')
  .bind('platform-hardening','alice',await sha256(token),await sha256(csrf),Date.now(),Date.now()+3600000).run();
 f.request=(path,{user='alice',method='GET',body,headers={}}={})=>{
  const h=new Headers(headers);h.set('Origin',origin);
  if(user){h.set('Cookie',`th_session=${token}; th_csrf=${csrf}`);if(method!=='GET')h.set('X-CSRF-Token',csrf);}
  if(body!==undefined)h.set('Content-Type','application/json');
  return app.request(new Request(origin+path,{method,headers:h,...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})}),undefined,f.env);
 };
 t.mock.method(globalThis,'fetch',async()=>{throw new Error('Unexpected upstream request in local regression test');});
 t.after(()=>f.DB.close());return f;
}
async function status(response,expected){const data=await response.json();assert.equal(response.status,expected,JSON.stringify(data));return data;}
function count(f,table){return Number(f.DB.sqlite.prepare(`SELECT count(*) n FROM ${table}`).get().n);}
function platformState(f){return Object.fromEntries(['platform_groups','accounts','jobs'].map(table=>[table,f.DB.sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all().map(row=>({...row}))]));}
async function makeJob(f){const aid=randomUUID(),jid=randomUUID();await account(f.DB,{id:aid});await job(f.DB,{id:jid,accountId:aid});return {aid,jid};}
async function challenge(f,polls=0){const id=randomUUID(),now=Date.now();await f.DB.prepare("INSERT INTO login_challenges(id,owner_user_id,module_id,sign,status,created_at,expires_at,poll_count) VALUES(?,'alice','baidu-netdisk','synthetic-sign','pending',?,?,?)").bind(id,now,now+180000,polls).run();return id;}
function challengeRow(f,id){return {...f.DB.sqlite.prepare('SELECT * FROM login_challenges WHERE id=?').get(id)};}
function successfulQrUpstream(t,onIdentity){
 const urls=[];
 t.mock.method(globalThis,'fetch',async input=>{
  const url=new URL(String(input));urls.push(url.toString());
  if(url.pathname==='/channel/unicast')return Response.json({errno:0,channel_v:{status:0,v:'synthetic-login-token'}});
  if(url.pathname.endsWith('/qrbdusslogin'))return Response.json({data:{session:{bduss:'synthetic-bduss'}}});
  if(url.pathname==='/disk/home')return new Response('',{headers:{'Set-Cookie':'STOKEN=synthetic-stoken; Domain=.baidu.com; Path=/; Secure'}});
  if(url.pathname==='/api/loginStatus'){await onIdentity();return Response.json({errno:0,login_info:{uk:1234}});}
  throw new Error('Unexpected QR mock endpoint');
 });return urls;
}

test('account and platform quota failures, including a mid-batch fault, leave no partial configuration',async t=>{
 const f=await setup(t);let upstream=0;
 t.mock.method(globalThis,'fetch',async input=>{assert.equal(String(input),'https://api.bilibili.com/x/web-interface/nav');return Response.json({code:0,data:{isLogin:true,mid:100000+(++upstream)}});});
 await f.DB.prepare("INSERT INTO user_quotas(user_id,max_jobs) VALUES('alice',0)").run();
 const add={method:'POST',body:{label:'Synthetic account',credentials:{cookie:'SESSDATA=synthetic; bili_jct=synthetic-csrf'}}};
 await status(await f.request(bili+'/accounts',add),429);
 assert.deepEqual(platformState(f),{platform_groups:[],accounts:[],jobs:[]});assert.equal(upstream,0);
 await f.DB.prepare("UPDATE user_quotas SET max_jobs=1 WHERE user_id='alice'").run();
 await status(await f.request(bili+'/accounts',add),201);const saved=platformState(f);
 await status(await f.request(bili+'/accounts',add),429);
 assert.deepEqual(platformState(f),saved);assert.equal(upstream,1);
 await setSetting(f.env,'bili_exchange_allowed',true);
 await status(await f.request(bili,{method:'PUT',body:{features:['bili.vip_claim','bili.exchange'],schedule:daily,config:{timeout_ms:9000},riskAccepted:true}}),429);
 assert.deepEqual(platformState(f),saved);
 await f.DB.prepare("UPDATE user_quotas SET max_jobs=3 WHERE user_id='alice'").run();
 f.DB.failBatchAt=2;
 try{await status(await f.request(bili+'/accounts',add),500);}finally{f.DB.failBatchAt=null;}
 assert.deepEqual(platformState(f),saved);assert.equal(upstream,2);
 assert.equal(count(f,'audit_logs'),1,'failed writes must not report a successful audit action');
});

test('an impossible cron cannot create or overwrite a platform configuration',async t=>{
 const f=await setup(t),invalid={features:['bili.vip_claim'],schedule:{type:'cron',expression:'0 0 31 2 *'},config:{}};
 await status(await f.request(bili,{method:'PUT',body:invalid}),400);assert.equal(count(f,'platform_groups'),0);
 await status(await f.request(bili,{method:'PUT',body:{...invalid,schedule:daily}}),200);const saved=platformState(f);
 await status(await f.request(bili,{method:'PUT',body:invalid}),400);assert.deepEqual(platformState(f),saved);
});

test('exchange configuration remembers risk acceptance while preserving the administrator gate',async t=>{
 const f=await setup(t),body={features:['bili.vip_claim','bili.exchange'],schedule:daily,config:{}};
 let data=await status(await f.request(bili,{method:'PUT',body:{...body,riskAccepted:true}}),403);assert.equal(data.error,'EXCHANGE_DISABLED');
 await setSetting(f.env,'bili_exchange_allowed',true);
 data=await status(await f.request(bili,{method:'PUT',body}),403);assert.equal(data.error,'RISK_ACCEPTANCE_REQUIRED');
 await status(await f.request(bili,{method:'PUT',body:{...body,riskAccepted:true}}),200);
 await status(await f.request(bili,{method:'PUT',body:{...body,schedule:{...daily,hour:10},riskAccepted:false}}),200);
 await setSetting(f.env,'bili_exchange_allowed',false);
 data=await status(await f.request(bili,{method:'PUT',body}),403);assert.equal(data.error,'EXCHANGE_DISABLED');
 await setSetting(f.env,'bili_exchange_allowed',true);
 await status(await f.request(bili,{method:'PUT',body:{...body,features:['bili.vip_claim']}}),200);
 data=await status(await f.request(bili,{method:'PUT',body}),403);assert.equal(data.error,'RISK_ACCEPTANCE_REQUIRED');
});

test('a platform batch that exceeds the global budget rolls back every run and queue claim',async t=>{
 const f=await setup(t);await makeJob(f);await makeJob(f);
 await setSetting(f.env,'platform_budget',{max_daily_runs:1,max_daily_notifications:500});
 const result=await status(await f.request(bili+'/run',{method:'POST',body:{},headers:{'Idempotency-Key':'batch-budget-atomicity'}}),429);
 assert.equal(result.error,'QUOTA_EXCEEDED');
 for(const table of ['job_runs','outbox','platform_run_requests','run_usage_claims','usage_daily'])assert.equal(count(f,table),0,table);
 assert.equal(f.queued.length,0);assert.equal(count(f,'audit_logs'),0);
});

test('idempotent platform replay returns the same IDs after quota exhaustion and configuration changes',async t=>{
 const f=await setup(t),first=await makeJob(f);await makeJob(f);
 await f.DB.prepare("INSERT INTO user_quotas(user_id,max_manual_runs) VALUES('alice',2)").run();
 const request={method:'POST',body:{},headers:{'Idempotency-Key':'stable-platform-batch'}};
 const initial=await status(await f.request(bili+'/run',request),200);assert.equal(initial.queued,2);
 assert.deepEqual(initial.runs,[...initial.runs].sort());
 await status(await f.request(bili+'/run',{...request,headers:{'Idempotency-Key':'new-exhausted-batch'}}),429);
 const repeat=await status(await f.request(bili+'/run',request),200);assert.deepEqual(repeat.runs,initial.runs);assert.equal(repeat.replayed,true);
 await status(await f.request(bili,{method:'PUT',body:{features:[],schedule:daily,config:{timeout_ms:9000}}}),200);
 await setSetting(f.env,'maintenance',true);
 await setSetting(f.env,'modules_enabled',{'bilibili-vip':false,'baidu-netdisk':true});
 const changed=await status(await f.request(bili+'/run',request),200);assert.deepEqual(changed.runs,initial.runs);
 const conflict=await status(await f.request(bili+'/run',{...request,body:{account_id:first.aid}}),409);assert.equal(conflict.error,'IDEMPOTENCY_CONFLICT');
 assert.equal(count(f,'job_runs'),2);assert.equal(count(f,'outbox'),2);assert.equal(count(f,'run_usage_claims'),2);assert.equal(count(f,'platform_run_requests'),1);
 assert.equal(f.queued.length,1,'only the original batch should publish a dispatcher');
});

test('maintenance and module disablement stop QR start and poll before any upstream request',async t=>{
 const f=await setup(t),id=await challenge(f);let upstream=0;
 t.mock.method(globalThis,'fetch',async()=>{upstream++;throw new Error('No QR network work is allowed');});
 await setSetting(f.env,'maintenance',true);
 for(const path of [baidu+'/qr/start',`${baidu}/qr/${id}/poll`])await status(await f.request(path,{method:'POST',body:{}}),503);
 await setSetting(f.env,'maintenance',false);
 await setSetting(f.env,'modules_enabled',{'bilibili-vip':true,'baidu-netdisk':false});
 for(const path of [baidu+'/qr/start',`${baidu}/qr/${id}/poll`])await status(await f.request(path,{method:'POST',body:{}}),403);
 assert.equal(upstream,0);assert.equal(challengeRow(f,id).poll_count,0);
});

test('concurrent polling of one QR challenge performs only one upstream fetch',{timeout:5000},async t=>{
 const f=await setup(t),id=await challenge(f),urls=[];let release,entered;
 const started=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
 t.mock.method(globalThis,'fetch',async input=>{urls.push(String(input));entered();await gate;return Response.json({errno:1});});
 const first=f.request(`${baidu}/qr/${id}/poll`,{method:'POST',body:{}});
 try{
  await started;
  const second=await status(await f.request(`${baidu}/qr/${id}/poll`,{method:'POST',body:{}}),200);assert.equal(second.status,'pending');
  assert.equal(urls.length,1);assert.match(urls[0],/^https:\/\/passport\.baidu\.com\/channel\/unicast\?/);
 }finally{release();await first;}
 assert.equal((await status(await first,200)).status,'pending');
 const row=challengeRow(f,id);assert.equal(row.poll_count,1);assert.equal(row.lease_token,null);assert.equal(row.lease_until,null);
});

test('a failed QR Cookie exchange remains failed instead of becoming confirmed without an account',async t=>{
 const f=await setup(t),id=await challenge(f),urls=[];
 t.mock.method(globalThis,'fetch',async input=>{
  const url=String(input);urls.push(url);
  if(url.includes('/channel/unicast?'))return Response.json({errno:0,channel_v:{status:0,v:'synthetic-login-token'}});
  return new Response('Synthetic login service failure',{status:502});
 });
 await status(await f.request(`${baidu}/qr/${id}/poll`,{method:'POST',body:{}}),502);
 const row=challengeRow(f,id);assert.equal(row.status,'failed');assert.equal(row.account_id,null);assert.equal(row.consumed_at,null);
 const next=await status(await f.request(`${baidu}/qr/${id}/poll`,{method:'POST',body:{}}),200);assert.equal(next.status,'failed');assert.equal(next.account_id,undefined);
 assert.equal(urls.length,2);assert.match(urls[1],/^https:\/\/passport\.baidu\.com\/v3\/login\/main\/qrbdusslogin\?/);
 for(const table of ['accounts','jobs','platform_groups'])assert.equal(count(f,table),0,table);
});

test('a QR challenge makes at most 60 admitted upstream poll requests',async t=>{
 const f=await setup(t),id=await challenge(f,59);let upstream=0;
 t.mock.method(globalThis,'fetch',async()=>{upstream++;return Response.json({errno:1});});
 await status(await f.request(`${baidu}/qr/${id}/poll`,{method:'POST',body:{}}),200);
 assert.equal(challengeRow(f,id).poll_count,60);
 const limited=await status(await f.request(`${baidu}/qr/${id}/poll`,{method:'POST',body:{}}),429);assert.equal(limited.error,'QR_POLL_LIMIT');
 assert.equal(challengeRow(f,id).poll_count,60);assert.equal(upstream,1);
});

test('QR binding rolls back when its existing target is deleted during identity verification',async t=>{
 const f=await setup(t),aid=randomUUID(),id=await challenge(f);
 await account(f.DB,{id:aid,module:'baidu-netdisk',fingerprint:await fingerprint(f.env.IDENTITY_KEY||f.env.DATA_KEY,'identity-v2:baidu-netdisk','1234'),enc:await encrypt(f.env.DATA_KEY,'alice',aid,{cookie:'BDUSS=old; STOKEN=old'})});
 await f.DB.prepare('UPDATE login_challenges SET target_account_id=? WHERE id=?').bind(aid,id).run();
 let deleted=false;
 const urls=successfulQrUpstream(t,async()=>{
  // The first request has read the target and is suspended at its identity
  // fetch. A second legitimate request deletes the otherwise idle account.
  await status(await f.request(`${baidu}/accounts/${aid}`,{method:'DELETE'}),200);deleted=true;
 });
 await status(await f.request(`${baidu}/qr/${id}/poll`,{method:'POST',body:{}}),409);
 assert.equal(deleted,true);assert.equal(urls.length,4);
 const row=challengeRow(f,id);assert.equal(row.status,'failed');assert.equal(row.account_id,null);assert.equal(row.consumed_at,null);
 for(const table of ['accounts','jobs','platform_groups','mutation_guards'])assert.equal(count(f,table),0,table);
 assert.equal(f.DB.sqlite.prepare("SELECT count(*) n FROM audit_logs WHERE action IN('account.create','account.update')").get().n,0);
});

test('QR binding cannot commit after a concurrent poll has failed its expired processing lease',async t=>{
 const f=await setup(t),id=await challenge(f);let observedFailure=false;
 const urls=successfulQrUpstream(t,async()=>{
  // Advance only the persisted lease, not global clocks or network timeouts.
  // A second poll exercises the actual expired-processing transition.
  await f.DB.prepare('UPDATE login_challenges SET lease_until=? WHERE id=?').bind(Date.now()-1,id).run();
  const second=await status(await f.request(`${baidu}/qr/${id}/poll`,{method:'POST',body:{}}),200);
  assert.equal(second.status,'failed');observedFailure=true;
 });
 await status(await f.request(`${baidu}/qr/${id}/poll`,{method:'POST',body:{}}),409);
 assert.equal(observedFailure,true);assert.equal(urls.length,4);
 const row=challengeRow(f,id);assert.equal(row.status,'failed');assert.equal(row.account_id,null);assert.equal(row.consumed_at,null);assert.equal(row.lease_token,null);
 for(const table of ['accounts','jobs','platform_groups','mutation_guards','audit_logs'])assert.equal(count(f,table),0,table);
});

test('unknown APIs avoid D1/DO work and rate-limited notification tests avoid audit writes',async t=>{
 const f=await setup(t),rates=[];let upstream=0;
 f.env.ACCOUNTS.get=()=>({fetch:async(input,init)=>{const body=await new Request(input,init).json();rates.push(body.key);return body.key.startsWith('notify-test:')?Response.json({allowed:false},{status:429}):Response.json({allowed:true});}});
 t.mock.method(globalThis,'fetch',async()=>{upstream++;throw new Error('No notification should be sent');});
 f.DB.calls=0;
 for(const [path,method] of [['/api/v1/does-not-exist','GET'],['/api/v1/does-not-exist','POST'],['/api/v1/me','DELETE']])await status(await f.request(path,{user:null,method,body:method==='POST'?{}:undefined}),404);
 assert.equal(f.DB.calls,0);assert.deepEqual(rates,[]);
 const id=randomUUID(),config={botToken:'123456:'+ 'a'.repeat(35),chatId:'12345',threadId:''};
 await f.DB.prepare("INSERT INTO notification_channels(id,owner_user_id,name,type,config_enc,created_at,updated_at) VALUES(?,'alice','Synthetic','telegram',?,?,?)").bind(id,await encrypt(f.env.DATA_KEY,'alice',id,config),Date.now(),Date.now()).run();
 const limited=await status(await f.request(`/api/v1/notification-channels/${id}/test`,{method:'POST',body:{}}),429);assert.equal(limited.error,'RATE_LIMIT');
 assert.equal(rates.filter(key=>key==='notify-test:alice').length,1);assert.equal(count(f,'audit_logs'),0);assert.equal(count(f,'usage_claims'),0);assert.equal(upstream,0);
});

test('notification config patches retain credentials while list responses reveal only safe editable fields',async t=>{
 const f=await setup(t);await setSetting(f.env,'webhook_allowed_hosts',['hooks.example.test']);
 const examples=[
  {type:'telegram',config:{botToken:'123456:'+ 'a'.repeat(35),chatId:'12345',threadId:'8'},patch:{chatId:'98765',threadId:'9'},editable:{chatId:'98765',threadId:'9'},secrets:['botToken']},
  {type:'serverchan',config:{sendKey:'SCT'+ 'B'.repeat(24)},patch:{},editable:{},secrets:['sendKey']},
  {type:'webhook',config:{url:'https://hooks.example.test/private-token',headers:{Authorization:'Bearer hidden-token'},signingSecret:'hidden-signing-secret'},patch:{headers:{Authorization:'Bearer replacement-token'}},editable:{},secrets:['url','signingSecret']}
 ];
 for(const example of examples){
  const created=await status(await f.request('/api/v1/notification-channels',{method:'POST',body:{name:example.type,type:example.type,config:example.config}}),201);example.id=created.id;
  await status(await f.request(`/api/v1/notification-channels/${example.id}`,{method:'PATCH',body:{configPatch:example.patch}}),200);
  const row=f.DB.sqlite.prepare('SELECT config_enc FROM notification_channels WHERE id=?').get(example.id);
  const stored=await decrypt(f.env.DATA_KEY,'alice',example.id,row.config_enc);
  assert.deepEqual(stored,{...example.config,...example.patch});
 }
 const listed=await status(await f.request('/api/v1/notification-channels'),200),serialized=JSON.stringify(listed);
 assert.equal(listed.items.length,3);
 for(const example of examples){
  const item=listed.items.find(row=>row.id===example.id);assert.deepEqual(item.editable_config,example.editable);assert.equal(item.config_enc,undefined);
  for(const key of example.secrets){assert.equal(serialized.includes(String(example.config[key])),false);assert.equal(Object.hasOwn(item,key),false);}
 }
 assert.equal(serialized.includes('replacement-token'),false);assert.equal(serialized.includes('hidden-token'),false);
});

test('the former 24153-byte collection attack receives a bounded response before D1 access',async t=>{
 const f=await setup(t),body=JSON.stringify({scope_type:'user',scope_id:'alice',success_enabled:true,exception_enabled:true,success_channels:Array(12000).fill(0),error_mode:'same',exception_channels:[]});
 assert.equal(Buffer.byteLength(body),24153);f.DB.calls=0;
 const response=await f.request('/api/v1/notification-policies',{method:'PUT',body}),text=await response.text(),data=JSON.parse(text);
 assert.equal(response.status,400);assert.equal(data.error,'COLLECTION_TOO_LARGE');assert.ok(Buffer.byteLength(text)<1024);
 assert.ok(!data.details||data.details.length<=10);assert.equal(f.DB.calls,0);assert.equal(count(f,'notification_policies'),0);
});

test('a misleading short Content-Length cannot bypass the streamed 64 KiB body limit',async t=>{
 const f=await setup(t),body=JSON.stringify({timezone:'x'.repeat(70000)});
 assert.ok(Buffer.byteLength(body)>65536);f.DB.calls=0;
 const response=await f.request('/api/v1/me',{method:'PATCH',body,headers:{'Content-Length':'1'}}),text=await response.text();
 assert.equal(response.status,413,text);assert.ok(Buffer.byteLength(text)<1024);assert.equal(f.DB.calls,0);
 assert.equal(f.DB.sqlite.prepare("SELECT timezone FROM users WHERE id='alice'").get().timezone,'Asia/Shanghai');
});
