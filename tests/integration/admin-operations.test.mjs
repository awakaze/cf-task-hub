// Real Hono/Zod routes and SQLite migrations, with the real AccountCoordinator
// behind an in-memory DO namespace. External requests are always intercepted.
import test from 'node:test';
import assert from 'node:assert/strict';
import {app} from '../../src/index.ts';
import {AccountCoordinator} from '../../src/durable/account-coordinator.ts';
import {maintenance} from '../../src/core/maintenance.ts';
import {sha256,encrypt} from '../../src/core/crypto.ts';
import {fixture,account,job,run,memoryStorage} from '../helpers/d1.mjs';

const origin='https://taskhub.example.test',day=86400000;
const declaration={outcome:'succeeded',evidence:'已逐项核对上游交易记录和实际余额，确认指定操作已经完成；本次仅记录核对结论，不重新提交原请求。',confirmNoRepeat:true};

async function setup(t){
 const f=await fixture();f.env.APP_ORIGIN=origin;f.tokens={};f.objects=new Map();f.doRequests=[];
 for(const id of ['alice','bob','admin']){
  const token='admin-operations-session-'+id,csrf='admin-operations-csrf-'+id;f.tokens[id]={token,csrf};
  await f.DB.prepare('INSERT INTO sessions(id,user_id,token_hash,csrf_token_hash,created_at,expires_at) VALUES(?,?,?,?,?,?)')
   .bind('session-'+id,id,await sha256(token),await sha256(csrf),Date.now(),Date.now()+3600000).run();
 }
 f.object=name=>{
  if(!f.objects.has(name)){const storage=memoryStorage();f.objects.set(name,{storage,coordinator:new AccountCoordinator({storage},f.env)});}
  return f.objects.get(name);
 };
 f.env.ACCOUNTS={idFromName:name=>name,get:name=>({fetch:(input,init)=>{
  const request=input instanceof Request?input:new Request(input,init);f.doRequests.push({name,path:new URL(request.url).pathname});
  return f.object(name).coordinator.fetch(request);
 }})};
 f.request=(path,{user='admin',method='GET',body}={})=>{
  const headers=new Headers({Origin:origin});
  if(user){const {token,csrf}=f.tokens[user];headers.set('Cookie',`th_session=${token}; th_csrf=${csrf}`);if(method!=='GET')headers.set('X-CSRF-Token',csrf);}
  if(body!==undefined)headers.set('Content-Type','application/json');
  return app.request(new Request(origin+path,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})}),undefined,f.env);
 };
 f.upstream=t.mock.method(globalThis,'fetch',async()=>{throw new Error('External requests are forbidden in administrator operation tests');});
 t.after(()=>f.DB.close());return f;
}
async function response(result,expected){const body=await result.json();assert.equal(result.status,expected,JSON.stringify(body));return body;}
async function count(f,table){return (await f.DB.prepare('SELECT count(*) n FROM '+table).first()).n;}
async function pending(f){
 await account(f.DB,{id:'asset-account',fingerprint:'synthetic-asset-fingerprint'});
 await job(f.DB,{id:'exchange-job',accountId:'asset-account',task:'bili.exchange'});
 await run(f.DB,{id:'review-run',jobId:'exchange-job',status:'waiting_verification'});
 const checkpoint={attempts:2,exchange:{state:'unverified',requestedAt:'2026-01-02T03:04:05.000Z',before:{coupons:5,bcoin:0,battery:0}}};
 const object=f.object('account:synthetic-asset-fingerprint');
 await object.storage.put({'report:review-run':checkpoint,'retry:review-run':Date.now()+300000,bili_pending_exchange:{runId:'review-run'}});
 return {...object,checkpoint};
}
async function historicalQuota(f){await f.DB.prepare("INSERT INTO user_quotas(user_id,max_auto_runs) VALUES('alice',1000)").run();}
async function outbox(f,id,status,created){
 await f.DB.prepare("INSERT INTO outbox(id,owner_user_id,kind,ref_id,payload_json,status,next_attempt_at,updated_at) VALUES(?,'alice','notify',?,?,?,?,?)")
  .bind(id,id,JSON.stringify({kind:'notify',id}),status,created,created).run();
}
async function auditRecord(f,id,created){await f.DB.prepare("INSERT INTO audit_logs(id,actor_user_id,action,created_at) VALUES(?,'admin','synthetic.old',?)").bind(id,created).run();}

