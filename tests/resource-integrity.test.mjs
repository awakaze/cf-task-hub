import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,account,job,run,memoryStorage} from './helpers/d1.mjs';
import {queueRun,publishOutbox,scheduledTick} from '../src/core/scheduler.ts';
import {queueRunBatch,manualRunUsage,autoRunUsage} from '../src/core/run-batch.ts';
import {maintenance} from '../src/core/maintenance.ts';
import {setSetting} from '../src/core/db.ts';
import {AccountCoordinator} from '../src/durable/account-coordinator.ts';
import {validateSchedule,nextSchedule} from '../src/core/time.ts';
import {encrypt} from '../src/core/crypto.ts';
import {verifiedIdentity} from '../src/core/identity.ts';
import {reconcileBaidu} from '../src/modules/baidu-netdisk/adapter.ts';
import {BaiduClient,beijingDate} from '../src/modules/baidu-netdisk/original-core.js';

async function prepared(){const f=await fixture();await account(f.DB);f.job=await job(f.DB);return f;}
function indexedStorage(){const storage=memoryStorage();storage.list=async({prefix='',limit=1000,startAfter,end}={})=>new Map([...storage.map.entries()].filter(([k])=>k.startsWith(prefix)&&(!startAfter||k>startAfter)&&(!end||k<end)).sort(([a],[b])=>a<b?-1:a>b?1:0).slice(0,limit).map(([k,v])=>[k,structuredClone(v)]));return storage;}
const invoke=(d,path,body)=>d.fetch(new Request('https://internal'+path,{method:'POST',body:JSON.stringify(body)}));
async function withFetch(fn,body){const old=globalThis.fetch;globalThis.fetch=fn;try{return await body();}finally{globalThis.fetch=old;}}

test('manual budget survives deleting its run, job and account',async()=>{
 const f=await prepared();try{
  await f.DB.prepare("INSERT INTO user_quotas(user_id,max_manual_runs) VALUES('alice',1)").run();
  const id=await queueRun(f.env,f.job,'once',true);
  await f.DB.prepare("UPDATE job_runs SET status='succeeded' WHERE id=?").bind(id).run();
  await f.DB.prepare("DELETE FROM accounts WHERE id='account'").run();
  assert.equal(await manualRunUsage(f.env,'alice'),1);
  await account(f.DB,{id:'replacement'});const j=await job(f.DB,{id:'replacement-job',accountId:'replacement'});
  await assert.rejects(queueRun(f.env,j,'twice',true),/manual_limit/);
  assert.equal((await f.DB.prepare('SELECT count(*) n FROM job_runs').first()).n,0);
 }finally{f.DB.close();}
});

test('automatic tenant budget is persistent and leaves other tenants capacity',async()=>{
 const f=await prepared();try{
  await f.DB.prepare("INSERT INTO user_quotas(user_id,max_auto_runs) VALUES('alice',2)").run();
  for(const key of ['one','two']){const id=await queueRun(f.env,f.job,key);await f.DB.prepare("UPDATE job_runs SET status='succeeded' WHERE id=?").bind(id).run();}
  await f.DB.prepare("DELETE FROM job_runs WHERE owner_user_id='alice'").run();
  assert.equal(await autoRunUsage(f.env,'alice'),2);
  await assert.rejects(queueRun(f.env,f.job,'three'),/automatic_run_limit/);
  await account(f.DB,{id:'bob-account',owner:'bob'});const bob=await job(f.DB,{id:'bob-job',owner:'bob',accountId:'bob-account'});
  assert.ok(await queueRun(f.env,bob,'normal'));assert.equal(await autoRunUsage(f.env,'bob'),1);
 }finally{f.DB.close();}
});

test('at most three unsettled runs per account preserve evidence without unbounded backlog',async()=>{
 const f=await prepared();try{
  for(let i=0;i<3;i++)await queueRun(f.env,f.job,'pending-'+i);
  await assert.rejects(queueRun(f.env,f.job,'fourth'),/unsettled_run_limit/);
  assert.equal((await f.DB.prepare('SELECT count(*) n FROM job_runs').first()).n,3);
 }finally{f.DB.close();}
});

