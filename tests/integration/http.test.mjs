// Runs with the REAL Hono/Zod/WebAuthn packages after npm install. SQLite is
// real; D1/DO adapters below are not workerd. No upstream account is contacted.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {app} from '../../src/index.ts';
import {fixture,account,job,run} from '../helpers/d1.mjs';
import {sha256,encrypt,decrypt} from '../../src/core/crypto.ts';
import {setSetting} from '../../src/core/db.ts';
const origin='https://taskhub.example.test';
async function setup(){const f=await fixture();f.env.APP_ORIGIN=origin;f.tokens={};
 for(const id of ['alice','bob','admin']){const token='session-token-'+id,csrf='csrf-token-'+id;f.tokens[id]={token,csrf};await f.DB.prepare('INSERT INTO sessions(id,user_id,token_hash,csrf_token_hash,created_at,expires_at) VALUES(?,?,?,?,?,?)').bind('session-'+id,id,await sha256(token),await sha256(csrf),Date.now(),Date.now()+3600000).run();}
 f.request=async(path,{user='alice',method='GET',body,headers={},csrf=true}={})=>{const h=new Headers(headers);if(user){const t=f.tokens[user];h.set('Cookie',`th_session=${t.token}; th_csrf=${t.csrf}`);if(csrf&&method!=='GET')h.set('X-CSRF-Token',t.csrf);}if(body!==undefined)h.set('Content-Type','application/json');if(!h.has('Origin'))h.set('Origin',origin);return app.request(new Request(origin+path,{method,headers:h,...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})}),undefined,f.env);};return f;}
test('health is liveness; API requires migrated database, valid root key and a session',async()=>{const f=await setup();assert.equal((await f.request('/health',{user:null})).status,200);assert.equal((await f.request('/api/v1/me',{user:null})).status,401);const old=f.env.DATA_KEY;f.env.DATA_KEY='invalid';assert.equal((await f.request('/api/v1/me')).status,503);f.env.DATA_KEY=old;assert.equal((await f.request('/api/v1/me')).status,200);f.DB.close();});
test('same-origin and CSRF defenses reject unauthorized writes',async()=>{const f=await setup();assert.equal((await f.request('/api/v1/me',{method:'PATCH',body:{timezone:'UTC'},csrf:false})).status,403);assert.equal((await f.request('/api/v1/me',{method:'PATCH',body:{timezone:'UTC'},headers:{Origin:'https://evil.example'}})).status,403);assert.equal((await f.request('/api/v1/me',{method:'PATCH',body:{timezone:'UTC'}})).status,200);f.DB.close();});
test('every cross-owner account/run/job operation is rejected without revealing secret records',async()=>{const f=await setup();const aid=randomUUID(),jid=randomUUID(),rid=randomUUID();await account(f.DB,{id:aid,owner:'bob',enc:await encrypt(f.env.DATA_KEY,'bob',aid,{cookie:'secret-cookie'})});await job(f.DB,{id:jid,owner:'bob',accountId:aid});await run(f.DB,{id:rid,owner:'bob',jobId:jid});for(const [path,method,body] of [[`/accounts/${aid}`,'PATCH',{label:'stolen'}],[`/accounts/${aid}`,'DELETE'],[`/accounts/${aid}/probe`,'POST',{}],[`/jobs/${jid}`,'PATCH',{enabled:false}],[`/jobs/${jid}`,'DELETE'],[`/runs/${rid}`,'GET'],[`/runs/${rid}/reconcile`,'POST',{}]])assert.equal((await f.request('/api/v1'+path,{method,body})).status,404);const listed=await(await f.request('/api/v1/accounts')).json();assert.deepEqual(listed.items,[]);f.DB.close();});
test('only the administrator can issue invitations or mutate platform settings',async()=>{const f=await setup();assert.equal((await f.request('/api/v1/admin/settings')).status,403);assert.equal((await f.request('/api/v1/admin/invites',{method:'POST',body:{max_uses:1}})).status,403);const response=await f.request('/api/v1/admin/invites',{user:'admin',method:'POST',body:{max_uses:2,label:'test'}});assert.equal(response.status,201);const data=await response.json();assert.ok(data.code.startsWith('TH-'));const stored=await f.DB.prepare('SELECT * FROM invites WHERE id=?').bind(data.id).first();assert.notEqual(stored.code_hash,data.code);assert.equal(stored.max_uses,2);assert.ok(stored.code_enc&&!stored.code_enc.includes(data.code));
 const custom=await f.request('/api/v1/admin/invites',{user:'admin',method:'POST',body:{max_uses:1,code:'FRIENDS-2026'}});assert.equal(custom.status,201);assert.equal((await custom.json()).code,'FRIENDS-2026');
 const listed=await(await f.request('/api/v1/admin/invites',{user:'admin'})).json();assert.ok(listed.items.some(v=>v.code==='FRIENDS-2026'));
 const duplicate=await f.request('/api/v1/admin/invites',{user:'admin',method:'POST',body:{code:'FRIENDS-2026'}});assert.equal(duplicate.status,409);
 f.DB.close();});
