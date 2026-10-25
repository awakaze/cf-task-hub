<script setup lang="ts">
import {ref,computed,onMounted,onBeforeUnmount,nextTick,reactive,watch} from 'vue';
import {startRegistration,startAuthentication} from '@simplewebauthn/browser';

type AnyRecord=Record<string,any>;
const appVersion='0.1.0';
const logged=ref(false),ready=ref(false),setup=ref(false),screen=ref('dashboard'),adminTab=ref('stats');
const me=ref<AnyRecord>({}),message=ref(''),error=ref(''),busy=ref(false),recovery=ref<string[]>([]);
const auth=reactive({username:'',password:'',confirmPassword:'',inviteCode:'',bootstrapToken:'',recoveryCode:'',mode:'login'});
const passwordForm=reactive({current:'',next:'',confirm:''});
const modules=ref<AnyRecord[]>([]),platforms=ref<AnyRecord[]>([]),runs=ref<AnyRecord[]>([]),channels=ref<AnyRecord[]>([]),policies=ref<AnyRecord[]>([]);
const dashboard=ref<AnyRecord>({}),adminStats=ref<AnyRecord>({}),users=ref<AnyRecord[]>([]),invites=ref<AnyRecord[]>([]),adminSettings=ref<AnyRecord>({});
const activePlatform=ref('');
// Disabled modules remain accessible so users can update or delete their data.
const visiblePlatforms=computed(()=>platforms.value);
const platformDetail=ref<AnyRecord|null>(null);
const defaultNotify=()=>({success_enabled:true,exception_enabled:true,success_channels:[] as string[],error_mode:'same',exception_channels:[] as string[]});
const defaultSchedule=()=>({type:'daily',hour:9,minute:0,weekdays:[1,2,3,4,5] as number[],days:[1] as number[],expression:'0 9 * * *'});
const platformForm=reactive({features:[] as string[],config:{} as AnyRecord,schedule:defaultSchedule(),inheritNotify:true,notify:defaultNotify()});
const accountLabel=ref(''),editingAccountId=ref(''),restoreAccount=ref(true);
const cookieFields=reactive({paste:'',BDUSS:'',STOKEN:'',SESSDATA:'',bili_jct:'',DedeUserID:'',extra:''});
const qr=reactive({id:'',image:'',authUrl:'',status:'',expiresAt:0,busy:false,accountId:'',resumeJobs:false,label:'',timer:0 as ReturnType<typeof setTimeout>|0});
let qrController:AbortController|null=null,qrGeneration=0,qrDeadlineTimer:ReturnType<typeof setTimeout>|0=0;
const channelForm=reactive({type:'serverchan',name:'',botToken:'',chatId:'',threadId:'',sendKey:'',url:'',signingSecret:''});
const channelAdvanced=reactive({headers:'',clearSigningSecret:false});
const policyForm=reactive(defaultNotify());
const inviteForm=reactive({label:'',code:'',max_uses:1,expires_in_days:30}),newInviteCode=ref('');
const quotaForm=reactive({max_accounts:5,max_jobs:10,max_manual_runs:5,max_auto_runs:10,max_notifications:20,max_channels:5});
const selectedUser=ref<string|null>(null),selectedRun=ref<AnyRecord|null>(null),editingChannel=ref('');
const history=ref<AnyRecord[]>([]),passkeys=ref<AnyRecord[]>([]),sessions=ref<AnyRecord[]>([]),sessionId=ref('');
const runCursor=ref<number|null>(null),historyCursor=ref<number|null>(null);
const usersPage=ref(0),invitesPage=ref(0),auditPage=ref(0),auditRows=ref<AnyRecord[]>([]);
const runIdCursor=ref(''),historyIdCursor=ref('');
const reviewRuns=ref<AnyRecord[]>([]),reviewPage=ref(0),reviewHasNext=ref(false);
const resolution=ref<AnyRecord|null>(null),resolveForm=reactive({outcome:'failed',evidence:'',confirmNoRepeat:false});
const runDialog=ref<HTMLDialogElement|null>(null),resolveDialog=ref<HTMLDialogElement|null>(null);
let sessionGeneration=0,sessionController=new AbortController();
const languageTime=(time:any)=>time?new Date(Number(time)).toLocaleString('zh-CN',{hour12:false}):'—';
const nav=computed(()=>[
 {id:'dashboard',icon:'◫',title:'概览'},
 ...visiblePlatforms.value.map((p:AnyRecord)=>({id:'platform:'+p.module.id,icon:p.module.id==='baidu-netdisk'?'☁':'ⓑ',title:p.module.title+(p.module.enabled===false?'（已停用）':'')})),
 {id:'runs',icon:'▤',title:'运行记录'},
 {id:'notifications',icon:'◉',title:'通知设置'},
 {id:'profile',icon:'⚙',title:'个人设置'}
]);
const screenTitle=computed(()=>nav.value.find(x=>x.id===screen.value)?.title||'管理员后台');
const totals=computed(()=>visiblePlatforms.value.reduce((acc:AnyRecord,p:AnyRecord)=>{acc.accounts+=Number(p.stats?.accounts||0);acc.jobs+=Number(p.stats?.enabled_jobs||0);return acc;},{accounts:0,jobs:0}));

function csrf(){return decodeURIComponent(document.cookie.split(';').map(x=>x.trim()).find(x=>x.startsWith('th_csrf='))?.split('=').slice(1).join('=')||'');}
async function api(path:string,method='GET',body?:unknown,headers:AnyRecord={},signal?:AbortSignal):Promise<any>{
 const generation=sessionGeneration,reqHeaders:AnyRecord={...headers};if(body!==undefined)reqHeaders['Content-Type']='application/json';
 if(!['GET','HEAD'].includes(method)&&csrf())reqHeaders['X-CSRF-Token']=csrf();
 const res=await fetch(path,{method,credentials:'same-origin',headers:reqHeaders,signal:signal||sessionController.signal,...(body===undefined?{}:{body:JSON.stringify(body)})});
 let data:any={};try{data=await res.json();}catch(e){if(signal?.aborted||sessionController.signal.aborted)throw e;}
 if(generation!==sessionGeneration)throw new DOMException('Session changed','AbortError');
 if(!res.ok){
  if(res.status===401&&logged.value&&!path.startsWith('/api/v1/auth/'))resetPrivateState();
  throw Object.assign(new Error(data.message||data.error||`HTTP ${res.status}`),{status:res.status,code:data.error,retryAfterMs:Number(data.retry_after_ms)||Number(res.headers.get('Retry-After')||0)*1000});
 }
 return data;
}
async function act(fn:()=>Promise<void>){if(busy.value)return;error.value='';message.value='';busy.value=true;try{await fn();}catch(e:any){if(e?.name!=='AbortError')error.value=e?.message||String(e);}finally{busy.value=false;}}
async function copyText(value:string){try{await navigator.clipboard.writeText(value);message.value='已复制到剪贴板';}catch{message.value='请手动选择并复制内容';}}
let toastTimer:ReturnType<typeof setTimeout>|0=0,okTimer:ReturnType<typeof setTimeout>|0=0;
watch(error,v=>{if(v){clearTimeout(toastTimer);toastTimer=setTimeout(()=>{error.value='';},8000);}});
watch(message,v=>{if(v){clearTimeout(okTimer);okTimer=setTimeout(()=>{message.value='';},6000);}});
function clearAuthenticationInputs(){Object.assign(auth,{username:'',password:'',confirmPassword:'',inviteCode:'',bootstrapToken:'',recoveryCode:'',mode:'login'});Object.assign(passwordForm,{current:'',next:'',confirm:''});}
function clearCookieFields(){Object.assign(cookieFields,{paste:'',BDUSS:'',STOKEN:'',SESSDATA:'',bili_jct:'',DedeUserID:'',extra:''});}
function cancelChannelEdit(){editingChannel.value='';Object.assign(channelForm,{type:'telegram',name:'',botToken:'',chatId:'',threadId:'',sendKey:'',url:'',signingSecret:''});Object.assign(channelAdvanced,{headers:'',clearSigningSecret:false});}
function clearSensitiveInputs(){clearAuthenticationInputs();clearCookieFields();cancelChannelEdit();recovery.value=[];newInviteCode.value='';inviteForm.code='';}
function resetPrivateState(){
 sessionGeneration++;sessionController.abort();sessionController=new AbortController();cancelQr();clearSensitiveInputs();
 logged.value=false;me.value={};modules.value=[];platforms.value=[];runs.value=[];channels.value=[];policies.value=[];
 dashboard.value={};adminStats.value={};users.value=[];invites.value=[];adminSettings.value={};
 activePlatform.value='';platformDetail.value=null;screen.value='dashboard';adminTab.value='stats';
 Object.assign(platformForm,{features:[],config:{},schedule:defaultSchedule(),inheritNotify:true,notify:defaultNotify()});Object.assign(policyForm,defaultNotify());
 accountLabel.value='';editingAccountId.value='';restoreAccount.value=true;selectedUser.value=null;selectedRun.value=null;
 history.value=[];passkeys.value=[];sessions.value=[];sessionId.value='';auditRows.value=[];reviewRuns.value=[];resolution.value=null;
 Object.assign(resolveForm,{outcome:'failed',evidence:'',confirmNoRepeat:false});
 runCursor.value=null;historyCursor.value=null;runIdCursor.value='';historyIdCursor.value='';
 usersPage.value=0;invitesPage.value=0;auditPage.value=0;reviewPage.value=0;reviewHasNext.value=false;
 message.value='';error.value='';
 Object.assign(inviteForm,{label:'',code:'',max_uses:1,expires_in_days:30});
 Object.assign(quotaForm,{max_accounts:5,max_jobs:10,max_manual_runs:5,max_auto_runs:10,max_notifications:20,max_channels:5});
}
async function checkSession(){ready.value=false;try{
 try{const result=await api('/api/v1/me');if(me.value.id&&me.value.id!==result.user.id)resetPrivateState();me.value={...result.user,quotas:result.quotas};logged.value=true;setup.value=false;}
 catch(e:any){if(e.status!==401)throw e;resetPrivateState();const v=await api('/api/v1/auth/setup-status');setup.value=v.needsSetup;}
 if(logged.value){await refresh();const id=new URL(location.href).searchParams.get('run');if(id){screen.value='runs';await showRun(id);}}
 }finally{ready.value=true;}}
