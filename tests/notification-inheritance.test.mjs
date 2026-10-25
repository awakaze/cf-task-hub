import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,account,job,run} from './helpers/d1.mjs';
import {routeEvent,deliverNotification} from '../src/providers/notify.ts';
import {encrypt} from '../src/core/crypto.ts';
import {DEFAULT_POLICY} from '../src/core/notifications.ts';
async function prepared(platformPolicy=null){
 const f=await fixture();await account(f.DB);await job(f.DB);await run(f.DB);
 await f.DB.prepare("INSERT INTO notification_channels(id,owner_user_id,name,type,config_enc,created_at,updated_at) VALUES('ch','alice','test','telegram',?,?,?)").bind(await encrypt(f.env.DATA_KEY,'alice','ch',{botToken:'123456:abcdefghijklmnopqrstuvwxyz123456789',chatId:'123456'}),Date.now(),Date.now()).run();
 await f.DB.prepare("INSERT INTO notification_policies(id,owner_user_id,scope_type,scope_id,success_enabled,exception_enabled,success_channels_json,error_mode,exception_channels_json,updated_at) VALUES('p','alice','user','alice',1,1,'[\"ch\"]','same','[]',?)").bind(Date.now()).run();
 await f.DB.prepare('INSERT INTO platform_groups(id,owner_user_id,module_id,config_json,schedule_json,notify_json,features_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').bind('g','alice','bilibili-vip','{}','{}',platformPolicy==null?null:JSON.stringify(platformPolicy),'[]',Date.now(),Date.now()).run();
 await f.DB.prepare("UPDATE accounts SET group_id='g' WHERE id='account'").run();
 await f.DB.prepare("INSERT INTO job_events(id,owner_user_id,run_id,event_type,summary,created_at) VALUES('e','alice','run','success','Test result',?)").bind(Date.now()).run();
 return f;
}
test('NULL platform policy inherits user notification channels',async()=>{const f=await prepared();try{await routeEvent(f.env,'e');const row=await f.DB.prepare('SELECT channel_id,status FROM notification_deliveries').first();assert.equal(row.channel_id,'ch');assert.equal(row.status,'queued');}finally{f.DB.close();}});
test('explicit empty platform policy suppresses user channels without being mistaken for inheritance',async()=>{const f=await prepared(DEFAULT_POLICY);try{await routeEvent(f.env,'e');assert.equal((await f.DB.prepare('SELECT count(*) n FROM notification_deliveries').first()).n,0);assert.ok((await f.DB.prepare("SELECT routed_at FROM job_events WHERE id='e'").first()).routed_at);}finally{f.DB.close();}});
test('successful notification marks its queue intent done so historical rows are not recovery candidates',async()=>{const f=await prepared();try{await routeEvent(f.env,'e');const delivery=await f.DB.prepare('SELECT id FROM notification_deliveries').first();let sends=0;await deliverNotification(f.env,delivery.id,async()=>{sends++;return Response.json({ok:true,result:{message_id:1}});});assert.equal(sends,1);assert.equal((await f.DB.prepare('SELECT status FROM notification_deliveries').first()).status,'delivered');assert.equal((await f.DB.prepare("SELECT status FROM outbox WHERE kind='notify'").first()).status,'done');}finally{f.DB.close();}});
