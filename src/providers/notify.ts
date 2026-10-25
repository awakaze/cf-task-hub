import {decryptConfig} from '../core/secrets.ts';
import type {Env} from '../core/types.ts';
import {assert,HttpError} from '../core/response.ts';
import {setting} from '../core/db.ts';
import {validateWebhookTarget,validateWebhookDns,notificationText,routeChannels,DEFAULT_POLICY} from '../core/notifications.ts';
import {decrypt} from '../core/crypto.ts';
import {boundedText} from '../core/network.ts';
import {takeRate,requireRunning} from '../core/safety.ts';
export class NotificationError extends Error{
 retryable:boolean;retryAfter:number;
 constructor(message:string,retryable=true,retryAfter=0){super(message);this.retryable=retryable;this.retryAfter=retryAfter;}
}
async function checkStatus(response:Response,kind:string){
 if(!response.ok){await response.body?.cancel();const retryAfter=Number(response.headers.get('Retry-After')||0);
  throw new NotificationError(`${kind}: HTTP ${response.status}`,response.status===429||response.status>=500,Number.isFinite(retryAfter)?Math.min(86400,retryAfter):0);}
 const result=await boundedText(response,8192);
 if(!result){if(kind==='Webhook')return;throw new NotificationError(`${kind}: empty response`,false);}
 let parsed:any;try{parsed=JSON.parse(result);}catch{if(kind==='Webhook')return;throw new NotificationError(`${kind}: invalid JSON`,false);}
 if(kind==='Telegram'&&parsed.ok!==true)throw new NotificationError('Telegram: rejected',parsed.error_code===429||parsed.error_code>=500,Number(parsed.parameters?.retry_after||0));
 if(kind==='ServerChan'&&(parsed.code===undefined||Number(parsed.code)!==0))throw new NotificationError('ServerChan: rejected',false);
}
export async function validateChannelInput(env:Env,type:string,raw:unknown):Promise<Record<string,unknown>>{
 assert(raw&&typeof raw==='object'&&!Array.isArray(raw),400,'INVALID_CONFIG','Invalid notification configuration');
 const config=raw as Record<string,unknown>;
 if(type==='webhook'){
  const url=String(config.url||'');const allowed=await setting<string[]>(env,'webhook_allowed_hosts',[]);
  try{validateWebhookTarget(url,allowed);}catch{throw new HttpError(400,'INVALID_WEBHOOK','Webhook requires an approved HTTPS hostname');}
  assert(url.length<=2048,400,'INVALID_WEBHOOK','Webhook URL too long');
  const headers=config.headers&&typeof config.headers==='object'&&!Array.isArray(config.headers)?config.headers as Record<string,string>:{};
  assert(Object.keys(headers).length<=5&&Object.entries(headers).every(([k,v])=>/^(X-[A-Za-z0-9-]+|Authorization)$/i.test(k)&&!/^X-TaskHub-/i.test(k)&&typeof v==='string'&&v.length<500&&!/[\r\n]/.test(v)),400,'INVALID_HEADERS','Only Authorization and non-reserved X- headers are supported');
  return {url,headers,signingSecret:String(config.signingSecret||'').slice(0,200)};
 }
 if(type==='telegram'){
  const botToken=String(config.botToken||''),chatId=String(config.chatId||''),threadId=String(config.threadId??'');
  assert(/^\d{5,15}:[A-Za-z0-9_-]{30,100}$/.test(botToken),400,'INVALID_BOT','Invalid Bot Token');
  assert(/^-?\d{2,20}$/.test(chatId),400,'INVALID_CHAT','Invalid Chat ID');
  assert(!threadId||(/^\d{1,12}$/.test(threadId)&&Number.isSafeInteger(Number(threadId))),400,'INVALID_THREAD','Invalid topic ID');
  return {botToken,chatId,threadId};
 }
 if(type==='serverchan'){
  const sendKey=String(config.sendKey||'');assert(/^SCT[a-zA-Z0-9_-]{12,200}$/.test(sendKey),400,'INVALID_SENDKEY','Invalid ServerChan Turbo SendKey');
  return {sendKey};
 }
 throw new HttpError(400,'INVALID_CHANNEL','Unsupported notification type');
}
export async function sendNotification(type:string,config:any,event:any,fetcher:typeof fetch=fetch):Promise<void>{
 const msg=notificationText(event),signal=AbortSignal.timeout(10000);
 if(type==='webhook'){
  const body=JSON.stringify({event_id:event.id,event_type:'task.'+event.event_type,module:event.module_id||null,task:event.task_key||null,account_label:event.account_label||null,status:event.status||null,message:event.summary,occurred_at:new Date(event.created_at).toISOString(),run_url:event.run_url||null});
  const headers:Record<string,string>={...config.headers,'Content-Type':'application/json','X-TaskHub-Event-Id':String(event.id),'X-TaskHub-Timestamp':String(Date.now())};
  if(config.signingSecret){const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(config.signingSecret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
   const sig=new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(`${headers['X-TaskHub-Timestamp']}.${body}`)));
   headers['X-TaskHub-Signature']='sha256='+Array.from(sig,b=>b.toString(16).padStart(2,'0')).join('');}
  await checkStatus(await fetcher(config.url,{method:'POST',headers,body,redirect:'manual',signal}),'Webhook');return;
 }
 if(type==='telegram'){
  const payload:any={chat_id:config.chatId,text:(msg.title+'\n'+msg.text).slice(0,3900),disable_web_page_preview:true};if(config.threadId)payload.message_thread_id=Number(config.threadId);
  await checkStatus(await fetcher(`https://api.telegram.org/bot${config.botToken}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),redirect:'manual',signal}),'Telegram');return;
 }
 if(type==='serverchan'){
  await checkStatus(await fetcher(`https://sctapi.ftqq.com/${encodeURIComponent(config.sendKey)}.send`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({title:msg.title.slice(0,100),desp:msg.text}),redirect:'manual',signal}),'ServerChan');return;
 }
 throw new NotificationError('Unsupported channel',false);
}
async function reserveBudget(env:Env,owner:string,id:string){
 await env.DB.prepare("INSERT OR IGNORE INTO usage_claims(id,day,owner_user_id,kind,created_at) VALUES(?,?,?,'notification',?)").bind(id,new Date().toISOString().slice(0,10),owner,Date.now()).run();
}
export async function sendTestNotification(env:Env,owner:string,channel:any,fetcher:typeof fetch=fetch){
 await requireRunning(env);await takeRate(env,'notify-test:'+owner,3,86400000);
 const config=await decryptConfig<any>(env,owner,channel.id,channel.config_enc);
 if(channel.type==='webhook')await validateWebhookDns(config.url,await setting<string[]>(env,'webhook_allowed_hosts',[]),fetcher);
 try{await reserveBudget(env,owner,'test:'+crypto.randomUUID());}catch{throw new HttpError(429,'NOTIFICATION_QUOTA','Notification quota exceeded');}
 await sendNotification(channel.type,config,{id:crypto.randomUUID(),event_type:'success',summary:'Notification channel test',created_at:Date.now(),module_id:'system',task_key:'notification.test',account_label:'Test'},fetcher);
}
function policyFrom(row:any){const error_mode:'same'|'custom'=row.error_mode==='custom'?'custom':'same';return {success_enabled:!!row.success_enabled,exception_enabled:!!row.exception_enabled,success_channels:Array.isArray(row.success_channels)?row.success_channels:[],error_mode,exception_channels:Array.isArray(row.exception_channels)?row.exception_channels:[]};}
function parsePolicy(raw:string|null|undefined){
 // NULL means inherit. An explicit policy with empty channels means no delivery.
 if(raw==null||raw==='')return null;
 try{const value=JSON.parse(raw);if(!value||typeof value!=='object'||Array.isArray(value))return null;
  return {...DEFAULT_POLICY,success_enabled:value.success_enabled!==false,exception_enabled:value.exception_enabled!==false,success_channels:Array.isArray(value.success_channels)?value.success_channels:[],error_mode:(value.error_mode==='custom'?'custom':'same') as 'same'|'custom',exception_channels:Array.isArray(value.exception_channels)?value.exception_channels:[]};}catch{return null;}
}
async function selectPolicy(env:Env,ownerId:string,accountId:string,jobId:string){
 const job=await env.DB.prepare("SELECT success_enabled,exception_enabled,success_channels_json,error_mode,exception_channels_json FROM notification_policies WHERE owner_user_id=? AND scope_type='job' AND scope_id=?").bind(ownerId,jobId).first<any>();
 if(job)return {...policyFrom(job),success_channels:JSON.parse(job.success_channels_json),exception_channels:JSON.parse(job.exception_channels_json)};
 const account=await env.DB.prepare("SELECT success_enabled,exception_enabled,success_channels_json,error_mode,exception_channels_json FROM notification_policies WHERE owner_user_id=? AND scope_type='account' AND scope_id=?").bind(ownerId,accountId).first<any>();
 if(account)return {...policyFrom(account),success_channels:JSON.parse(account.success_channels_json),exception_channels:JSON.parse(account.exception_channels_json)};
 // Platform membership sits between the account override and the user default.
 const group=await env.DB.prepare('SELECT g.notify_json FROM accounts a JOIN platform_groups g ON g.id=a.group_id AND g.owner_user_id=a.owner_user_id WHERE a.id=? AND a.owner_user_id=?').bind(accountId,ownerId).first<{notify_json:string|null}>();
 const platformPolicy=parsePolicy(group?.notify_json);
 if(platformPolicy)return platformPolicy;
 const own=await env.DB.prepare("SELECT success_enabled,exception_enabled,success_channels_json,error_mode,exception_channels_json FROM notification_policies WHERE owner_user_id=? AND scope_type='user' AND scope_id=?").bind(ownerId,ownerId).first<any>();
 return own?{...policyFrom(own),success_channels:JSON.parse(own.success_channels_json),exception_channels:JSON.parse(own.exception_channels_json)}:DEFAULT_POLICY;
}
export async function routeEvent(env:Env,eventId:string){
 const event=await env.DB.prepare('SELECT e.*,r.job_id,j.account_id FROM job_events e JOIN job_runs r ON r.id=e.run_id JOIN jobs j ON j.id=r.job_id WHERE e.id=?').bind(eventId).first<any>();if(!event||event.routed_at)return;
 const policy=await selectPolicy(env,event.owner_user_id,event.account_id,event.job_id);
 const ids=event.event_type==='info'?[]:routeChannels(policy,event.event_type==='success'?'success':'exception');
 const statements:D1PreparedStatement[]=[];
 for(const channelId of ids){const deliveryId=crypto.randomUUID();
  statements.push(env.DB.prepare(`INSERT OR IGNORE INTO notification_deliveries(id,owner_user_id,event_id,channel_id,status,attempts)
   SELECT ?,?,? ,id,'queued',0 FROM notification_channels WHERE id=? AND owner_user_id=? AND enabled=1`).bind(deliveryId,event.owner_user_id,event.id,channelId,event.owner_user_id));
  statements.push(env.DB.prepare(`INSERT OR IGNORE INTO outbox(id,owner_user_id,kind,ref_id,payload_json,status,next_attempt_at,updated_at)
   SELECT ?,owner_user_id,'notify',id,json_object('kind','notify','id',id),'pending',?,? FROM notification_deliveries WHERE event_id=? AND channel_id=?`).bind(crypto.randomUUID(),Date.now(),Date.now(),event.id,channelId));
 }
 statements.push(env.DB.prepare('UPDATE job_events SET routed_at=? WHERE id=? AND routed_at IS NULL').bind(Date.now(),event.id));
 await env.DB.batch(statements);
}
export async function deliverNotification(env:Env,deliveryId:string,fetcher:typeof fetch=fetch){
 const now=Date.now(),token=crypto.randomUUID();
 const claim=await env.DB.prepare(`UPDATE notification_deliveries SET status='sending',lease_token=?,lease_until=?,attempts=attempts+1
 WHERE id=? AND attempts<3 AND (next_attempt_at IS NULL OR next_attempt_at<=?)
 AND (status IN ('queued','retry') OR (status='sending' AND lease_until<?)) RETURNING id`).bind(token,now+120000,deliveryId,now,now).first();
 if(!claim)return;
 const row=await env.DB.prepare(`SELECT d.*,ch.type,ch.config_enc,ch.enabled,ch.cooldown_until,
 e.summary,e.event_type,e.created_at,e.run_id,r.status run_status,r.result_json,a.label account_label,a.module_id,j.task_key,u.status user_status
 FROM notification_deliveries d JOIN notification_channels ch ON ch.id=d.channel_id JOIN job_events e ON e.id=d.event_id
 JOIN job_runs r ON r.id=e.run_id JOIN jobs j ON j.id=r.job_id JOIN accounts a ON a.id=j.account_id
 JOIN users u ON u.id=d.owner_user_id WHERE d.id=? AND d.lease_token=?`).bind(deliveryId,token).first<any>();
 if(!row)return;
 const finish=async(status:string,error:string|null,delay=0)=>{
  const due=Date.now()+delay;
  await env.DB.batch([
   env.DB.prepare('UPDATE notification_deliveries SET status=?,last_error=?,next_attempt_at=?,lease_token=NULL,lease_until=NULL,delivered_at=CASE WHEN ?=\'delivered\' THEN ? ELSE delivered_at END WHERE id=? AND lease_token=?').bind(status,error,due,status,Date.now(),deliveryId,token),
   env.DB.prepare("UPDATE outbox SET status=?,next_attempt_at=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE kind='notify' AND ref_id=?").bind(status==='retry'?'pending':'done',due,Date.now(),deliveryId),
  ]);
 };
 if(row.user_status!=='active'||!row.enabled){await finish('disabled',null);return;}
 if(env.MAINTENANCE_MODE==='true'||await setting(env,'maintenance',false)||Number(row.cooldown_until||0)>now){
  await env.DB.prepare('UPDATE notification_deliveries SET attempts=attempts-1 WHERE id=? AND lease_token=?').bind(deliveryId,token).run();
  await finish('retry','Temporarily paused',Math.max(300000,Number(row.cooldown_until||0)-now));return;
 }
 try{
  const config=await decryptConfig<any>(env,row.owner_user_id,row.channel_id,row.config_enc);
  if(row.type==='webhook')await validateWebhookDns(config.url,await setting<string[]>(env,'webhook_allowed_hosts',[]),fetcher);
  try{await reserveBudget(env,row.owner_user_id,deliveryId+':'+token);}catch{throw new NotificationError('NOTIFICATION_QUOTA',false);}
  const origin=await setting<string>(env,'public_origin','');
  let report:unknown=null;try{report=JSON.parse(row.result_json||'{}')?.details?.report??null;}catch{}
  await sendNotification(row.type,config,{id:row.event_id,event_type:row.event_type,summary:row.summary,created_at:row.created_at,module_id:row.module_id,task_key:row.task_key,account_label:row.account_label,status:row.run_status,report,run_url:origin?`${origin}/?run=${row.run_id}`:null},fetcher);
  await finish('delivered',null);
  await env.DB.prepare('UPDATE notification_channels SET consecutive_failures=0,cooldown_until=NULL WHERE id=?').bind(row.channel_id).run();
 }catch(error){
  const retry=!(error instanceof NotificationError)||error.retryable;
  const state=row.attempts>=3||!retry?'failed':'retry';
  const backoff=Math.max(60000*2**row.attempts,(error instanceof NotificationError?error.retryAfter:0)*1000);
  await finish(state,error instanceof NotificationError?error.message:'Notification request failed; sensitive details withheld',Math.min(86400000,backoff));
  await env.DB.prepare('UPDATE notification_channels SET consecutive_failures=consecutive_failures+1,cooldown_until=CASE WHEN consecutive_failures>=2 THEN ? ELSE cooldown_until END WHERE id=?').bind(Date.now()+1800000,row.channel_id).run();
 }
}