async function finishAuthentication(codes:string[]=[]){resetPrivateState();recovery.value=[...codes];await checkSession();}
async function registerPassword(){
 if(auth.password!==auth.confirmPassword)throw new Error('两次输入的密码不一致');
 const result=await api('/api/v1/auth/register/password','POST',{username:auth.username,password:auth.password,inviteCode:auth.inviteCode,bootstrapToken:auth.bootstrapToken});
 await finishAuthentication(result.recoveryCodes||[]);message.value='注册成功。请立即保存一次性恢复码。';
}
async function loginPassword(){await api('/api/v1/auth/login/password','POST',{username:auth.username,password:auth.password});await finishAuthentication();}
async function changePassword(){
 if(passwordForm.next!==passwordForm.confirm)throw new Error('两次输入的新密码不一致');
 const recoveryReset=me.value.recovery_password_reset_allowed===true;
 await api('/api/v1/auth/password','POST',{newPassword:passwordForm.next,...(recoveryReset?{recoveryReset:true}:{currentPassword:passwordForm.current})});
 Object.assign(passwordForm,{current:'',next:'',confirm:''});me.value.has_password=true;me.value.recovery_password_reset_allowed=false;me.value.recovery_password_reset_expires_at=null;
 message.value='密码已更新，其他会话已退出登录';await refreshSecurity();
}
async function loginPasskey(){const opts=await api('/api/v1/auth/login/options','POST',{username:auth.username});const att=await startAuthentication({optionsJSON:opts.options});await api('/api/v1/auth/login/verify','POST',{challengeId:opts.challengeId,response:att});await finishAuthentication();}
async function loginRecovery(){await api('/api/v1/auth/recover','POST',{username:auth.username,code:auth.recoveryCode});await finishAuthentication();screen.value='profile';await refreshSecurity();message.value='恢复登录成功，请在授权到期前设置新密码。该恢复码已失效。';}
async function addPasskey(){const o=await api('/api/v1/auth/passkey/options','POST',{});const att=await startRegistration({optionsJSON:o.options});await api('/api/v1/auth/passkey/verify','POST',{challengeId:o.challengeId,response:att});await refreshSecurity();message.value='新 Passkey 添加成功';}
async function logout(){
 cancelQr();
 try{await api('/api/v1/auth/logout','POST',{});}catch(e){clearSensitiveInputs();throw new Error('退出登录尚未完成，请检查网络后重试。');}
 resetPrivateState();await checkSession();
}
async function refresh(){if(!logged.value)return;
 const [m,p,r,c,pol,d]=await Promise.all([api('/api/v1/modules'),api('/api/v1/platforms'),api('/api/v1/runs'),api('/api/v1/notification-channels'),api('/api/v1/notification-policies'),api('/api/v1/dashboard')]);
 modules.value=m.modules;platforms.value=p.items;runs.value=r.items;runCursor.value=r.next_before;runIdCursor.value=r.next_id||'';channels.value=c.items;policies.value=pol.items;dashboard.value=d;loadPolicy();
 if(activePlatform.value&&screen.value==='platform:'+activePlatform.value)await loadPlatform(activePlatform.value,false);
 if(me.value.role==='admin')await refreshAdmin();
}
async function refreshAdmin(){const [s,u,i,g]=await Promise.all([api('/api/v1/admin/stats'),api(`/api/v1/admin/users?page=${usersPage.value}`),api(`/api/v1/admin/invites?page=${invitesPage.value}`),api('/api/v1/admin/settings')]);adminStats.value=s;users.value=u.items;invites.value=i.items;adminSettings.value={...g,webhook_allowed_hosts_input:(g.webhook_allowed_hosts||[]).join('\n')};}
async function refreshSecurity(){const [p,s]=await Promise.all([api('/api/v1/auth/passkeys'),api('/api/v1/auth/sessions')]);passkeys.value=p.items;sessions.value=s.items;sessionId.value=s.currentSession;}
function applyGroup(group:AnyRecord){const raw=group.schedule||{};const schedule={type:['daily','weekly','monthly','cron'].includes(raw.type)?raw.type:'daily',hour:Number.isInteger(raw.hour)?raw.hour:9,minute:Number.isInteger(raw.minute)?raw.minute:0,weekdays:Array.isArray(raw.weekdays)&&raw.weekdays.length?[...raw.weekdays]:[1,2,3,4,5],days:Array.isArray(raw.days)&&raw.days.length?[...raw.days]:[1],expression:typeof raw.expression==='string'&&raw.expression?raw.expression:'0 9 * * *'};
 platformForm.features=[...(group.features||[])];platformForm.config={...(group.config||{})};platformForm.schedule=schedule;platformForm.inheritNotify=group.notify==null||group.notify_inherited===true;
 platformForm.notify={success_enabled:group.notify?.success_enabled!==false,exception_enabled:group.notify?.exception_enabled!==false,success_channels:[...(group.notify?.success_channels||[])],error_mode:group.notify?.error_mode||'same',exception_channels:[...(group.notify?.exception_channels||[])]};}
async function loadPlatform(module:string,applyForm=true){const d=await api(`/api/v1/platforms/${module}`);if(activePlatform.value!==module)return;platformDetail.value=d;if(applyForm)applyGroup(d.group);}
async function openPlatform(module:string){cancelQr();cancelAccountEdit();platformDetail.value=null;activePlatform.value=module;screen.value='platform:'+module;await loadPlatform(module,true);}
async function savePlatform(){
 const module=activePlatform.value,detail=platformDetail.value;if(!module||!detail)return;
 const addingExchange=platformForm.features.includes('bili.exchange')&&!(detail.group?.features||[]).includes('bili.exchange');
 let riskAccepted=false;if(addingExchange){riskAccepted=window.confirm('B站电池兑换会实际消耗你的 B 币券，且属于不可逆操作。确定开启？');if(!riskAccepted)return;}
 const s=platformForm.schedule;
 const schedule=s.type==='cron'?{type:'cron',expression:String(s.expression||'').trim()}:{type:s.type,hour:Number(s.hour),minute:Number(s.minute),...(s.type==='weekly'?{weekdays:s.weekdays.map(Number)}:s.type==='monthly'?{days:s.days.map(Number)}:{})};
 await api(`/api/v1/platforms/${module}`,'PUT',{features:platformForm.features,schedule,config:platformForm.config,notify:platformForm.inheritNotify?null:platformForm.notify,riskAccepted});
 await refresh();await loadPlatform(module,true);message.value='平台设置已保存，账号任务已同步';
}
function featureTitles(p:AnyRecord){const map:AnyRecord=Object.fromEntries((p.module.tasks||[]).map((t:AnyRecord)=>[t.key,t.title]));return (p.group.features||[]).map((k:string)=>map[k]||k);}
function cookieValue(){const f=cookieFields;const pairs:[string,string][]=activePlatform.value==='baidu-netdisk'?[['BDUSS',f.BDUSS],['STOKEN',f.STOKEN]]:[['SESSDATA',f.SESSDATA],['bili_jct',f.bili_jct],['DedeUserID',f.DedeUserID]];
 const parts=pairs.filter(([,v])=>String(v).trim()).map(([k,v])=>`${k}=${String(v).trim()}`);const extra=String(f.extra).trim().replace(/^;+\s*|\s*;+$/g,'');if(extra)parts.push(extra);return parts.join('; ');}