test('ordinary users cannot list review work, resolve a run or trigger administrator cleanup',async t=>{
 const f=await setup(t);await pending(f);await auditRecord(f,'protected-old-audit',Date.now()-400*day);
 for(const [path,method,body] of [
  ['/api/v1/admin/runs?status=waiting_verification','GET'],
  ['/api/v1/admin/runs/review-run/resolve','POST',declaration],
  ['/api/v1/admin/maintenance/cleanup','POST',{beforeDays:90,confirm:true}],
 ]){
  const result=await response(await f.request(path,{user:'alice',method,body}),403);
  assert.ok(!JSON.stringify(result).includes('review-run'),'denial must not reveal the selected run');
 }
 assert.equal((await f.DB.prepare("SELECT status FROM job_runs WHERE id='review-run'").first()).status,'waiting_verification');
 assert.equal(await count(f,'manual_resolutions'),0);assert.equal(await count(f,'audit_logs'),1);
 assert.equal(f.doRequests.filter(x=>x.path==='/resolve').length,0);assert.equal(f.upstream.mock.callCount(),0);
 const listed=await response(await f.request('/api/v1/admin/runs?status=waiting_verification'),200);
 assert.equal(listed.items.length,1);assert.equal(listed.items[0].id,'review-run');assert.equal(listed.items[0].owner_username,'alice');assert.equal(listed.items[0].task_key,'bili.exchange');
});

test('manual resolution requires recent administrator authentication and rejects secret-looking evidence',async t=>{
 const f=await setup(t),{storage}=await pending(f);
 await f.DB.prepare("UPDATE sessions SET created_at=? WHERE id='session-admin'").bind(Date.now()-16*60000).run();
 let result=await response(await f.request('/api/v1/admin/runs/review-run/resolve',{method:'POST',body:declaration}),403);
 assert.equal(result.error,'REAUTH_REQUIRED');
 await f.DB.prepare("UPDATE sessions SET created_at=? WHERE id='session-admin'").bind(Date.now()).run();
 const secret='synthetic-not-a-real-token';
 result=await response(await f.request('/api/v1/admin/runs/review-run/resolve',{method:'POST',body:{...declaration,evidence:declaration.evidence+' STOKEN='+secret}}),400);
 assert.equal(result.error,'SECRET_IN_EVIDENCE');assert.ok(!JSON.stringify(result).includes(secret));
 assert.equal(await count(f,'manual_resolutions'),0);assert.equal(await count(f,'audit_logs'),0);
 assert.equal(await storage.get('settlement:review-run'),undefined);assert.ok(await storage.get('bili_pending_exchange'));
 assert.equal(f.doRequests.filter(x=>x.path==='/resolve').length,0);assert.equal(f.upstream.mock.callCount(),0);
});

test('administrator resolution uses the real coordinator, is idempotent and never repeats an upstream action',async t=>{
 const f=await setup(t),{storage,checkpoint,coordinator}=await pending(f);
 const request={method:'POST',body:declaration},path='/api/v1/admin/runs/review-run/resolve';
 const first=await response(await f.request(path,request),200);
 assert.equal(first.manual_resolution,true);assert.equal(first.replayed,false);assert.equal(first.status,'succeeded');assert.ok(first.resolutionId);
 const stored=await f.DB.prepare("SELECT * FROM manual_resolutions WHERE run_id='review-run'").first();
 assert.equal(stored.owner_user_id,'alice');assert.equal(stored.actor_user_id,'admin');assert.equal(stored.outcome,'succeeded');assert.equal(stored.evidence,declaration.evidence);assert.deepEqual(JSON.parse(stored.checkpoint_json),checkpoint);assert.ok(stored.cleanup_confirmed_at);
 const state=await f.DB.prepare("SELECT status,error_code FROM job_runs WHERE id='review-run'").first();
 assert.deepEqual(state,{status:'succeeded',error_code:'MANUAL_RESOLUTION'});
 assert.equal(await storage.get('bili_pending_exchange'),undefined);assert.equal(await storage.get('retry:review-run'),undefined);assert.deepEqual(await storage.get('report:review-run'),checkpoint);
 const repeated=await response(await f.request(path,request),200);
 assert.equal(repeated.replayed,true);assert.equal(repeated.resolutionId,first.resolutionId);
 for(const body of [{...declaration,outcome:'failed'},{...declaration,evidence:declaration.evidence+' 此处改变了原声明。'}]){
  const conflict=await response(await f.request(path,{method:'POST',body}),409);assert.equal(conflict.error,'RESOLUTION_CONFLICT');
 }
 await response(await coordinator.fetch(new Request('https://internal/run',{method:'POST',body:JSON.stringify({runId:'review-run'})})),200);
 assert.equal(await count(f,'manual_resolutions'),1);assert.equal(await count(f,'job_steps'),1);assert.equal(await count(f,'job_events'),1);assert.equal(await count(f,'job_runs'),1);
 assert.deepEqual(await f.DB.prepare("SELECT * FROM manual_resolutions WHERE run_id='review-run'").first(),stored,'replay and conflicts must not rewrite the declaration');
 assert.equal(f.queued.length,0);assert.equal(f.upstream.mock.callCount(),0);
});