test('whole run batch and caller claim roll back together when only one run fits',async()=>{
 const f=await prepared();try{
  await account(f.DB,{id:'second'});const second=await job(f.DB,{id:'second-job',accountId:'second'});
  await setSetting(f.env,'platform_budget',{max_daily_runs:1,max_daily_notifications:10});
  const claim=f.DB.prepare("INSERT INTO audit_logs(id,action,created_at) VALUES('claim','test',?)").bind(Date.now());
  await assert.rejects(queueRunBatch(f.env,[{job:f.job,windowKey:'a',manual:true},{job:second,windowKey:'b',manual:true}],{before:[claim],publish:true}),/platform_run_limit/);
  for(const table of ['job_runs','outbox','run_usage_claims','audit_logs'])assert.equal((await f.DB.prepare('SELECT count(*) n FROM '+table).first()).n,0,table);
  assert.equal(f.queued.length,0);
 }finally{f.DB.close();}
});

test('batch replay retains IDs without charging either budget again',async()=>{
 const f=await prepared();try{
  await f.DB.prepare("INSERT INTO user_quotas(user_id,max_manual_runs) VALUES('alice',1)").run();
  const spec=[{job:f.job,windowKey:'same-request',manual:true}];
  const a=await queueRunBatch(f.env,spec),b=await queueRunBatch(f.env,spec);
  assert.deepEqual(a,b);assert.equal(await manualRunUsage(f.env,'alice'),1);
  assert.equal((await f.DB.prepare("SELECT count FROM usage_daily WHERE scope='global' AND kind='run'").first()).count,1);
 }finally{f.DB.close();}
});

async function biliPair(){
 const f=await fixture();const credentials={cookie:'SESSDATA=mocksession;bili_jct=mockcsrf'};
 const identity=await verifiedIdentity(f.env,'bilibili-vip',credentials,async()=>Response.json({code:0,data:{isLogin:true,mid:42}}));
 await account(f.DB,{fingerprint:identity.fingerprint,enc:await encrypt(f.env.DATA_KEY,'alice','account',credentials)});
 const due=Date.now()-1000;
 f.exchange=await job(f.DB,{id:'a-exchange',task:'bili.exchange',due});f.claim=await job(f.DB,{id:'z-claim',task:'bili.vip_claim',due});
 await f.DB.prepare("UPDATE accounts SET config_json='{\"settle_wait_ms\":0}'").run();await setSetting(f.env,'bili_exchange_allowed',true);
 f.storage=indexedStorage();f.coordinator=new AccountCoordinator({storage:f.storage},f.env);return f;
}

test('exchange delivered first waits for its explicit claim dependency then exchanges once',async()=>{
 const f=await biliPair();try{
  const [exchange,claim]=await queueRunBatch(f.env,[{job:f.exchange,windowKey:'same-round',manual:true},{job:f.claim,windowKey:'same-round',manual:true}]);
  assert.equal((await f.DB.prepare('SELECT depends_on_run_id FROM job_runs WHERE id=?').bind(exchange).first()).depends_on_run_id,claim);
  let coupon=0,claims=0,exchanges=0,calls=0;
  await withFetch(async(input,init={})=>{
   calls++;const p=new URL(input).pathname;
   if(p.endsWith('/nav'))return Response.json({code:0,data:{isLogin:true,mid:42,wallet:{coupon_balance:coupon,bcoin_balance:0}}});
   if(p.endsWith('/privilege/my'))return Response.json({code:0,data:{list:[{type:1,state:claims?1:0}]}});
   if(p.endsWith('/privilege/receive')){claims++;coupon=5;return Response.json({code:0});}
   if(p.endsWith('/get_user_info'))return Response.json({code:0,data:{gold:exchanges?15000:10000,silver:0}});
   if(p.endsWith('/createOrder')){assert.equal(init.method,'POST');exchanges++;coupon=0;return Response.json({code:0});}
   throw Error('Unexpected endpoint');
  },async()=>{
   assert.equal((await invoke(f.coordinator,'/run',{runId:exchange})).status,200);assert.equal(calls,0);
   assert.equal((await f.DB.prepare('SELECT status FROM job_runs WHERE id=?').bind(exchange).first()).status,'scheduled');
   await invoke(f.coordinator,'/run',{runId:claim});await invoke(f.coordinator,'/run',{runId:exchange});await invoke(f.coordinator,'/run',{runId:exchange});
  });
  assert.equal(claims,1);assert.equal(exchanges,1);assert.equal(coupon,0);
  assert.deepEqual((await f.DB.prepare('SELECT status FROM job_runs').all()).results.map(r=>r.status),['succeeded','succeeded']);
 }finally{f.DB.close();}
});