function splitCookie(){const raw=String(cookieFields.paste).trim().replace(/^cookie:\s*/i,'');if(!raw)return;clearCookieFields();const extra:string[]=[];for(const part of raw.split(/;\s*/)){const i=part.indexOf('=');if(i<=0)continue;const k=part.slice(0,i).trim(),v=part.slice(i+1).trim(),key=k.toLowerCase();if(key==='bduss')cookieFields.BDUSS=v;else if(key==='stoken')cookieFields.STOKEN=v;else if(key==='sessdata')cookieFields.SESSDATA=v;else if(key==='bili_jct')cookieFields.bili_jct=v;else if(key==='dedeuserid')cookieFields.DedeUserID=v;else if(k)extra.push(k+'='+v);}cookieFields.extra=extra.join('; ');message.value='已按字段拆分，请核对后保存';}
function editPlatformAccount(a:AnyRecord){cancelQr();clearCookieFields();editingAccountId.value=a.id;accountLabel.value=a.label;restoreAccount.value=platformDetail.value?.module.enabled!==false;}
function cancelAccountEdit(){cancelQr();editingAccountId.value='';accountLabel.value='';restoreAccount.value=true;clearCookieFields();}
function confirmResume(){return !(platformDetail.value?.group?.features||[]).includes('bili.exchange')||window.confirm('恢复后，平台已开启的 B 币券兑换也会按计划运行并消耗额度。确定恢复？');}
async function addPlatformAccount(){
 const module=activePlatform.value,cookie=cookieValue(),id=editingAccountId.value;
 if(!cookie&&!id)throw new Error('请填写 Cookie 字段，或先粘贴完整 Cookie 并拆分');
 if(cookie&&module==='baidu-netdisk'&&(!cookieFields.BDUSS.trim()||!cookieFields.STOKEN.trim()))throw new Error('百度网盘 Cookie 需要完整的 BDUSS 和 STOKEN');
 if(cookie&&module==='bilibili-vip'&&(!cookieFields.SESSDATA.trim()||!cookieFields.bili_jct.trim()))throw new Error('B站 Cookie 需要完整的 SESSDATA 和 bili_jct');
 const resume=!!id&&restoreAccount.value&&platformDetail.value?.module.enabled!==false;if(resume&&!confirmResume())return;
 const body:AnyRecord={label:accountLabel.value.trim()||(module==='baidu-netdisk'?'百度网盘账号':'B站账号'),...(cookie?{credentials:{cookie}}:{}),...(resume?{enabled:true,resumeJobs:true}:{})};
 await api(`/api/v1/platforms/${module}/accounts${id?'/'+id:''}`,id?'PATCH':'POST',body);
 cancelAccountEdit();await refresh();message.value=id?'账号已更新，原有记录已保留':'账号已添加，凭据已加密且不会回显';
}
async function togglePlatformAccount(a:AnyRecord){if(!a.enabled&&!confirmResume())return;await api(`/api/v1/platforms/${activePlatform.value}/accounts/${a.id}`,'PATCH',{enabled:!a.enabled,...(!a.enabled?{resumeJobs:true}:{})});await refresh();}
async function deletePlatformAccount(a:AnyRecord){if(!window.confirm(`删除账号「${a.label}」及关联的运行记录？未结清的操作会阻止删除。`))return;await api(`/api/v1/platforms/${activePlatform.value}/accounts/${a.id}`,'DELETE');if(editingAccountId.value===a.id)cancelAccountEdit();await refresh();}
async function probePlatformAccount(a:AnyRecord){const r=await api(`/api/v1/platforms/${activePlatform.value}/accounts/${a.id}/probe`,'POST',{});message.value='只读检查结果：'+JSON.stringify(r.result).slice(0,1100);}
async function runPlatform(accountId?:string){const detail=platformDetail.value;if(!detail)return;
 const hasExchange=(detail.jobs||[]).some((j:AnyRecord)=>j.enabled&&j.task_key==='bili.exchange'&&(!accountId||j.account_id===accountId));
 let riskAccepted=false;if(hasExchange){riskAccepted=window.confirm('这次执行包含 B 币券兑换，会实际消耗兑换额度。确定继续？');if(!riskAccepted)return;}
 const body:AnyRecord={riskAccepted};if(accountId)body.account_id=accountId;
 const r=await api(`/api/v1/platforms/${activePlatform.value}/run`,'POST',body,{'Idempotency-Key':crypto.randomUUID()});
 await refresh();message.value=`已加入执行队列（${r.queued} 个任务），请到运行记录查看结果`;}
function stopQr(){qrGeneration++;if(qr.timer)clearTimeout(qr.timer);if(qrDeadlineTimer)clearTimeout(qrDeadlineTimer);qr.timer=0;qrDeadlineTimer=0;qrController?.abort();qrController=null;qr.busy=false;}
function cancelQr(){stopQr();Object.assign(qr,{id:'',image:'',authUrl:'',status:'',expiresAt:0,accountId:'',resumeJobs:false,label:''});}
function qrActive(generation:number){return generation===qrGeneration&&logged.value&&screen.value==='platform:baidu-netdisk'&&activePlatform.value==='baidu-netdisk';}
function scheduleQr(generation:number,delay=3000){if(!qrActive(generation)||!qr.id)return;qr.timer=setTimeout(()=>{qr.timer=0;void pollQr(generation);},delay);}
function expireQr(){cancelQr();qr.status='二维码已过期，请重新生成。';}
async function startQr(){
 if(qr.busy||activePlatform.value!=='baidu-netdisk'||platformDetail.value?.module.enabled===false)return;
 const resume=!!editingAccountId.value&&restoreAccount.value;if(resume&&!confirmResume())return;
 cancelQr();const generation=qrGeneration;qrController=new AbortController();qr.busy=true;error.value='';
 qr.accountId=editingAccountId.value;qr.resumeJobs=resume;qr.label=accountLabel.value.trim()||'百度网盘账号';
 try{const r=await api('/api/v1/platforms/baidu-netdisk/qr/start','POST',{...(qr.accountId?{accountId:qr.accountId,resumeJobs:resume}:{})},{},qrController.signal);
  if(!qrActive(generation))return;const expires=Number(r.expires_at)||Date.now()+180000;
  Object.assign(qr,{id:r.id,image:r.qr,authUrl:r.auth_url||'',expiresAt:expires,status:'请使用手机百度或百度网盘 App 扫码'});
  qrDeadlineTimer=setTimeout(()=>{if(qrActive(generation))expireQr();},Math.max(0,expires-Date.now()));scheduleQr(generation);
 }catch(e:any){if(qrActive(generation)&&e?.name!=='AbortError'){cancelQr();error.value=e?.message||'二维码创建失败，请重试';}}
 finally{if(generation===qrGeneration)qr.busy=false;}
}
async function pollQr(generation=qrGeneration){
 if(!qrActive(generation)||!qr.id||qr.busy)return;if(Date.now()>=qr.expiresAt){expireQr();return;}
 qr.busy=true;let again=true,delay=3000;const id=qr.id;
 try{const r=await api(`/api/v1/platforms/baidu-netdisk/qr/${id}/poll`,'POST',{label:qr.label},{},qrController?.signal);
  if(!qrActive(generation)||id!==qr.id)return;
  const retryAfter=Number(r.retry_after_ms);if(Number.isFinite(retryAfter))delay=Math.max(3000,retryAfter);
  if(r.status==='confirmed'){
   if(!r.account_id)throw new Error('登录服务未确认账号绑定，请重新扫码');
   const wasEdit=!!qr.accountId;cancelAccountEdit();again=false;await refresh();message.value=wasEdit?'扫码更新成功，原有账号记录已保留':'扫码添加成功，账号凭据已加密保存';return;
  }
  if(r.status==='failed'){again=false;cancelQr();error.value=r.message||'扫码绑定失败，请重新扫码';return;}
  qr.status=r.status==='scanned'?'已扫码，请在手机上确认登录':r.status==='processing'?'正在验证并保存账号，请稍候…':'等待扫码，请在手机上确认登录';
 }catch(e:any){if(!qrActive(generation)||e?.name==='AbortError')return;
  if(e?.code==='QR_POLL_LIMIT'||[401,403,404,409,410,422,503].includes(Number(e?.status))||(!e?.status&&e?.message==='登录服务未确认账号绑定，请重新扫码')){again=false;cancelQr();error.value=e?.message||'二维码已失效，请重新生成';return;}
  delay=Math.max(Number(e?.status)===429?5000:3000,Number(e?.retryAfterMs)||0);qr.status='暂时无法完成检查，稍后重试…';
 }finally{if(generation===qrGeneration){qr.busy=false;if(again)scheduleQr(generation,delay);}}
}
async function showRun(id:string){const r=await api(`/api/v1/runs/${id}`);selectedRun.value={...r.run,steps:r.steps};}
function editChannel(n:AnyRecord){cancelChannelEdit();editingChannel.value=n.id;const config=n.editable_config||{};Object.assign(channelForm,{type:n.type,name:n.name,chatId:String(config.chatId||''),threadId:String(config.threadId||'')});}
async function toggleChannel(n:AnyRecord){await api(`/api/v1/notification-channels/${n.id}`,'PATCH',{enabled:!n.enabled});await refresh();}
async function createChannel(){
 const patch:AnyRecord={};
 if(channelForm.type==='telegram'){if(channelForm.botToken.trim())patch.botToken=channelForm.botToken.trim();if(channelForm.chatId.trim())patch.chatId=channelForm.chatId.trim();patch.threadId=channelForm.threadId.trim();}
 else if(channelForm.type==='serverchan'){if(channelForm.sendKey.trim())patch.sendKey=channelForm.sendKey.trim();}
 else{if(channelForm.url.trim())patch.url=channelForm.url.trim();if(channelForm.signingSecret)patch.signingSecret=channelForm.signingSecret;else if(channelAdvanced.clearSigningSecret)patch.signingSecret='';if(channelAdvanced.headers.trim())patch.headers=JSON.parse(channelAdvanced.headers);}
 if(editingChannel.value)await api(`/api/v1/notification-channels/${editingChannel.value}`,'PATCH',{name:channelForm.name,configPatch:patch});
 else await api('/api/v1/notification-channels','POST',{type:channelForm.type,name:channelForm.name,config:patch});
 cancelChannelEdit();await refresh();message.value='通知渠道已保存';
}
function loadPolicy(){const p=policies.value.find((x:AnyRecord)=>x.scope_type==='user'&&x.scope_id===me.value.id);Object.assign(policyForm,{success_enabled:p?.success_enabled??true,exception_enabled:p?.exception_enabled??true,success_channels:p?.success_channels||[],error_mode:p?.error_mode||'same',exception_channels:p?.exception_channels||[]});}
async function savePolicy(){await api('/api/v1/notification-policies','PUT',{scope_type:'user',scope_id:me.value.id,...policyForm});await refresh();message.value='默认通知规则已保存';}
async function inheritPolicy(){await api(`/api/v1/notification-policies/user/${me.value.id}`,'DELETE');await refresh();message.value='已恢复默认规则';}
async function testChannel(id:string){await api(`/api/v1/notification-channels/${id}/test`,'POST',{});message.value='测试消息已提交到目标渠道';}
async function removeChannel(id:string){if(window.confirm('删除该通知渠道？')){await api(`/api/v1/notification-channels/${id}`,'DELETE');if(editingChannel.value===id)cancelChannelEdit();await refresh();}}
async function createInvite(){const r=await api('/api/v1/admin/invites','POST',{...inviteForm,code:inviteForm.code.trim()||undefined});newInviteCode.value=r.code;inviteForm.code='';await refreshAdmin();}
async function resetUserPassword(id:string){const p=prompt('输入新的登录密码，该用户现有会话将被退出');if(!p)return;await api(`/api/v1/admin/users/${id}/password`,'POST',{password:p});message.value='用户密码已重置';}
async function patchInvite(i:AnyRecord,fields:AnyRecord){await api(`/api/v1/admin/invites/${i.id}`,'PATCH',fields);await refreshAdmin();}
async function toggleUser(u:AnyRecord){await api(`/api/v1/admin/users/${u.id}/status`,'POST',{status:u.status==='active'?'suspended':'active'});await refreshAdmin();}
async function saveAdmin(){await api('/api/v1/admin/settings','PUT',{modules_enabled:adminSettings.value.modules_enabled,bili_exchange_allowed:adminSettings.value.bili_exchange_allowed,max_users:Number(adminSettings.value.max_users),webhook_allowed_hosts:String(adminSettings.value.webhook_allowed_hosts_input??'').split(/[\n,]/).map(x=>x.trim()).filter(Boolean),maintenance:adminSettings.value.maintenance,global_quotas:adminSettings.value.global_quotas,platform_budget:adminSettings.value.platform_budget,max_invites:adminSettings.value.max_invites});await refreshAdmin();message.value='系统配置已保存';}
async function saveQuota(){if(!selectedUser.value)return;await api(`/api/v1/admin/quotas/${selectedUser.value}`,'PUT',quotaForm);message.value='用户配额已保存';}
async function chooseUserQuota(id:string){selectedUser.value=id;Object.assign(quotaForm,(await api(`/api/v1/admin/quotas/${id}`)).effective);}
async function removePasskey(id:string){if(!confirm('删除这个 Passkey 吗？'))return;await api(`/api/v1/auth/passkeys/${id}`,'DELETE');await refreshSecurity();}
async function renamePasskey(k:AnyRecord){const name=prompt('Passkey 名称',k.name);if(name)await api(`/api/v1/auth/passkeys/${k.id}`,'PATCH',{name});await refreshSecurity();}
async function revokeSession(id:string){await api(`/api/v1/auth/sessions/${id}`,'DELETE');if(id===sessionId.value){resetPrivateState();await checkSession();}else await refreshSecurity();}
async function regenerateRecovery(){if(!confirm('这会让之前生成的所有恢复码全部失效，请立即保存新生成的恢复码。确定继续？'))return;recovery.value=(await api('/api/v1/auth/recovery-codes','POST',{confirm:true})).recoveryCodes;}
async function loadHistory(more=false){const url='/api/v1/notification-history'+(more&&historyCursor.value?`?before=${historyCursor.value}&after_id=${encodeURIComponent(historyIdCursor.value)}`:'');const r=await api(url);history.value=more?[...history.value,...r.items]:r.items;historyCursor.value=r.next_before;historyIdCursor.value=r.next_id||'';}
async function loadRuns(){if(!runCursor.value)return;const r=await api(`/api/v1/runs?before=${runCursor.value}&after_id=${encodeURIComponent(runIdCursor.value)}`);runs.value.push(...r.items);runCursor.value=r.next_before;runIdCursor.value=r.next_id||'';}
async function retryNotification(id:string){if(!confirm('只重试这一条通知？如果上次其实已送达，接收方可能收到重复消息。'))return;await api(`/api/v1/notification-history/${id}/retry`,'POST',{});await loadHistory();}
async function reconcileRun(id:string){await api(`/api/v1/runs/${id}/reconcile`,'POST',{});await showRun(id);await refresh();}
async function cancelRun(id:string){await api(`/api/v1/runs/${id}/cancel`,'POST',{});await refresh();}
async function deleteMe(){const name=prompt('将永久删除你的账号、凭据和历史记录。请输入你的用户名以确认：');if(name!==me.value.username)return;await api('/api/v1/me/delete','POST',{confirmUsername:name});resetPrivateState();await checkSession();}
async function pageUsers(delta:number){usersPage.value=Math.max(0,usersPage.value+delta);users.value=(await api(`/api/v1/admin/users?page=${usersPage.value}`)).items;}
async function pageInvites(delta:number){invitesPage.value=Math.max(0,invitesPage.value+delta);invites.value=(await api(`/api/v1/admin/invites?page=${invitesPage.value}`)).items;}
async function editInviteExpiry(i:AnyRecord){const value=prompt('到期时间（ISO 日期/时间），或输入 NEVER 表示永不过期',i.expires_at?new Date(i.expires_at).toISOString():'NEVER');if(value===null)return;const expires_at=value==='NEVER'?null:Date.parse(value);if(expires_at!==null&&!Number.isFinite(expires_at))throw new Error('日期格式无效');await patchInvite(i,{expires_at});}
function inviteState(i:AnyRecord){return !i.enabled?'已停用':i.used_count>=i.max_uses?'已用尽':i.expires_at&&i.expires_at<=Date.now()?'已过期':'有效';}
const STATUS_TEXT:AnyRecord={scheduled:'已排期',queued:'已排队',running:'执行中',succeeded:'成功',already_done:'无需执行',failed:'失败',waiting_retry:'等待重试',waiting_verification:'待人工确认',canceled:'已取消',pending:'待发送',sending:'发送中',delivered:'已送达',retry:'待重试',disabled:'已停用',dead:'已失效',done:'已完成',active:'正常',suspended:'已冻结'};
function statusText(s:string){return STATUS_TEXT[s]||s;}
const KIND_TEXT:AnyRecord={run:'执行',notification:'通知',dispatch:'派发',maintenance:'清理'};
function kindText(k:string){return KIND_TEXT[k]||k;}
async function pageAudit(delta:number){auditPage.value=Math.max(0,auditPage.value+delta);auditRows.value=(await api(`/api/v1/admin/audit?page=${auditPage.value}`)).items;}
async function pageReview(delta=0){const page=Math.max(0,reviewPage.value+delta);const r=await api(`/api/v1/admin/runs?status=waiting_verification&page=${page}`);reviewPage.value=page;reviewRuns.value=r.items;reviewHasNext.value=r.next_page!=null;}
function openResolution(row:AnyRecord){resolution.value=row;Object.assign(resolveForm,{outcome:'failed',evidence:'',confirmNoRepeat:false});}
async function resolveRun(){if(!resolution.value)return;const evidence=resolveForm.evidence.trim();if(evidence.length<20||evidence.length>2000||!resolveForm.confirmNoRepeat)throw new Error('请填写20–2000字的实际核对证据，并确认后续任务行为');
 await api(`/api/v1/admin/runs/${resolution.value.id}/resolve`,'POST',{outcome:resolveForm.outcome,evidence,confirmNoRepeat:true});resolution.value=null;Object.assign(resolveForm,{outcome:'failed',evidence:'',confirmNoRepeat:false});await pageReview();message.value='人工核对结果已记录，原任务未重新发送';}