test('cleanup respects ordinary and asset retention, preserves pending work and independent manual evidence',async t=>{
 const f=await setup(t);await historicalQuota(f);const now=Date.now();
 await account(f.DB,{id:'ordinary-account',module:'baidu-netdisk'});await job(f.DB,{id:'ordinary-job',accountId:'ordinary-account',task:'baidu.daily'});
 await account(f.DB,{id:'asset-account'});await job(f.DB,{id:'asset-job',accountId:'asset-account',task:'bili.exchange'});
 const cases=[
  ['ordinary-success','ordinary-job','succeeded',91,true],['ordinary-noop','ordinary-job','already_done',91,true],
  ['ordinary-failure','ordinary-job','failed',91,true],['ordinary-canceled','ordinary-job','canceled',91,true],
  ['ordinary-recent','ordinary-job','succeeded',89,false],['ordinary-queued','ordinary-job','queued',400,false],
  ['ordinary-review','ordinary-job','waiting_verification',400,false],['asset-success','asset-job','succeeded',366,true],
  ['asset-failure','asset-job','failed',366,true],['asset-midage','asset-job','succeeded',200,false],
  ['asset-recent','asset-job','succeeded',364,false],['asset-running','asset-job','running',400,false],
  ['asset-retry','asset-job','waiting_retry',400,false],['asset-scheduled','asset-job','scheduled',400,false],
 ];
 // Populate terminal history before active work: the account backlog guard is
 // intentionally enforced on every new run, including test fixture inserts.
 for(const [id,jobId,status,days] of [...cases].sort((a,b)=>Number(!['succeeded','already_done','failed','canceled'].includes(a[2]))-Number(!['succeeded','already_done','failed','canceled'].includes(b[2]))))
  await run(f.DB,{id,jobId,status,created:now-days*day});
 const evidence='已核对上游原始记录，本条人工声明应独立保留，普通运行日志到期不能删除此证据。';
 await f.DB.prepare('INSERT INTO manual_resolutions(run_id,owner_user_id,actor_user_id,outcome,evidence,checkpoint_json,resolution_id,created_at,cleanup_confirmed_at) VALUES(?,?,?,?,?,?,?,?,?)')
  .bind('ordinary-success','alice','admin','succeeded',evidence,'{"observed":"confirmed"}','retained-resolution',now-day,now-day).run();
 for(const [id,days] of [['audit-old',366],['audit-under-year',364],['audit-three-months',100],['audit-new',1]])await auditRecord(f,id,now-days*day);
 const outboxes=[['done-old','done',91,true],['dead-old','dead',91,true],['canceled-old','canceled',91,true],['done-new','done',89,false],['pending-old','pending',400,false],['sending-old','sending',400,false],['sent-old','sent',400,false]];
 for(const [id,status,days] of outboxes)await outbox(f,id,status,now-days*day);
 const result=await response(await f.request('/api/v1/admin/maintenance/cleanup',{method:'POST',body:{beforeDays:90,confirm:true}}),200);
 assert.deepEqual(result.deleted,{runs:6,outbox:3,audit:1});assert.equal(result.bounded,true);assert.equal(result.protectedEvidenceRetained,true);
 for(const [id,,,,removed] of cases)assert.equal(!!await f.DB.prepare('SELECT id FROM job_runs WHERE id=?').bind(id).first(),!removed,id);
 for(const [id,,,removed] of outboxes)assert.equal(!!await f.DB.prepare('SELECT id FROM outbox WHERE id=?').bind(id).first(),!removed,id);
 assert.equal(await f.DB.prepare("SELECT id FROM audit_logs WHERE id='audit-old'").first(),null);
 for(const id of ['audit-under-year','audit-three-months','audit-new'])assert.ok(await f.DB.prepare('SELECT id FROM audit_logs WHERE id=?').bind(id).first());
 const proof=await f.DB.prepare("SELECT evidence,checkpoint_json FROM manual_resolutions WHERE run_id='ordinary-success'").first();
 assert.deepEqual(proof,{evidence,checkpoint_json:'{"observed":"confirmed"}'});assert.equal(f.upstream.mock.callCount(),0);
});