test('scheduler creates same-time claim and exchange with dependency despite UUID order',async()=>{
 const f=await biliPair();try{
  await scheduledTick(f.env);
  const claim=await f.DB.prepare("SELECT id FROM job_runs WHERE job_id='z-claim'").first();
  const exchange=await f.DB.prepare("SELECT depends_on_run_id FROM job_runs WHERE job_id='a-exchange'").first();
  assert.ok(claim);assert.equal(exchange.depends_on_run_id,claim.id);
 }finally{f.DB.close();}
});

test('missing prerequisite is never treated as an unrestricted exchange',async()=>{
 const f=await biliPair();try{
  const [claim,exchange]=await queueRunBatch(f.env,[{job:f.claim,windowKey:'same'},{job:f.exchange,windowKey:'same'}]);
  await f.DB.prepare("UPDATE job_runs SET status='succeeded' WHERE id=?").bind(claim).run();await f.DB.prepare('DELETE FROM job_runs WHERE id=?').bind(claim).run();
  await withFetch(async()=>{throw Error('No upstream call permitted');},()=>invoke(f.coordinator,'/run',{runId:exchange}));
  const row=await f.DB.prepare('SELECT status,depends_on_run_id FROM job_runs WHERE id=?').bind(exchange).first();
  assert.equal(row.status,'failed');assert.equal(row.depends_on_run_id,claim);
 }finally{f.DB.close();}
});

test('terminal outbox survives publication races and old intents are cleaned in bounded pages',async()=>{
 const f=await prepared();try{
  const id=await queueRun(f.env,f.job,'done');
  f.env.TASK_QUEUE.sendBatch=async()=>{await f.DB.prepare("UPDATE job_runs SET status='succeeded' WHERE id=?").bind(id).run();};
  await publishOutbox(f.env);assert.equal((await f.DB.prepare('SELECT status FROM outbox').first()).status,'done');
  const now=Date.now();for(let i=0;i<105;i++)await f.DB.prepare("INSERT INTO outbox(id,owner_user_id,kind,ref_id,payload_json,status,next_attempt_at,updated_at) VALUES(?,'alice','run',?,'{}','done',?,?)").bind('old'+i,'gone'+i,now-9*86400000,now-9*86400000).run();
  const captured=[],prepare=f.DB.prepare.bind(f.DB);f.DB.prepare=(sql)=>{captured.push(sql);return prepare(sql);};
  await maintenance(f.env);
  assert.equal((await prepare("SELECT count(*) n FROM outbox WHERE id LIKE 'old%'").first()).n,5);
  const recover=captured.find(sql=>sql.includes('CROSS JOIN outbox o')&&sql.includes('job_runs'));
  const plan=f.DB.sqlite.prepare('EXPLAIN QUERY PLAN '+recover).all(now,now-600000).map(r=>r.detail).join('\n');
  assert.match(plan,/ix_runs_status/);assert.ok(!plan.includes('ix_outbox_due'));
 }finally{f.DB.close();}
});

test('expired QR cleanup retains an authorization with an active lease',async()=>{
 const f=await fixture();try{
  const now=Date.now();await f.DB.prepare("INSERT INTO login_challenges(id,owner_user_id,module_id,sign,created_at,expires_at,lease_until) VALUES('qr','alice','baidu-netdisk','fake',?,?,?)").bind(now-200000,now-1000,now+60000).run();
  await maintenance(f.env);assert.ok(await f.DB.prepare("SELECT id FROM login_challenges WHERE id='qr'").first());
 }finally{f.DB.close();}
});