async function cleanupLogs(){if(!confirm('按保留策略清理已完成的旧记录？未结任务、资产证据和安全审计仍受保留规则保护。'))return;await api('/api/v1/admin/maintenance/cleanup','POST',{beforeDays:90,confirm:true});await refreshAdmin();message.value='已按保留策略执行一轮安全清理';}
watch(adminTab,name=>{if(!logged.value||me.value.role!=='admin')return;const operation=name==='audit'?()=>pageAudit(0):name==='review'?()=>pageReview(0):null;if(operation)void operation().catch(e=>{if(e?.name!=='AbortError')error.value=e.message;});});
watch(screen,name=>{
 if(name!=='platform:baidu-netdisk')cancelQr();if(!logged.value)return;
 const operation=name==='notifications'?()=>loadHistory():name==='profile'?refreshSecurity:null;
 if(operation)void operation().catch(e=>{if(e?.name!=='AbortError')error.value=e.message;});
});
watch(selectedRun,async value=>{await nextTick();if(value&&!runDialog.value?.open)runDialog.value?.showModal();else if(!value)runDialog.value?.close();});
watch(resolution,async value=>{await nextTick();if(value&&!resolveDialog.value?.open)resolveDialog.value?.showModal();else if(!value)resolveDialog.value?.close();});
onMounted(()=>act(checkSession));
onBeforeUnmount(()=>{cancelQr();sessionController.abort();clearTimeout(toastTimer);clearTimeout(okTimer);});
</script>