test('administrator cleanup deletes at most 100 eligible rows per category and can continue in another request',async t=>{
 const f=await setup(t);await historicalQuota(f);await account(f.DB,{module:'baidu-netdisk'});await job(f.DB,{task:'baidu.daily'});const old=Date.now()-400*day;
 for(let i=0;i<105;i++){
  await run(f.DB,{id:'old-run-'+i,status:'succeeded',created:old});
  await outbox(f,'old-outbox-'+i,'done',old);await auditRecord(f,'old-audit-'+i,old);
 }
 const request={method:'POST',body:{beforeDays:90,confirm:true}},path='/api/v1/admin/maintenance/cleanup';
 const first=await response(await f.request(path,request),200);assert.deepEqual(first.deleted,{runs:100,outbox:100,audit:100});
 assert.equal(await count(f,'job_runs'),5);assert.equal(await count(f,'outbox'),5);assert.equal((await f.DB.prepare("SELECT count(*) n FROM audit_logs WHERE action='synthetic.old'").first()).n,5);
 const next=await response(await f.request(path,request),200);assert.deepEqual(next.deleted,{runs:5,outbox:5,audit:5});
 assert.equal(await count(f,'job_runs'),0);assert.equal(await count(f,'outbox'),0);
 assert.equal((await f.DB.prepare("SELECT count(*) n FROM audit_logs WHERE action='maintenance.cleanup'").first()).n,2,'new cleanup audit entries must survive their own cleanup');
 assert.equal(f.upstream.mock.callCount(),0);
});

test('manual notification retry recreates an outbox intent removed by seven-day maintenance',async t=>{
 const f=await setup(t),old=Date.now()-8*day;await account(f.DB);await job(f.DB);await run(f.DB,{created:old});
 await f.DB.prepare("INSERT INTO notification_channels(id,owner_user_id,name,type,config_enc,created_at,updated_at) VALUES('channel','alice','Synthetic channel','telegram',?,?,?)")
  .bind(await encrypt(f.env.DATA_KEY,'alice','channel',{botToken:'123456:synthetic-token-not-real',chatId:'123456'}),old,old).run();
 await f.DB.prepare("INSERT INTO job_events(id,owner_user_id,run_id,event_type,summary,created_at) VALUES('event','alice','run','exception','Synthetic test failure',?)").bind(old).run();
 await f.DB.prepare("INSERT INTO notification_deliveries(id,owner_user_id,event_id,channel_id,status,attempts,last_error,next_attempt_at) VALUES('delivery','alice','event','channel','failed',3,'Synthetic test error',?)").bind(old).run();
 await f.DB.prepare("INSERT INTO outbox(id,owner_user_id,kind,ref_id,payload_json,status,next_attempt_at,updated_at) VALUES('expired-intent','alice','notify','delivery',?,'done',?,?)")
  .bind(JSON.stringify({kind:'notify',id:'delivery'}),old,old).run();
 await maintenance(f.env);assert.equal(await count(f,'outbox'),0);assert.equal(await count(f,'notification_deliveries'),1);
 const result=await response(await f.request('/api/v1/notification-history/delivery/retry',{user:'alice',method:'POST',body:{}}),200);
 assert.equal(result.duplicatePossible,true);
 const delivery=await f.DB.prepare("SELECT status,attempts,last_error FROM notification_deliveries WHERE id='delivery'").first();
 assert.deepEqual(delivery,{status:'retry',attempts:0,last_error:null});
 const intent=await f.DB.prepare("SELECT * FROM outbox WHERE kind='notify' AND ref_id='delivery'").first();
 assert.ok(intent);assert.notEqual(intent.id,'expired-intent');assert.equal(intent.owner_user_id,'alice');assert.equal(intent.status,'pending');assert.equal(intent.attempts,0);assert.equal(intent.lease_token,null);assert.deepEqual(JSON.parse(intent.payload_json),{kind:'notify',id:'delivery'});
 await response(await f.request('/api/v1/notification-history/delivery/retry',{user:'alice',method:'POST',body:{}}),409);
 assert.equal(await count(f,'outbox'),1);assert.equal((await f.DB.prepare("SELECT status FROM job_runs WHERE id='run'").first()).status,'succeeded');assert.equal(f.upstream.mock.callCount(),0);
});