test('an invalid settings patch does not partially persist its valid fields',async()=>{const f=await setup();await setSetting(f.env,'max_users',100);const response=await f.request('/api/v1/admin/settings',{user:'admin',method:'PUT',body:{max_users:5,webhook_allowed_hosts:['127.0.0.1']}});assert.equal(response.status,400);assert.equal((await f.DB.prepare("SELECT value_json FROM system_settings WHERE key='max_users'").first()).value_json,'100');f.DB.close();});
test('foreign channels cannot be bound to a user notification policy',async()=>{const f=await setup();const channel=randomUUID();await f.DB.prepare("INSERT INTO notification_channels(id,owner_user_id,name,type,config_enc,created_at,updated_at) VALUES(?,'bob','Other','telegram','secret',?,?)").bind(channel,Date.now(),Date.now()).run();const r=await f.request('/api/v1/notification-policies',{method:'PUT',body:{scope_type:'user',scope_id:'alice',success_enabled:true,exception_enabled:true,success_channels:[channel],error_mode:'same',exception_channels:[]}});assert.ok([400,403,404].includes(r.status));assert.equal((await f.DB.prepare('SELECT count(*) n FROM notification_policies').first()).n,0);f.DB.close();});
test('a recovery code is single use and revokes existing sessions',async()=>{const f=await setup();await f.DB.prepare('INSERT INTO recovery_codes(user_id,code_hash,created_at) VALUES(?,?,?)').bind('alice',await sha256('recovery:alice:recovery-test'),Date.now()).run();const args={user:null,method:'POST',body:{username:'alice',code:'recovery-test'}};const first=await f.request('/api/v1/auth/recover',args);assert.equal(first.status,200);assert.match(first.headers.get('set-cookie'),/HttpOnly/i);assert.equal((await f.request('/api/v1/me')).status,401);assert.equal((await f.request('/api/v1/auth/recover',args)).status,401);f.DB.close();});
test('recovering on a different RP origin is forbidden',async()=>{const f=await setup();const r=await app.request(new Request('https://other.example/api/v1/auth/recover',{method:'POST',headers:{Origin:'https://other.example','Content-Type':'application/json'},body:JSON.stringify({username:'alice',code:'whatever'})}),undefined,f.env);assert.equal(r.status,403);f.DB.close();});
test('request size limit applies before parsing JSON',async()=>{const f=await setup();const r=await f.request('/api/v1/me',{method:'PATCH',body:JSON.stringify({junk:'x'.repeat(70000)})});assert.equal(r.status,413);f.DB.close();});
test('suspended users lose access without waiting for session expiry',async()=>{const f=await setup();await f.DB.prepare("UPDATE users SET status='suspended' WHERE id='alice'").run();assert.equal((await f.request('/api/v1/me')).status,401);f.DB.close();});
test('key and token ciphertext are excluded from account lists',async()=>{const f=await setup();const id=randomUUID(),packed=await encrypt(f.env.DATA_KEY,'alice',id,{cookie:'SESSDATA=supersecret'});await account(f.DB,{id,enc:packed});for(const path of ['/api/v1/accounts']){const r=await f.request(path);assert.equal(r.status,200);const text=await r.text();for(const denied of ['credentials_enc','supersecret',packed])assert.ok(!text.includes(denied));}f.DB.close();});
test('a platform page aggregates features, accounts, schedule and notification overrides',async()=>{const f=await setup();const original=globalThis.fetch;
 globalThis.fetch=async input=>{const url=String(input);if(url.includes('api.bilibili.com/x/web-interface/nav'))return Response.json({code:0,data:{isLogin:true,mid:4242}});throw new Error('unexpected upstream request: '+url);};
 try{
  const list=await(await f.request('/api/v1/platforms')).json();assert.equal(list.items.length,2);const bili=list.items.find(x=>x.module.id==='bilibili-vip');assert.deepEqual(bili.group.features,['bili.vip_claim']);assert.equal(bili.stats.accounts,0);
  const saved=await f.request('/api/v1/platforms/bilibili-vip',{method:'PUT',body:{features:['bili.vip_claim'],schedule:{type:'daily',hour:8,minute:30},config:{timeout_ms:9000},notify:{success_enabled:true,exception_enabled:false,success_channels:[],error_mode:'same',exception_channels:[]},riskAccepted:false}});assert.equal(saved.status,200);
  const gated=await f.request('/api/v1/platforms/bilibili-vip',{method:'PUT',body:{features:['bili.exchange'],schedule:{type:'daily',hour:8,minute:30},config:{},notify:{success_enabled:true,exception_enabled:true,success_channels:[],error_mode:'same',exception_channels:[]},riskAccepted:true}});assert.equal(gated.status,403);
  const created=await f.request('/api/v1/platforms/bilibili-vip/accounts',{method:'POST',body:{label:'主账号',credentials:{cookie:'SESSDATA=verysecretvalue; bili_jct=csrfvalue'}}});assert.equal(created.status,201);
  const detail=await(await f.request('/api/v1/platforms/bilibili-vip')).json();assert.equal(detail.accounts.length,1);assert.equal(detail.jobs.length,1);assert.equal(detail.jobs[0].task_key,'bili.vip_claim');assert.equal(detail.jobs[0].enabled,true);assert.deepEqual(JSON.parse(detail.jobs[0].schedule_json),{type:'daily',hour:8,minute:30});
  const stored=await f.DB.prepare('SELECT group_id,config_json FROM accounts').first();assert.equal(stored.group_id,detail.group.id);assert.equal(JSON.parse(stored.config_json).timeout_ms,9000);
  const run=await f.request('/api/v1/platforms/bilibili-vip/run',{method:'POST',body:{},headers:{'Idempotency-Key':'platform-run-test-1'}});assert.equal(run.status,200);assert.equal((await run.json()).queued,1);
  const again=await f.request('/api/v1/platforms/bilibili-vip/run',{method:'POST',body:{},headers:{'Idempotency-Key':'platform-run-test-1'}});assert.equal((await again.json()).queued,1);assert.equal((await f.DB.prepare('SELECT count(*) n FROM job_runs').first()).n,1);
  const other=await(await f.request('/api/v1/platforms/bilibili-vip',{user:'bob'})).json();assert.equal(other.accounts.length,0);assert.equal(other.group.id,null);
 }finally{globalThis.fetch=original;f.DB.close();}});