<template>
  <div v-if="!ready" class="loading"><div class="spinner"></div><p>正在加载任务中心…</p></div>
  <div v-else-if="!logged" class="auth-page">
    <div class="auth-hero"><div class="logo-large">TH</div><div class="overline">CLOUDFLARE 任务中心</div><h1>把自动任务交给云端。<br><span>按平台管理，所有账号一起安排。</span></h1><p>百度网盘签到、B站会员权益、独立任务计划、加密存储与多渠道通知。</p><div class="auth-marks"><span>● 账号密码登录</span><span>● 邀请码注册</span><span>● Passkey 可选</span></div></div>
    <section class="auth-card">
      <div class="eyebrow">{{setup?'首次安装向导':'欢迎使用'}}</div>
      <h2>{{setup?'创建唯一管理员':auth.mode==='login'?'登录你的任务空间':auth.mode==='register'?'通过邀请码注册':auth.mode==='recover'?'使用恢复码':'使用通行密钥登录'}}</h2>
      <p class="muted">{{setup?'设置用户名与登录密码，并填入 Cloudflare Secret 中的管理员初始化口令。':'默认使用账号密码登录。通行密钥为可选项，登录后可在个人设置中开启。'}}</p>
      <form @submit.prevent="act(setup||auth.mode==='register'?registerPassword:auth.mode==='recover'?loginRecovery:auth.mode==='passkey'?loginPasskey:loginPassword)" class="form">
        <label>用户名 <input v-model="auth.username" autocomplete="username" placeholder="例如 alex_01" required /></label>
        <label v-if="setup">管理员初始化口令 <input v-model="auth.bootstrapToken" type="password" placeholder="BOOTSTRAP_TOKEN" required /></label>
        <label v-if="!setup&&auth.mode==='login'">密码 <input v-model="auth.password" type="password" autocomplete="current-password" required /></label>
        <label v-if="!setup&&auth.mode==='register'">邀请码 <input v-model="auth.inviteCode" placeholder="由管理员提供" required /></label>
        <template v-if="setup||auth.mode==='register'">
          <label>密码<input v-model="auth.password" type="password" autocomplete="new-password" required /></label><label>确认密码 <input v-model="auth.confirmPassword" type="password" autocomplete="new-password" required /></label>
        </template>
        <label v-if="!setup&&auth.mode==='recover'">一次性恢复码 <input v-model="auth.recoveryCode" placeholder="保存的恢复码" required /></label>
        <button class="primary full" :disabled="busy">{{busy?'操作中…':setup?'创建管理员':auth.mode==='login'?'登录':auth.mode==='register'?'注册':auth.mode==='recover'?'通过恢复码登录':'使用通行密钥登录'}}</button>
      </form>
      <div v-if="!setup" class="auth-switch"><button @click="auth.mode='login'">密码登录</button><button @click="auth.mode='register'">邀请码注册</button><button @click="auth.mode='passkey'">通行密钥登录</button><button @click="auth.mode='recover'">恢复账号</button></div>
      <div v-if="error" class="alert error">{{error}}</div>
    </section>
  </div>
  <div v-else class="layout">
    <aside class="sidebar">
      <div class="brand"><div class="brand-mark">TH</div><div><strong>CF Task Hub</strong><small>控制中心 · v{{appVersion}}</small></div></div>
      <div class="nav-label">工作空间</div>
      <nav><button v-for="item in nav" :key="item.id" :class="['navitem',screen===item.id?'active':'']" @click="item.id.startsWith('platform:')?act(()=>openPlatform(item.id.slice(9))):screen=item.id"><span class="nav-icon">{{item.icon}}</span>{{item.title}}</button></nav>
      <template v-if="me.role==='admin'"><div class="nav-label">平台管理</div><nav><button :class="['navitem',screen==='admin'?'active':'']" @click="screen='admin'"><span class="nav-icon">▦</span>管理员后台</button></nav></template>
      <div class="sidebar-bottom"><div class="avatar">{{me.username?.slice(0,1).toUpperCase()}}</div><div class="account-info"><strong>{{me.username}}</strong><small>{{me.role==='admin'?'平台管理员':'普通用户'}}</small></div><button title="退出登录" @click="act(logout)">↪</button></div>
    </aside>
    <main class="main">
      <header class="topbar"><div><div class="crumb">CF 任务中心 / {{screen==='admin'?'管理员':screenTitle}}</div><h1>{{screen==='dashboard'?'任务概览':screen==='runs'?'运行记录':screen==='notifications'?'通知设置':screen==='admin'?'平台管理':screen==='profile'?'个人安全设置':screenTitle}}</h1></div><div class="top-actions"><span class="live-indicator">● 界面已连接</span><button class="button" @click="act(refresh)">↻ 刷新</button></div></header>
      <div class="toast-layer"><div v-if="error" class="toast error" @click="error=''"><span>{{error}}</span><span class="close">×</span></div><div v-if="message" class="toast ok" @click="message=''"><span>{{message}}</span><span class="close">×</span></div></div>
      <section v-if="recovery.length" class="card recovery"><h3>请立即保存恢复码</h3><p>这些恢复码只显示一次，每个仅能使用一次。建议离线保存。</p><div class="codes"><code v-for="code in recovery" :key="code">{{code}}</code></div><button class="button" @click="copyText(recovery.join('\n'))">复制恢复码</button><button class="button" @click="recovery=[]">我已妥善保存</button></section>

      <template v-if="screen==='dashboard'">
        <div class="stats-grid"><div class="stat-card"><small>已绑定账号</small><strong>{{totals.accounts}}</strong><span>跨平台统一管理</span></div><div class="stat-card"><small>已开启的任务</small><strong>{{totals.jobs}}</strong><span>每个账号独立执行</span></div><div class="stat-card"><small>近 24h 成功</small><strong class="success">{{dashboard.stats?.[2]||0}}</strong><span>已完成</span></div><div class="stat-card"><small>近 24h 异常</small><strong class="danger">{{dashboard.stats?.[3]||0}}</strong><span>需查看日志</span></div></div>
        <div class="section-head"><h2>按平台管理</h2><small class="muted">每个平台内可开启功能、添加多个账号、统一设置时间与通知渠道</small></div>
        <div class="list-grid"><div v-for="p in visiblePlatforms" :key="p.module.id" class="card account-card"><div class="account-title"><span class="module-icon">{{p.module.id==='baidu-netdisk'?'☁':'ⓑ'}}</span><div><strong>{{p.module.title}}</strong><small>{{p.stats.accounts}} 个账号 · {{p.stats.enabled_jobs}} 项已开启</small></div></div><p class="muted">已开启功能：{{featureTitles(p).join('、')||'未开启'}}</p><p class="muted">下次执行：{{p.stats.next_run_at?languageTime(p.stats.next_run_at):'未安排'}} · 近 24h 成功 {{p.stats.today_success}} / 异常 {{p.stats.today_error}}</p><div class="card-actions"><button class="primary" @click="act(()=>openPlatform(p.module.id))">进入平台</button><span v-if="!p.module.enabled" class="tag">管理员已关闭</span></div></div></div>
        <div class="section-head"><h2>最近运行</h2><button class="link" @click="screen='runs'">查看全部 →</button></div>
        <div class="card"><div v-if="!dashboard.recent?.length" class="empty">还没有运行记录。进入平台开启功能并添加账号后即可开始。</div><div v-for="r in dashboard.recent" :key="r.id" class="item-row"><div class="item-icon">◎</div><div class="item-body"><strong>{{r.account_label}} · {{r.task_key}}</strong><small>{{languageTime(r.created_at)}}</small></div><span :class="['status',r.status]">{{statusText(r.status)}}</span></div></div>
      </template>

      <template v-else-if="screen.startsWith('platform:')">
        <div v-if="!platformDetail" class="card empty">正在加载平台配置…</div>
        <template v-else>
          <div class="card"><div class="section-head"><h2>{{platformDetail.module.title}} · 功能开关</h2><span class="tag">{{platformDetail.accounts.length}} 个账号</span></div><p class="muted">在这里选择本平台要开启的功能。勾选后，下面所有已启用账号都会按下面的时间执行这些功能；取消勾选只会暂停定时执行，不会删除历史记录。</p><div class="checks"><label v-for="t in platformDetail.module.tasks" :key="t.key"><input type="checkbox" :value="t.key" v-model="platformForm.features"> {{t.title}}<span v-if="t.key==='bili.exchange'" class="tag">消耗 B 币券</span></label></div><small class="muted" v-if="!platformDetail.module.enabled">管理员已关闭该平台。仍可更新或删除已保存账号，开启功能和执行任务暂不可用。</small></div>

          <div class="card"><h2>执行时间</h2><p class="muted">同一平台下的所有账号共用这一套时间。保存后会立即同步到每个账号的每项功能。所有时间统一按北京时间（UTC+8）计算，不支持修改时区。</p><div class="form"><div class="three"><label>计划类型<select v-model="platformForm.schedule.type"><option value="daily">每天</option><option value="weekly">每周指定日期</option><option value="monthly">每月指定日期</option><option value="cron">Cron 表达式</option></select></label><template v-if="platformForm.schedule.type!=='cron'"><label>小时（0–23）<input type="number" min="0" max="23" v-model.number="platformForm.schedule.hour"></label><label>分钟（0–59）<input type="number" min="0" max="59" v-model.number="platformForm.schedule.minute"></label></template></div><div v-if="platformForm.schedule.type==='weekly'" class="checks"><label v-for="(day,i) in ['周日','周一','周二','周三','周四','周五','周六']" :key="i"><input type="checkbox" :value="i" v-model="platformForm.schedule.weekdays"> {{day}}</label></div><label v-if="platformForm.schedule.type==='monthly'">每月执行日（1–31，可多选）<select multiple size="7" v-model="platformForm.schedule.days"><option v-for="n in 31" :key="n" :value="n">{{n}} 号</option></select><small>可多选（Ctrl / Cmd）；例如选择 1 号和 15 号，表示每月这两天执行。月份没有该日期时自动跳过。</small></label><template v-if="platformForm.schedule.type==='cron'"><label>Cron 表达式（分 时 日 月 周）<input v-model="platformForm.schedule.expression" placeholder="0 9 * * *"></label><small class="muted">按北京时间解析，例如 <code>0 9 * * *</code> 表示每天 09:00；<code>30 9 1,15 * *</code> 表示每月 1 号和 15 号 09:30；<code>*/30 * * * *</code> 表示每 30 分钟。系统每 5 分钟检查一次到期任务。</small></template><small v-else class="muted">时间按北京时间计算；系统每 5 分钟检查一次到期任务。</small></div></div>

          <div class="card"><h2>通知渠道</h2><p class="muted">默认使用「通知设置」中的用户规则。需要平台独立通知时再选择自定义，渠道须先创建。</p><div class="form"><label>通知规则<select v-model="platformForm.inheritNotify"><option :value="true">继承用户默认规则</option><option :value="false">使用本平台独立规则</option></select></label><p v-if="platformForm.inheritNotify" class="info">本平台将随用户默认规则更新。可在「通知设置」中选择渠道。</p><fieldset v-else class="form policy-fields"><div class="two"><label class="switch-label"><input type="checkbox" v-model="platformForm.notify.success_enabled"> 成功时通知</label><label class="switch-label"><input type="checkbox" v-model="platformForm.notify.exception_enabled"> 异常时通知</label></div><label>成功通知渠道<select multiple size="3" v-model="platformForm.notify.success_channels"><option v-for="n in channels" :key="n.id" :value="n.id">{{n.name}} · {{n.type}}</option></select><small>可多选（Ctrl / Cmd）；未选择时不会发送成功通知</small></label><label>异常通知渠道<select v-model="platformForm.notify.error_mode"><option value="same">与成功通知共用渠道</option><option value="custom">单独指定异常渠道</option></select></label><label v-if="platformForm.notify.error_mode==='custom'">异常渠道<select multiple size="3" v-model="platformForm.notify.exception_channels"><option v-for="n in channels" :key="n.id" :value="n.id">{{n.name}} · {{n.type}}</option></select></label></fieldset></div></div>

          <div class="card"><h2>平台功能配置</h2><p class="muted">这些设置会应用到本平台下的所有账号，例如超时、重试间隔和签到开关。</p><div class="form"><template v-for="f in platformDetail.module.configSchema||[]" :key="f.key"><label v-if="f.type==='boolean'" class="switch-label"><input type="checkbox" v-model="platformForm.config[f.key]"> {{f.title}}</label><label v-else>{{f.title}}<input type="number" :min="f.min" :max="f.max" v-model.number="platformForm.config[f.key]"></label></template></div></div>

          <div class="card-actions" style="margin-bottom:19px"><button class="primary" :disabled="busy||!platformDetail.module.enabled" @click="act(savePlatform)">保存平台设置</button><button class="button" :disabled="busy||!platformDetail.module.enabled" @click="act(()=>runPlatform())">立即执行全部账号</button></div>

          <div class="section-head"><h2>账号</h2><small class="muted">同一平台可添加多个账号，它们共用上面的功能、时间和通知配置</small></div>
          <div class="card"><div v-if="!platformDetail.accounts.length" class="empty">还没有添加账号。可以直接导入 Cookie，百度网盘也支持扫码添加。</div><div v-for="a in platformDetail.accounts" :key="a.id" class="item-row"><div class="item-icon">{{platformDetail.module.id==='baidu-netdisk'?'☁':'ⓑ'}}</div><div class="item-body"><strong>{{a.label}}</strong><small>{{a.identity_verified_at?'已完成身份校验':'待校验'}} · 添加于 {{languageTime(a.created_at)}}</small></div><span :class="['status',a.enabled?'succeeded':'muted-status']">{{a.enabled?'已启用':'已暂停'}}</span><button class="button small" @click="editPlatformAccount(a)">更新登录态 / 别名</button><button class="button small" :disabled="!platformDetail.module.enabled" @click="act(()=>probePlatformAccount(a))">只读检查</button><button class="button small" :disabled="!platformDetail.module.enabled" @click="act(()=>runPlatform(a.id))">运行一次</button><button class="button small" :disabled="!a.enabled&&!platformDetail.module.enabled" @click="act(()=>togglePlatformAccount(a))">{{a.enabled?'暂停':'恢复账号与任务'}}</button><button class="button small danger-text" @click="act(()=>deletePlatformAccount(a))">删除</button></div></div>

          <div class="card form-card"><div class="section-head"><h2>{{editingAccountId?'更新已有账号':'添加账号'}}</h2><button v-if="editingAccountId" class="button small" @click="cancelAccountEdit">取消编辑</button></div><p v-if="editingAccountId" class="info">更新会保留运行记录，只接受同一个上游账号的登录态。只改别名时可将 Cookie 全部留空。</p><div class="form"><label>账号别名<input v-model="accountLabel" placeholder="例如：我的主账号"></label>
            <div v-if="platformDetail.module.id==='baidu-netdisk'"><div class="info">扫码登录：点击下方按钮生成百度网盘登录二维码，用手机百度或百度网盘 App 扫码，并在手机上点“确认登录”。二维码 3 分钟内有效，过期后请重新生成。</div><div class="card-actions"><button type="button" class="button" :disabled="qr.busy||!!qr.id||!platformDetail.module.enabled" @click="startQr">{{editingAccountId?'扫码更新这个账号':'生成扫码二维码'}}</button><button v-if="qr.id||qr.busy" type="button" class="button" @click="cancelQr">取消扫码</button></div><div v-if="qr.image" style="text-align:center"><div style="display:inline-block;background:#fff;padding:10px;border-radius:12px;margin:12px 0"><img :src="qr.image" alt="百度网盘登录二维码" style="display:block;width:245px;height:245px"></div><p class="muted">{{qr.status}}</p><p v-if="qr.authUrl" class="muted">如果手机就在当前设备上，无法自己扫自己，可直接<a :href="qr.authUrl" target="_blank" rel="noopener">在手机浏览器打开登录页</a>，登录后本页面会自动完成绑定。</p></div><p v-else-if="qr.status" class="muted">{{qr.status}}</p></div>
            <small class="muted">也可以手动导入 Cookie：浏览器登录对应网站后按 F12 → Application（应用/存储）→ Cookies，只复制字段“值”，不要带“字段名=”。也可以粘贴整段 Cookie 后点“拆分到字段”。保存后不会回显。</small>
            <label>快速粘贴完整 Cookie（可选）<input type="password" v-model="cookieFields.paste" autocomplete="off" placeholder="BDUSS=...; STOKEN=...; ..."></label><button type="button" class="button" @click="splitCookie">拆分到字段</button>
            <template v-if="platformDetail.module.id==='baidu-netdisk'"><div class="two"><label>BDUSS（必填）<input type="password" v-model="cookieFields.BDUSS" autocomplete="off" placeholder="百度登录态主字段，用于身份校验与成长值查询"></label><label>STOKEN（必填）<input type="password" v-model="cookieFields.STOKEN" autocomplete="off" placeholder="网盘登录票据，PC 签到必需"></label></div><label>其他 Cookie（可选）<input type="password" v-model="cookieFields.extra" autocomplete="off" placeholder="例如 BAIDUCUID=xxx; PANWEB=1; PTOKEN=xxx"></label></template>
            <template v-else><div class="two"><label>SESSDATA（必填）<input type="password" v-model="cookieFields.SESSDATA" autocomplete="off" placeholder="B站登录态主字段"></label><label>bili_jct（必填）<input type="password" v-model="cookieFields.bili_jct" autocomplete="off" placeholder="CSRF 校验字段"></label></div><label>DedeUserID（可选）<input type="password" v-model="cookieFields.DedeUserID" autocomplete="off" placeholder="B站 UID"></label><label>其他 Cookie（可选）<input type="password" v-model="cookieFields.extra" autocomplete="off" placeholder="例如 buvid3=xxx"></label></template>
            <label v-if="editingAccountId" class="switch-label"><input type="checkbox" v-model="restoreAccount" :disabled="!platformDetail.module.enabled"> 更新后恢复账号及平台已开启任务</label><button class="primary" :disabled="busy||qr.busy||!!qr.id||(!editingAccountId&&!platformDetail.module.enabled)" @click="act(addPlatformAccount)">{{editingAccountId?'保存账号更新':'保存新账号'}}</button></div></div>

          <div class="section-head"><h2>最近运行</h2><button class="link" @click="screen='runs'">查看全部 →</button></div>
          <div class="card"><div v-if="!platformDetail.recent.length" class="empty">还没有运行记录</div><div v-for="r in platformDetail.recent" :key="r.id" class="item-row"><div class="item-body"><strong>{{r.account_label}} · {{r.task_key}}</strong><small>{{languageTime(r.created_at)}} · {{r.manual?'手动':'定时'}}</small></div><span :class="['status',r.status]">{{statusText(r.status)}}</span><button class="button small" @click="act(()=>showRun(r.id))">详情</button></div></div>
        </template>
      </template>

      <template v-else-if="screen==='runs'"><div class="section-head"><h2>最近 50 条执行记录</h2></div><div class="card"><div v-if="!runs.length" class="empty">暂无运行记录</div><div v-for="r in runs" :key="r.id" class="item-row"><div class="item-icon">▤</div><div class="item-body"><strong>{{r.account_label}} · {{r.task_key}}</strong><small>{{languageTime(r.created_at)}} · {{r.manual?'手动':'定时'}}</small></div><span :class="['status',r.status]">{{statusText(r.status)}}</span><button v-if="['scheduled','queued'].includes(r.status)" class="button small" @click="act(()=>cancelRun(r.id))">取消</button><button v-if="r.status==='waiting_verification'" class="button small" @click="act(()=>reconcileRun(r.id))">只读核对</button><button class="button small" @click="act(()=>showRun(r.id))">详情</button></div></div><button v-if="runCursor" class="button" @click="act(loadRuns)">加载更多</button></template>

      <template v-else-if="screen==='notifications'"><div class="card"><h2>用户默认通知规则</h2><small class="muted">这里的规则作用于你的全部平台和账号，是所有规则的兜底配置。平台页面里的通知设置会覆盖这里的默认规则。</small><p class="muted">说明：成功指任务执行成功；失败或需要人工确认属于异常；“本来无需执行”的情况不会发送任何通知。两个开关互相独立，关闭成功通知不影响异常通知。</p><div class="form"><div class="two"><label class="switch-label"><input type="checkbox" v-model="policyForm.success_enabled"> 成功时发送通知</label><label class="switch-label"><input type="checkbox" v-model="policyForm.exception_enabled"> 异常时发送通知</label></div><label>成功通知渠道<select v-model="policyForm.success_channels" multiple size="3"><option v-for="n in channels" :key="n.id" :value="n.id">{{n.name}} · {{n.type}}</option></select><small>可多选（Ctrl / Cmd）；未选择渠道时，成功通知不会发送</small></label><label>异常通知渠道<select v-model="policyForm.error_mode"><option value="same">与成功通知共用渠道（默认）</option><option value="custom">单独指定异常渠道</option></select></label><label v-if="policyForm.error_mode==='custom'">异常渠道<select v-model="policyForm.exception_channels" multiple size="3"><option v-for="n in channels" :key="n.id" :value="n.id">{{n.name}} · {{n.type}}</option></select></label><div class="card-actions"><button class="primary" @click="act(savePolicy)">保存默认规则</button><button class="button" @click="act(inheritPolicy)">清除自定义并恢复默认</button></div></div></div>
        <div class="section-head"><h2>我的通知渠道</h2><small class="muted">渠道用于接收通知；“发送测试”会立即发送一条测试消息，保存的凭据不会回显。</small></div><div class="card"><div v-if="!channels.length" class="empty">还没有设置通知渠道</div><div v-for="n in channels" :key="n.id" class="item-row"><div class="item-icon">◉</div><div class="item-body"><strong>{{n.name}}</strong><small>{{n.type}} · 凭据不回显</small></div><button class="button small" @click="editChannel(n)">编辑</button><button class="button small" @click="act(()=>toggleChannel(n))">{{n.enabled?'暂停':'启用'}}</button><button class="button small" @click="act(()=>testChannel(n.id))">发送测试</button><button class="button small danger-text" @click="act(()=>removeChannel(n.id))">删除</button></div></div>
        <div class="card form-card"><h2>{{editingChannel?'编辑通知渠道':'添加通知渠道'}}</h2><form class="form" @submit.prevent="act(createChannel)"><div v-if="editingChannel" class="info">密钥和 Webhook URL 留空会保留原值；其他已显示的字段可直接修改。<button type="button" @click="cancelChannelEdit">取消编辑</button></div><label v-if="channelForm.type==='webhook'">替换自定义请求头 JSON<textarea v-model="channelAdvanced.headers" rows="3" :placeholder="editingChannel?'留空保留原请求头；填写 {} 清除':'可选，例如 {&quot;Authorization&quot;:&quot;Bearer ...&quot;}'"></textarea><small>请求头可能包含密钥，保存后不回显。</small></label><div class="two"><label>渠道类型<select v-model="channelForm.type" :disabled="!!editingChannel"><option value="serverchan">Server酱 Turbo</option><option value="telegram">Telegram Bot</option><option value="webhook">通用 Webhook</option></select></label><label>渠道名称<input v-model="channelForm.name" required placeholder="例如：个人通知"></label></div><template v-if="channelForm.type==='telegram'"><label>Bot Token<input type="password" v-model="channelForm.botToken" :required="!editingChannel"></label><div class="two"><label>Chat ID<input v-model="channelForm.chatId" required></label><label>Thread ID（可选）<input v-model="channelForm.threadId"></label></div></template><template v-else-if="channelForm.type==='serverchan'"><label>Server酱 Turbo SendKey <a href="https://sct.ftqq.com/r/26297" target="_blank" rel="noreferrer">点此获取 SendKey</a><input type="password" v-model="channelForm.sendKey" :required="!editingChannel"></label></template><template v-else><label>Webhook HTTPS URL<input v-model="channelForm.url" :required="!editingChannel" placeholder="https://..."></label><label>Webhook 签名密钥（可选）<input type="password" v-model="channelForm.signingSecret" :placeholder="editingChannel?'留空保留原密钥':''"></label><label v-if="editingChannel" class="switch-label"><input type="checkbox" v-model="channelAdvanced.clearSigningSecret"> 清除原签名密钥（仍可填写新密钥替换）</label><small class="muted">Webhook 目标域名须经平台管理员批准。</small></template><button class="primary">保存通知渠道</button></form></div>
        <div class="card"><div class="section-head"><h2>通知发送记录</h2><button class="button" @click="act(()=>loadHistory())">刷新</button></div><div v-for="d in history" :key="d.id" class="item-row"><div class="item-body"><strong>{{d.channel_name}} / {{statusText(d.status)}}</strong><small>{{d.summary}} - {{languageTime(d.created_at)}} · 尝试 {{d.attempts}} 次 · {{d.last_error}}</small></div><button v-if="['failed','disabled'].includes(d.status)" class="button small" @click="act(()=>retryNotification(d.id))">重试发送</button></div><button v-if="historyCursor" class="button" @click="act(()=>loadHistory(true))">加载更多</button></div></template>

      <template v-else-if="screen==='profile'"><div class="card form-card"><h2>账号与安全</h2><p>用户名：<strong>{{me.username}}</strong> · 角色：{{me.role}}</p><p class="muted">通行密钥（Passkey）为可选登录方式。开启后可用设备指纹或人脸免密码登录；关闭后仍可使用账号密码登录。</p><button class="primary" @click="act(addPasskey)">添加 Passkey（可选）</button></div><div class="card form-card"><h2>登录密码</h2><div v-if="me.recovery_password_reset_allowed" class="info">已通过恢复码验证身份，可直接设置新密码。此授权仅可使用一次，有效至 {{languageTime(me.recovery_password_reset_expires_at)}}。</div><p class="muted">{{me.recovery_password_reset_allowed?'请立即设置新密码。保存后其他会话会被退出登录。':me.has_password?'已设置登录密码。修改后其他会话将被退出登录。':'当前账号还没有登录密码。设置后即可使用账号密码登录。'}}</p><form class="form" @submit.prevent="act(changePassword)"><label v-if="me.has_password&&!me.recovery_password_reset_allowed">当前密码<input type="password" v-model="passwordForm.current" autocomplete="current-password" required /></label><div class="two"><label>新密码<input type="password" v-model="passwordForm.next" autocomplete="new-password" required /></label><label>确认新密码<input type="password" v-model="passwordForm.confirm" autocomplete="new-password" required /></label></div><button class="primary">保存密码</button></form></div><div class="card form-card"><h2>资源配额</h2><div class="quota-grid"><div>账号 <b>{{totals.accounts}} / {{me.quotas?.max_accounts||5}}</b></div><div>启用任务 <b>{{totals.jobs}} / {{me.quotas?.max_jobs||10}}</b></div><div>通知渠道 <b>{{channels.length}} / {{me.quotas?.max_channels||5}}</b></div><div>自动执行上限 <b>{{me.quotas?.max_auto_runs??10}} / UTC日</b></div><div>手动执行上限 <b>{{me.quotas?.max_manual_runs??5}} / 24小时</b></div></div></div><div class="card"><div class="section-head"><h2>通行密钥与会话</h2><button class="button" @click="act(refreshSecurity)">刷新</button></div><div v-for="k in passkeys" :key="k.id" class="item-row"><span class="item-body">{{k.name}} - {{languageTime(k.created_at)}}</span><button class="button small" @click="act(()=>renamePasskey(k))">重命名</button><button class="button small" :disabled="passkeys.length<=1&&!me.has_password" @click="act(()=>removePasskey(k.id))">删除</button></div><div v-for="ses in sessions" :key="ses.id" class="item-row"><span class="item-body">{{ses.id===sessionId?'当前会话':'其他会话'}} - {{languageTime(ses.created_at)}}</span><button class="button small" @click="act(()=>revokeSession(ses.id))">注销会话</button></div><button class="button" @click="act(regenerateRecovery)">生成新的恢复码</button><p class="muted">安全相关操作要求你在最近 15 分钟内重新登录过。</p></div><div class="card form"><h2>账号与数据</h2><p class="muted">平台运营者可以解密已保存的凭据，这不是零知识托管。删除账号前需要先结清所有待处理的交易。</p><button v-if="me.role!=='admin'" class="button danger-text" @click="act(deleteMe)">永久删除我的账号</button></div></template>

      <template v-else-if="screen==='admin'&&me.role==='admin'"><div class="admin-tabs"><button v-for="x in [{id:'stats',name:'总览统计'},{id:'users',name:'用户管理'},{id:'invites',name:'邀请码'},{id:'audit',name:'审计日志'},{id:'review',name:'待复核任务'},{id:'settings',name:'全局设置'}]" :key="x.id" :class="adminTab===x.id?'active':''" @click="adminTab=x.id">{{x.name}}</button></div>
        <template v-if="adminTab==='stats'"><div class="card"><h2>应用健康状态</h2><p>最近调度器心跳：{{languageTime(adminStats.health?.scheduler_heartbeat)}} / 最近清理心跳：{{languageTime(adminStats.health?.maintenance_heartbeat)}}</p><p class="muted">这些是应用层计数，不代表 Cloudflare 账单或实测 CPU 用量。</p><div v-for="v in adminStats.usage" :key="v.day+v.kind">{{v.day}} / {{kindText(v.kind)}}: {{v.count}}</div></div><div class="stats-grid"><div v-for="(label,i) in ['活跃用户','冻结用户','绑定账号','启用任务','24h成功','24h异常','未投递','通知失败']" :key="i" class="stat-card"><small>{{label}}</small><strong>{{adminStats.stats?.[i]||0}}</strong></div></div><div class="card"><h2>最近 7 天任务统计</h2><div v-if="!adminStats.daily?.length" class="empty">还没有运行数据</div><div v-for="d in adminStats.daily" :key="d.day+d.status" class="item-row"><span class="item-body">{{d.day}} · {{statusText(d.status)}}</span><b>{{d.total}}</b></div></div><div class="card"><h2>最近管理员操作记录</h2><div v-for="x in adminStats.audit" :key="x.created_at+x.action" class="item-row"><div class="item-body"><strong>{{x.action}}</strong><small>{{languageTime(x.created_at)}}</small></div></div></div></template>
        <template v-else-if="adminTab==='users'"><div class="card-actions"><button class="button" :disabled="usersPage===0" @click="act(()=>pageUsers(-1))">上一页</button><span>第 {{usersPage+1}} 页</span><button class="button" :disabled="!(users.length>=30)" @click="act(()=>pageUsers(1))">下一页</button></div><div class="card"><h2>用户列表</h2><div v-for="u in users" :key="u.id" class="item-row"><div class="avatar">{{u.username[0].toUpperCase()}}</div><div class="item-body"><strong>{{u.username}} <span v-if="u.role==='admin'" class="tag">管理员</span></strong><small>账号 {{u.accounts_count}} · 任务 {{u.jobs_count}} · 24h 执行 {{u.daily_runs}} · 注册 {{languageTime(u.created_at)}}</small></div><span :class="['status',u.status==='active'?'succeeded':'failed']">{{statusText(u.status)}}</span><template v-if="u.role==='user'"><button class="button small" @click="act(()=>chooseUserQuota(u.id))">配额</button><button class="button small" @click="act(()=>resetUserPassword(u.id))">重置密码</button><button class="button small" @click="act(()=>toggleUser(u))">{{u.status==='active'?'冻结':'恢复'}}</button></template></div></div><div v-if="selectedUser" class="card form-card"><h2>用户配额 · {{users.find(x=>x.id===selectedUser)?.username}}</h2><form @submit.prevent="act(saveQuota)" class="form"><div class="three"><label>账号上限<input type="number" v-model.number="quotaForm.max_accounts" min="1"></label><label>任务上限<input type="number" v-model.number="quotaForm.max_jobs" min="1"></label><label>手动次数 / 24小时<input type="number" v-model.number="quotaForm.max_manual_runs" min="0"></label><label>自动次数 / UTC日<input type="number" v-model.number="quotaForm.max_auto_runs" min="0" max="1000"></label></div><div class="two"><label>每日通知次数<input type="number" v-model.number="quotaForm.max_notifications" min="0"></label><label>通知渠道数<input type="number" v-model.number="quotaForm.max_channels" min="1"></label></div><button class="primary">保存用户配额</button></form></div></template>
        <template v-else-if="adminTab==='invites'"><div class="card-actions"><button class="button" :disabled="invitesPage===0" @click="act(()=>pageInvites(-1))">上一页</button><span>第 {{invitesPage+1}} 页</span><button class="button" :disabled="!(invites.length>=50)" @click="act(()=>pageInvites(1))">下一页</button></div><div class="card form-card"><h2>创建邀请码</h2><p class="muted">可自定义邀请码（仅限字母、数字、下划线、短横线，长度不限）；留空则自动生成 TH- 开头的随机码。邀请码加密保存，可在下方列表查看。使用次数由数据库原子计数，达到上限自动失效。</p><form class="form" @submit.prevent="act(createInvite)"><div class="two"><label>备注<input v-model="inviteForm.label" placeholder="朋友 A"></label><label>自定义邀请码（可选）<input v-model="inviteForm.code" placeholder="留空自动生成"></label></div><div class="two"><label>最大使用次数<input type="number" min="1" max="1000" v-model.number="inviteForm.max_uses"></label><label>有效天数<input type="number" min="1" max="365" v-model.number="inviteForm.expires_in_days"></label></div><button class="primary">创建邀请码</button></form><div v-if="newInviteCode" class="new-code"><strong>新邀请码：</strong><code>{{newInviteCode}}</code><button class="button" @click="copyText(newInviteCode)">复制</button></div></div><div class="card"><h2>已创建的邀请码</h2><div v-for="i in invites" :key="i.id" class="item-row"><div class="item-icon">✦</div><div class="item-body"><strong>{{i.label||'未命名邀请码'}}</strong><small><code v-if="i.code">{{i.code}}</code><span v-else class="muted">（旧邀请码不可回显）</span> · 已使用 {{i.used_count}} / {{i.max_uses}} · 到期 {{languageTime(i.expires_at)}}</small></div><span :class="['status',i.enabled?'succeeded':'failed']">{{inviteState(i)}}</span><input class="mini-number" aria-label="邀请码最大使用次数" type="number" :min="i.used_count||1" max="1000" v-model.number="i.max_uses"><button class="button small" @click="act(()=>editInviteExpiry(i))">设置到期</button><button class="button small" @click="act(()=>patchInvite(i,{max_uses:i.max_uses}))">保存次数</button><button class="button small" @click="act(()=>patchInvite(i,{enabled:!i.enabled}))">{{i.enabled?'停用':'启用'}}</button></div></div></template>
        <template v-else-if="adminTab==='audit'"><div class="card-actions"><button class="button" :disabled="auditPage===0" @click="act(()=>pageAudit(-1))">上一页</button><button class="button" @click="act(()=>pageAudit(0))">刷新</button><button class="button" :disabled="!(auditRows.length>=50)" @click="act(()=>pageAudit(1))">下一页</button></div><div class="card"><h2>审计日志</h2><div v-for="row in auditRows" :key="row.id" class="item-row"><div class="item-body"><strong>{{row.action}}</strong><small>{{languageTime(row.created_at)}} / {{row.actor_user_id||'已删除用户'}} / {{row.target_id}}</small><pre>{{row.meta}}</pre></div></div></div></template><template v-else-if="adminTab==='review'"><div class="card"><h2>全站待人工复核任务</h2><p class="muted">先核对上游实际记录，再记录结论。结案不会重发原请求，但会允许后续新任务。操作要求最近15分钟内重新登录。</p><div class="card-actions"><button class="button" :disabled="reviewPage===0" @click="act(()=>pageReview(-1))">上一页</button><button class="button" @click="act(()=>pageReview(0))">刷新</button><button class="button" :disabled="!reviewHasNext" @click="act(()=>pageReview(1))">下一页</button></div><p v-if="!reviewRuns.length" class="empty">没有待复核任务</p><div v-for="r in reviewRuns" :key="r.id" class="item-row"><div class="item-body"><strong>{{r.owner_username}} · {{r.account_label}} · {{r.task_key}}</strong><small>{{languageTime(r.created_at)}} · {{r.id}}</small><p>{{r.summary}}</p></div><button class="button small" @click="openResolution(r)">记录人工核对结果</button></div></div></template><template v-else-if="adminTab==='settings'"><div class="card form-card"><h2>平台设置</h2><div class="form"><label>最多允许用户数<input type="number" min="1" v-model.number="adminSettings.max_users"></label><label class="switch-label"><input type="checkbox" v-model="adminSettings.maintenance"> 暂停 Cron 派发新任务</label><h3>模块开关</h3><label class="switch-label" v-for="m in modules" :key="m.id"><input type="checkbox" v-model="adminSettings.modules_enabled[m.id]"> {{m.title}}</label><label class="switch-label"><input type="checkbox" v-model="adminSettings.bili_exchange_allowed"> 允许用户启用 B 站兑换（需真实接口验证后开启）</label><label>允许使用 Webhook 的域名（每行一个，无协议或路径）<textarea rows="5" v-model="adminSettings.webhook_allowed_hosts_input" :placeholder="(adminSettings.webhook_allowed_hosts||[]).join('\n')"></textarea></label><h3>默认用户配额</h3><div class="three"><label>账号<input type="number" min="1" v-model.number="adminSettings.global_quotas.max_accounts"></label><label>任务<input type="number" min="1" v-model.number="adminSettings.global_quotas.max_jobs"></label><label>手动次数 / 24小时<input type="number" min="0" v-model.number="adminSettings.global_quotas.max_manual_runs"></label><label>自动次数 / UTC日<input type="number" min="0" max="1000" v-model.number="adminSettings.global_quotas.max_auto_runs"></label></div><div class="two"><label>每用户每日通知次数<input type="number" min="0" max="500" v-model.number="adminSettings.global_quotas.max_notifications"></label><label>每用户通知渠道数<input type="number" min="1" max="20" v-model.number="adminSettings.global_quotas.max_channels"></label></div><div class="two"><label>平台每日执行上限<input type="number" min="1" max="2000" v-model.number="adminSettings.platform_budget.max_daily_runs"></label><label>平台每日通知发送上限<input type="number" min="1" max="2000" v-model.number="adminSettings.platform_budget.max_daily_notifications"></label></div><label>邀请码记录上限<input type="number" min="1" max="1000" v-model.number="adminSettings.max_invites"></label><button class="primary" @click="act(saveAdmin)">保存全局设置</button><h3>历史记录维护</h3><p class="muted">按保留策略分批清理已完成的旧记录，未结任务和受保护证据不会被强行删除。</p><button class="button" @click="act(cleanupLogs)">执行一轮安全清理</button></div></div></template>
      </template>
      <dialog ref="runDialog" class="review-dialog" aria-labelledby="run-detail-heading" @cancel="selectedRun=null" @close="selectedRun=null"><template v-if="selectedRun"><div class="section-head"><h2 id="run-detail-heading">任务详情</h2><button class="button" @click="selectedRun=null">关闭</button></div><p><code>{{selectedRun.id}}</code> · {{statusText(selectedRun.status)}}</p><p v-if="selectedRun.status==='waiting_verification'" class="info">可先进行只读核对。若仍无法确定，请将此运行ID交给管理员，在后台记录人工核对证据。</p><div v-if="selectedRun.status==='waiting_verification'" class="card-actions"><button class="button" :disabled="busy" @click="act(()=>reconcileRun(selectedRun!.id))">只读核对</button><button class="button" @click="copyText(selectedRun!.id)">复制运行ID</button></div><pre>{{JSON.stringify({result:selectedRun.result,steps:selectedRun.steps},null,2)}}</pre></template></dialog>
      <dialog ref="resolveDialog" class="review-dialog" aria-labelledby="resolve-heading" @cancel="resolution=null" @close="resolution=null"><template v-if="resolution"><div class="section-head"><h2 id="resolve-heading">记录人工核对结果</h2><button class="button" @click="resolution=null">取消</button></div><p>{{resolution.owner_username}} · {{resolution.account_label}} · {{resolution.task_key}}</p><p><code>{{resolution.id}}</code></p><form class="form" @submit.prevent="act(resolveRun)"><label>已核对的实际结果<select v-model="resolveForm.outcome"><option value="failed">未成功 / 未发生预期操作</option><option value="succeeded">已成功完成预期操作</option></select></label><label>上游核对证据（20–2000字）<textarea v-model="resolveForm.evidence" minlength="20" maxlength="2000" rows="6" required placeholder="记录核对时间、上游交易或签到记录、前后状态等。不要填写Cookie、密码或Token。"></textarea></label><label class="switch-label"><input type="checkbox" v-model="resolveForm.confirmNoRepeat" required> 我已核对上游实际记录；本次不会重发原请求，但结案将允许后续新任务</label><p class="muted">原检查点和人工声明将保留用于审计。需在最近15分钟内重新登录；无法确定时请取消并继续保留待复核状态。</p><button class="primary" :disabled="busy||!resolveForm.confirmNoRepeat">保存核对结论</button></form></template></dialog>
      <footer class="footer">CF Task Hub · Cloudflare Workers / D1 / Queues / Durable Objects · 开源任务管理面板</footer>
    </main>
  </div>
</template>