test('limiter never delays cleanup and expiry-index cleanup is bounded and resumable',async()=>{
 const f=await fixture(),storage=indexedStorage(),d=new AccountCoordinator({storage},f.env),realNow=Date.now;let now=realNow();Date.now=()=>now;
 try{
  for(let i=0;i<120;i++)await storage.put('rate:a-live-'+String(i).padStart(3,'0'),{bucket:0,count:1,expiresAt:now+86400000});
  for(let i=0;i<120;i++)await storage.put('rate:z-expired-'+String(i).padStart(3,'0'),{bucket:0,count:1,expiresAt:now-1000});
  const rate=key=>invoke(d,'/rate',{key,limit:1200,windowMs:60000});
  assert.equal((await rate('first')).status,200);const firstAlarm=await storage.getAlarm();
  now+=30000;await rate('another');assert.ok((await storage.getAlarm())<=firstAlarm);
  for(let i=0;i<5;i++){now+=1000;await d.alarm();}
  assert.equal((await storage.list({prefix:'rate:z-expired-'})).size,0);
  assert.equal((await storage.list({prefix:'rate:a-live-'})).size,120);
 }finally{Date.now=realNow;f.DB.close();}
});

test('cron rejects impossible dates early and skips elapsed minutes without Intl loops',()=>{
 assert.throws(()=>validateSchedule({type:'cron',expression:'0 0 31 2 *'}));assert.throws(()=>validateSchedule({type:'cron',expression:'1e1 0 * * *'}));
 const original=Intl.DateTimeFormat.prototype.formatToParts;let calls=0;Intl.DateTimeFormat.prototype.formatToParts=function(...args){calls++;return original.apply(this,args);};
 try{const next=nextSchedule({type:'cron',expression:'* * * * *'},Date.parse('2026-10-26T15:59:59Z'));assert.equal(new Date(next).toISOString(),'2026-10-26T16:00:00.000Z');assert.equal(calls,0);}finally{Intl.DateTimeFormat.prototype.formatToParts=original;}
 assert.equal(new Date(nextSchedule({type:'cron',expression:'0 0 29 2 *'},Date.parse('2026-10-26T00:00:00Z'))).toISOString(),'2028-02-28T16:00:00.000Z');
});

test('Baidu read-only reconciliation confirms App and rewards without sign-in requests',async()=>{
 let report={date:beijingDate(),attempts:1,enabled:{pc:false,app:true,awards:true},steps:[{id:'app',phase:'before_operation'}],awards:{claimable:[{day:3}]},errors:[]};const paths=[];
 const result=await reconcileBaidu({credentials:{cookie:'BDUSS=mock-cookie',cuid:'mock-device'},settings:{enable_pc:false},load:async()=>report,save:async r=>{report=r;},fetcher:async input=>{
  const u=new URL(input);paths.push(u.pathname);
  if(u.pathname==='/rest/2.0/membership/user')return Response.json({errno:0,level_info:{current_value:100}});
  if(u.pathname.endsWith('/signinlist'))return Response.json({errno:0,data:{signed_today:1,signin_days:3,reward_list:[{day:3,received:1,prize:[{}]}]}});
  throw Error('Mutating endpoint prohibited');
 }});
 assert.equal(result.status,'succeeded');assert.equal(paths.length,2);assert.equal(report.reconciliation.readOnly,true);
});

test('Baidu uncertain PC operation is not inferred from growth or replayed',async()=>{
 let report={date:beijingDate(),attempts:1,enabled:{pc:true,app:false,awards:false},steps:[{id:'pc',phase:'before_operation',before:100}],errors:[]};let requests=0;
 const result=await reconcileBaidu({credentials:{cookie:'BDUSS=mock-cookie'},settings:{enable_app:false,enable_awards:false},load:async()=>report,save:async r=>{report=r;},fetcher:async input=>{requests++;assert.equal(new URL(input).pathname,'/rest/2.0/membership/user');return Response.json({errno:0,level_info:{current_value:999}});}});
 assert.equal(result.status,'waiting_verification');assert.equal(requests,1);
});