test('platform deletion cancels unstarted runs and preserves retry or review evidence',async()=>{
 const f=await setup();
 const retrying=randomUUID();
 await account(f.DB,{id:retrying,module:'baidu-netdisk',enc:await encrypt(f.env.DATA_KEY,'alice',retrying,{cookie:'BDUSS=secret'})});
 await job(f.DB,{id:'del-job-retry',accountId:retrying,task:'baidu.daily',enabled:0});
 await run(f.DB,{id:'del-run-retry',jobId:'del-job-retry',status:'queued'});
 const ok=await f.request(`/api/v1/platforms/baidu-netdisk/accounts/${retrying}`,{method:'DELETE'});
 assert.equal(ok.status,200);
 assert.equal((await f.DB.prepare('SELECT count(*) n FROM accounts WHERE id=?').bind(retrying).first()).n,0);
 const verifying=randomUUID();
 await account(f.DB,{id:verifying,module:'baidu-netdisk',enc:await encrypt(f.env.DATA_KEY,'alice',verifying,{cookie:'BDUSS=secret'})});
 await job(f.DB,{id:'del-job-verify',accountId:verifying,task:'baidu.daily',enabled:0});
 await run(f.DB,{id:'del-run-verify',jobId:'del-job-verify',status:'waiting_verification'});
 const blocked=await f.request(`/api/v1/platforms/baidu-netdisk/accounts/${verifying}`,{method:'DELETE'});
 assert.equal(blocked.status,409);
 assert.equal((await f.DB.prepare('SELECT count(*) n FROM accounts WHERE id=?').bind(verifying).first()).n,1);
 await f.DB.prepare("UPDATE job_runs SET status='waiting_retry' WHERE id='del-run-verify'").run();
 const retryBlocked=await f.request(`/api/v1/platforms/baidu-netdisk/accounts/${verifying}`,{method:'DELETE'});
 assert.equal(retryBlocked.status,409);
 assert.equal((await f.DB.prepare("SELECT status FROM job_runs WHERE id='del-run-verify'").first()).status,'waiting_retry');
 f.DB.close();
});
test('baidu accounts without BAIDUCUID get a generated device id for App sign-in',async()=>{
 const f=await setup();const original=globalThis.fetch;
 globalThis.fetch=async(input,init)=>{
  const url=String(input);
  if(url.includes('pan.baidu.com/api/loginStatus')){
   const cookie=String(init?.headers?.Cookie||'');
   return Response.json({errno:0,login_info:{uk:cookie.includes('second-account')?1008612:1008611}});
  }
  throw new Error('unexpected upstream request: '+url);
 };
 try{
  const first=await f.request('/api/v1/platforms/baidu-netdisk/accounts',{method:'POST',body:{label:'扫码账号',credentials:{cookie:'BDUSS=first-account; STOKEN=test-stoken'}}});
  assert.equal(first.status,201);
  const row=await f.DB.prepare("SELECT id,credentials_enc FROM accounts WHERE label='扫码账号'").first();
  const creds=await decrypt(f.env.DATA_KEY,'alice',row.id,row.credentials_enc);
  assert.match(creds.cuid,/^[0-9A-F]{32}$/);
  assert.equal(creds.cookie,'BDUSS=first-account; STOKEN=test-stoken');
  const second=await f.request('/api/v1/platforms/baidu-netdisk/accounts',{method:'POST',body:{label:'已有CUID',credentials:{cookie:'BDUSS=second-account; BAIDUCUID=EXISTINGCUID123'}}});
  assert.equal(second.status,201);
  const other=await f.DB.prepare("SELECT id,credentials_enc FROM accounts WHERE label='已有CUID'").first();
  assert.equal((await decrypt(f.env.DATA_KEY,'alice',other.id,other.credentials_enc)).cuid,'EXISTINGCUID123');
 }finally{globalThis.fetch=original;f.DB.close();}
});