test('Baidu failure response is canceled without body or Cookie logging',async()=>{
 const original=console.warn,logs=[];console.warn=(...args)=>logs.push(args.join(' '));let canceled=false;
 try{
  const client=new BaiduClient({cookie:'BDUSS=VERY_SECRET',cuid:'device',headers:{},timeout:1000},async()=>({status:503,body:{cancel:async()=>{canceled=true;}},text:async()=>{throw Error('must not read error body');}}));
  await assert.rejects(client.growth(),/HTTP 503/);assert.equal(canceled,true);assert.equal(logs.length,1);assert.ok(!logs.join('').includes('SECRET'));assert.ok(!logs.join('').includes('BDUSS'));
 }finally{console.warn=original;}
});

test('Baidu successful HTTP response still has a streamed byte limit',async()=>{
 let canceled=false;const stream=new ReadableStream({pull(c){c.enqueue(new Uint8Array(70000).fill(32));},cancel(){canceled=true;}});
 const client=new BaiduClient({cookie:'BDUSS=mock-cookie',cuid:'device',headers:{},timeout:1000},async()=>new Response(stream));
 await assert.rejects(client.growth());assert.equal(canceled,true);
});

test('manual settlement verifies admin, survives interrupted D1 commit and never replays assets',async()=>{
 const f=await prepared();try{
  await run(f.DB,{status:'waiting_verification'});f.storage=indexedStorage();const d=new AccountCoordinator({storage:f.storage},f.env);
  await f.storage.put({'report:run':{attempts:2,exchange:{state:'unverified',requestedAt:new Date().toISOString()}},bili_pending_exchange:{runId:'run'}});
  const body={runId:'run',actorId:'admin',outcome:'failed',evidence:'管理员已逐项核对上游订单和余额，确认该操作未成功，没有重新提交任何请求。',confirmNoRepeat:true};
  assert.equal((await invoke(d,'/resolve',{...body,actorId:'alice'})).status,403);
  f.DB.failBatchAt=1;assert.equal((await invoke(d,'/resolve',body)).status,500);f.DB.failBatchAt=null;
  assert.ok(await f.storage.get('settlement:run'));assert.ok(await f.storage.get('bili_pending_exchange'));
  assert.equal((await f.DB.prepare('SELECT count(*) n FROM manual_resolutions').first()).n,0);
  assert.equal((await invoke(d,'/resolve',{...body,outcome:'succeeded'})).status,409);
  await withFetch(async()=>{throw Error('Must never repeat an external operation');},async()=>{
   await invoke(d,'/reconcile',{runId:'run'});const result=await invoke(d,'/resolve',body);assert.equal(result.status,200);
   const repeated=await invoke(d,'/resolve',body);assert.equal(repeated.status,200);assert.equal((await repeated.json()).replayed,true);
   await invoke(d,'/run',{runId:'run'});
  });
  assert.equal((await f.DB.prepare("SELECT status FROM job_runs WHERE id='run'").first()).status,'failed');
  assert.equal(await f.storage.get('bili_pending_exchange'),undefined);assert.ok(await f.storage.get('report:run'));assert.ok(await f.storage.get('settlement:run'));
  assert.equal((await f.DB.prepare('SELECT count(*) n FROM manual_resolutions').first()).n,1);
  await assert.rejects(f.DB.prepare("UPDATE manual_resolutions SET outcome='succeeded'").run(),/immutable/);
  await assert.rejects(f.DB.prepare('DELETE FROM manual_resolutions').run(),/immutable/);
 }finally{f.DB.close();}
});

test('purge protects submitted waiting_retry but accepts a legacy terminal report',async()=>{
 const f=await prepared();try{
  await run(f.DB,{status:'waiting_retry'});const storage=indexedStorage(),d=new AccountCoordinator({storage},f.env);
  await storage.put('report:run',{steps:[{id:'app',phase:'before_operation'}]});
  assert.equal((await invoke(d,'/purge',{confirm:true})).status,409);assert.ok(await storage.get('report:run'));
  await f.DB.prepare("UPDATE job_runs SET status='succeeded' WHERE id='run'").run();
  assert.equal((await invoke(d,'/purge',{confirm:true})).status,200);assert.equal(await storage.get('report:run'),undefined);
 }finally{f.DB.close();}
});

test('old terminal DO evidence is cleaned but unresolved evidence and matching latch remain',async()=>{
 const f=await prepared();try{
  await run(f.DB,{id:'done',status:'succeeded',created:Date.now()-400*86400000});await run(f.DB,{id:'pending',status:'waiting_verification',created:Date.now()-400*86400000});
  const storage=indexedStorage(),d=new AccountCoordinator({storage},f.env);
  await storage.put({'report:done':{time:new Date(Date.now()-400*86400000).toISOString()},'report:pending':{exchange:{requestedAt:'old'}},bili_pending_exchange:{runId:'pending'}});
  await d.alarm();assert.equal(await storage.get('report:done'),undefined);assert.ok(await storage.get('report:pending'));assert.ok(await storage.get('bili_pending_exchange'));
 }finally{f.DB.close();}
});

test('retention keeps unlock proof after D1 commit until DO cleanup is confirmed',async()=>{
 const f=await prepared(),realNow=Date.now;try{
  await run(f.DB,{status:'waiting_verification'});const storage=indexedStorage(),d=new AccountCoordinator({storage},f.env);
  await storage.put({'report:run':{attempts:2,exchange:{state:'unverified',requestedAt:'old'}},bili_pending_exchange:{runId:'run'}});
  const body={runId:'run',actorId:'admin',outcome:'failed',evidence:'管理员已核验上游历史订单及余额，并明确确认这一次没有成功扣费且不会重发。',confirmNoRepeat:true};
  const transact=storage.transaction.bind(storage);storage.transaction=async()=>{throw Error('Injected DO post-commit failure');};
  const past=realNow()-400*86400000;Date.now=()=>past;
  assert.equal((await invoke(d,'/resolve',body)).status,500);Date.now=realNow;
  assert.equal((await f.DB.prepare("SELECT status FROM job_runs WHERE id='run'").first()).status,'failed');
  await maintenance(f.env);
  const kept=await f.DB.prepare("SELECT cleanup_confirmed_at FROM manual_resolutions WHERE run_id='run'").first();
  assert.ok(kept);assert.equal(kept.cleanup_confirmed_at,null);assert.ok(await storage.get('bili_pending_exchange'));
  storage.transaction=transact;
  assert.equal((await invoke(d,'/resolve',body)).status,200);assert.equal(await storage.get('bili_pending_exchange'),undefined);
  assert.ok((await f.DB.prepare("SELECT cleanup_confirmed_at FROM manual_resolutions WHERE run_id='run'").first()).cleanup_confirmed_at);
  await maintenance(f.env);assert.equal(await f.DB.prepare("SELECT run_id FROM manual_resolutions WHERE run_id='run'").first(),null);
  await d.alarm();assert.equal(await storage.get('settlement:run'),undefined);assert.equal(await storage.get('report:run'),undefined);
 }finally{Date.now=realNow;f.DB.close();}
});

test('scheduler timestamp advancement failure rolls back run, usage and outbox together',async()=>{
 const f=await prepared();try{
  // One run insert, one outbox insert, then its next_run_at update.
  f.DB.failBatchAt=2;
  const result=await scheduledTick(f.env);f.DB.failBatchAt=null;
  assert.equal(result.scheduled,0);
  for(const table of ['job_runs','run_usage_claims','outbox'])assert.equal((await f.DB.prepare('SELECT count(*) n FROM '+table).first()).n,0,table);
  assert.ok((await f.DB.prepare("SELECT next_run_at FROM jobs WHERE id='job'").first()).next_run_at>Date.now());
  await f.DB.prepare("UPDATE jobs SET next_run_at=? WHERE id='job'").bind(Date.now()-1000).run();
  assert.equal((await scheduledTick(f.env)).scheduled,1);
  assert.equal((await f.DB.prepare('SELECT count(*) n FROM job_runs').first()).n,1);
 }finally{f.DB.close();}
});
