import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {ref,reactive,computed,watch,nextTick,effectScope} from 'vue';

const source=readFileSync(new URL('../web/src/App.vue',import.meta.url),'utf8');
const script=source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1].replace(/^import .*$/gm,'');
function ui(fetcher=async()=>{throw new Error('Unexpected request');}){
 const scope=effectScope(),timers=new Map(),requests=[];let timerId=0,now=Date.now();
 const hooks=`globalThis.ui={auth,passwordForm,logged,ready,me,recovery,busy,screen,activePlatform,platformDetail,platformForm,cookieFields,accountLabel,editingAccountId,restoreAccount,qr,channelForm,channelAdvanced,editingChannel,selectedRun,invites,newInviteCode,users,channels,reviewRuns,resolveForm,resolution,api,logout,loginPassword,changePassword,resetPrivateState,applyGroup,savePlatform,editPlatformAccount,addPlatformAccount,startQr,pollQr,cancelQr,editChannel,createChannel,showRun,openResolution,resolveRun,setApi:(fn)=>{api=fn},setRefresh:(fn)=>{refresh=fn},setLoadPlatform:(fn)=>{loadPlatform=fn},setRefreshSecurity:(fn)=>{refreshSecurity=fn}};`;
 const context={ref,reactive,computed,watch,nextTick,onMounted:()=>{},onBeforeUnmount:()=>{},
  AbortController,DOMException,Response,Headers,TextEncoder,Blob,URL,crypto:globalThis.crypto,
  Date:class extends Date{static now(){return now;}},
  setTimeout(fn,delay){const id=++timerId;timers.set(id,{fn,delay});return id;},clearTimeout(id){timers.delete(id);},
  window:{confirm:()=>true},confirm:()=>true,prompt:()=>null,
  navigator:{clipboard:{writeText:async()=>{}}},location:{href:'https://taskhub.example.test/'},
  document:{cookie:'th_csrf=test-csrf',body:{appendChild(){}},createElement(){return {click(){},remove(){}};}},
  fetch:async(...args)=>{requests.push(args);return fetcher(...args);},console,
 };
 scope.run(()=>vm.runInNewContext(stripTypeScriptTypes(script+hooks,{mode:'strip'}),context));
 return {h:context.ui,context,timers,requests,advance(ms){now+=ms;},async close(){context.ui.resetPrivateState();await nextTick();scope.stop();timers.clear();}};
}
const authFixture=async(input,init)=>{
 if(input==='/api/v1/auth/login/password')return Response.json({ok:true});
 if(input==='/api/v1/me')return Response.json({user:{id:'bob',username:'bob',role:'user'},quotas:{}});
 if(input==='/api/v1/modules')return Response.json({modules:[]});
 if(input==='/api/v1/dashboard')return Response.json({stats:[]});
 if(input==='/api/v1/platforms')return Response.json({items:[]});
 if(input==='/api/v1/runs')return Response.json({items:[],next_before:null});
 if(input==='/api/v1/notification-channels'||input==='/api/v1/notification-policies')return Response.json({items:[]});
 throw new Error('Unexpected request: '+input);
};
test('successful password authentication removes previous session secrets and entered password',async()=>{
 const u=ui(authFixture);try{const h=u.h;h.logged.value=true;h.me.value={id:'admin',role:'admin'};h.auth.username='bob';h.auth.password='synthetic-password';h.auth.bootstrapToken='synthetic-bootstrap';h.recovery.value=['old-admin-recovery'];h.selectedRun.value={id:'old-run'};h.newInviteCode.value='old-invite';h.cookieFields.BDUSS='old-cookie';h.channelForm.botToken='old-notification-token';
 await h.loginPassword();assert.equal(h.me.value.id,'bob');assert.equal(h.logged.value,true);assert.equal(h.auth.password,'');assert.equal(h.auth.bootstrapToken,'');assert.equal(h.recovery.value.length,0);assert.equal(h.selectedRun.value,null);assert.equal(h.newInviteCode.value,'');assert.equal(h.cookieFields.BDUSS,'');assert.equal(h.channelForm.botToken,'');
 const submitted=JSON.parse(u.requests[0][1].body);assert.equal(submitted.password,'synthetic-password');
 }finally{await u.close();}
});
test('logout clears private state while failed server logout does not pretend session was revoked',async()=>{
 const u=ui(async path=>path==='/api/v1/auth/logout'?Response.json({ok:true}):path==='/api/v1/me'?Response.json({error:'LOGIN_REQUIRED'},{status:401}):Response.json({needsSetup:false}));
 try{const h=u.h;h.logged.value=true;h.me.value={id:'admin',role:'admin'};h.auth.username='admin';h.auth.password='old-password';h.recovery.value=['old-code'];h.users.value=[{username:'other'}];h.reviewRuns.value=[{id:'other-run'}];await h.logout();assert.equal(h.logged.value,false);assert.equal(h.auth.username,'');assert.equal(h.auth.password,'');assert.equal(h.recovery.value.length,0);assert.equal(h.users.value.length,0);assert.equal(h.reviewRuns.value.length,0);}finally{await u.close();}
 const failed=ui(async()=>{throw new TypeError('Offline');});try{failed.h.logged.value=true;failed.h.auth.password='secret';await assert.rejects(failed.h.logout(),/尚未完成/);assert.equal(failed.h.logged.value,true);assert.equal(failed.h.auth.password,'');}finally{await failed.close();}
});
test('a response arriving after logout cannot repopulate the next session',async()=>{
 let complete;const u=ui(()=>new Promise(resolve=>{complete=resolve;}));try{const old=u.h.api('/api/v1/runs');const rejection=assert.rejects(old,{name:'AbortError'});u.h.resetPrivateState();complete(Response.json({items:[{id:'private-old-run'}]}));await rejection;}finally{await u.close();}
});
test('login, logout and a different login isolate private state and outstanding responses end to end',async()=>{
 let signedIn=null,completeOldRequest;
 const u=ui(async(path,init)=>{
  if(path==='/api/v1/auth/login/password'){const body=JSON.parse(init.body);signedIn={id:body.username,username:body.username,role:body.username==='admin'?'admin':'user'};return Response.json({ok:true});}
  if(path==='/api/v1/auth/logout'){signedIn=null;return Response.json({ok:true});}
  if(path==='/api/v1/me')return signedIn?Response.json({user:signedIn,quotas:{}}):Response.json({error:'LOGIN_REQUIRED'},{status:401});
  if(path==='/api/v1/auth/setup-status')return Response.json({needsSetup:false});
  if(path==='/api/v1/runs?old-session=1')return new Promise(resolve=>{completeOldRequest=resolve;});
  if(path==='/api/v1/admin/stats')return Response.json({private_admin_count:7});
  if(path==='/api/v1/admin/users?page=0')return Response.json({items:[{username:'private-other-user'}]});
  if(path==='/api/v1/admin/invites?page=0')return Response.json({items:[{id:'private-invite'}]});
  if(path==='/api/v1/admin/settings')return Response.json({webhook_allowed_hosts:[]});
  if(path==='/api/v1/notification-channels')return Response.json({items:[{id:signedIn.id+'-channel',name:signedIn.username+' notification'}]});
  return authFixture(path,init);
 });
 try{
  const h=u.h;h.auth.username='admin';h.auth.password='synthetic-admin-password';await h.loginPassword();
  assert.equal(h.logged.value,true);assert.equal(h.me.value.role,'admin');assert.equal(h.auth.password,'');assert.equal(h.users.value[0].username,'private-other-user');
  h.recovery.value=['private-recovery'];h.newInviteCode.value='private-invite-code';h.selectedRun.value={id:'private-run'};h.cookieFields.BDUSS='private-cookie';h.channelForm.botToken='private-bot-token';
  const outstanding=h.api('/api/v1/runs?old-session=1');const rejected=assert.rejects(outstanding,{name:'AbortError'});
  await h.logout();assert.equal(h.logged.value,false);assert.equal(h.me.value.id,undefined);assert.equal(h.channels.value.length,0);assert.equal(h.users.value.length,0);assert.equal(h.invites.value.length,0);assert.equal(h.recovery.value.length,0);assert.equal(h.selectedRun.value,null);assert.equal(h.newInviteCode.value,'');assert.equal(h.cookieFields.BDUSS,'');assert.equal(h.channelForm.botToken,'');
  h.auth.username='bob';h.auth.password='synthetic-bob-password';await h.loginPassword();
  completeOldRequest(Response.json({items:[{id:'private-old-run'}]}));await rejected;
  assert.equal(h.logged.value,true);assert.equal(h.me.value.id,'bob');assert.equal(h.me.value.role,'user');assert.equal(h.channels.value.length,1);assert.equal(h.channels.value[0].id,'bob-channel');assert.equal(h.users.value.length,0);assert.equal(h.invites.value.length,0);assert.equal(h.recovery.value.length,0);assert.equal(h.selectedRun.value,null);assert.equal(h.auth.username,'');assert.equal(h.auth.password,'');assert.equal(h.newInviteCode.value,'');
 }finally{await u.close();}
});
test('platform notification inheritance is NULL and explicit empty policy remains explicit',async()=>{
 const u=ui();try{const h=u.h,calls=[];h.activePlatform.value='bilibili-vip';h.platformDetail.value={group:{features:['bili.vip_claim']}};h.setApi(async(...args)=>{calls.push(args);return {};});h.setRefresh(async()=>{});h.setLoadPlatform(async()=>{});
 h.applyGroup({features:['bili.vip_claim'],notify:null});assert.equal(h.platformForm.inheritNotify,true);await h.savePlatform();assert.equal(calls[0][2].notify,null);
 h.applyGroup({features:['bili.vip_claim'],notify:{success_enabled:true,exception_enabled:true,success_channels:[],error_mode:'same',exception_channels:[]}});assert.equal(h.platformForm.inheritNotify,false);await h.savePlatform();assert.ok(calls[1][2].notify);assert.equal(calls[1][2].notify.success_channels.length,0);
 }finally{await u.close();}
});
test('editing a notification destination preserves blank secrets and sends a partial configuration',async()=>{
 const u=ui();try{const h=u.h,calls=[];h.setApi(async(...a)=>{calls.push(a);return {};});h.setRefresh(async()=>{});
 h.editChannel({id:'ch',name:'TG',type:'telegram',editable_config:{chatId:'123456',threadId:'42'}});h.channelForm.chatId='987654';await h.createChannel();assert.equal(calls[0][1],'PATCH');assert.equal(calls[0][2].configPatch.chatId,'987654');assert.equal(calls[0][2].configPatch.threadId,'42');assert.equal(Object.hasOwn(calls[0][2].configPatch,'botToken'),false);
 h.editChannel({id:'wh',name:'Webhook',type:'webhook'});await h.createChannel();assert.equal(Object.keys(calls[1][2].configPatch).length,0);
 h.editChannel({id:'wh',name:'Webhook',type:'webhook'});h.channelAdvanced.headers='{}';h.channelAdvanced.clearSigningSecret=true;await h.createChannel();assert.equal(calls[2][2].configPatch.signingSecret,'');assert.equal(Object.keys(calls[2][2].configPatch.headers).length,0);assert.equal(Object.hasOwn(calls[2][2].configPatch,'url'),false);
 }finally{await u.close();}
});
test('recovery password form uses a single-use reset grant only for a recovery-authenticated session',async()=>{
 const u=ui();try{const h=u.h,calls=[];h.setApi(async(...a)=>{calls.push(a);return {ok:true};});h.setRefreshSecurity(async()=>{});h.me.value={has_password:true,recovery_password_reset_allowed:true};h.passwordForm.next='new-safe-password';h.passwordForm.confirm='new-safe-password';await h.changePassword();assert.equal(calls[0][2].recoveryReset,true);assert.equal(Object.hasOwn(calls[0][2],'currentPassword'),false);assert.equal(h.me.value.recovery_password_reset_allowed,false);assert.equal(h.passwordForm.next,'');
 h.passwordForm.current='old-safe-password';h.passwordForm.next='another-password';h.passwordForm.confirm='another-password';await h.changePassword();assert.equal(calls[1][2].currentPassword,'old-safe-password');assert.equal(Object.hasOwn(calls[1][2],'recoveryReset'),false);
 }finally{await u.close();}
});
test('existing account credentials update uses PATCH and retains account identity',async()=>{
 const u=ui();try{const h=u.h,calls=[];h.activePlatform.value='baidu-netdisk';h.platformDetail.value={module:{enabled:true},group:{features:['baidu.daily']}};h.setApi(async(...a)=>{calls.push(a);return {ok:true};});h.setRefresh(async()=>{});h.editPlatformAccount({id:'existing-account',label:'Old'});h.accountLabel.value='New';h.cookieFields.BDUSS='synthetic-bduss';h.cookieFields.STOKEN='synthetic-stoken';await h.addPlatformAccount();assert.equal(calls[0][0],'/api/v1/platforms/baidu-netdisk/accounts/existing-account');assert.equal(calls[0][1],'PATCH');assert.equal(calls[0][2].resumeJobs,true);assert.equal(calls[0][2].enabled,true);assert.match(calls[0][2].credentials.cookie,/BDUSS=synthetic-bduss/);assert.equal(h.cookieFields.BDUSS,'');assert.equal(h.editingAccountId.value,'');
 }finally{await u.close();}
});
async function startQrFixture(u,handler=async()=>({status:'pending'})){
 const h=u.h;h.logged.value=true;h.screen.value='platform:baidu-netdisk';h.activePlatform.value='baidu-netdisk';h.platformDetail.value={module:{enabled:true},group:{features:['baidu.daily']}};await nextTick();const calls=[];
 h.setApi(async(...args)=>{calls.push(args);if(args[0].endsWith('/qr/start'))return {id:'qr-1',qr:'data:image/png;base64,AA==',expires_at:Date.now()+180000};return handler(...args);});await h.startQr();return calls;
}
test('QR polling runs independently of the global busy lock and has a bounded deadline',async()=>{
 const u=ui();try{u.h.busy.value=true;const calls=await startQrFixture(u);await u.h.pollQr();assert.equal(calls.length,2);assert.equal(u.h.busy.value,true);assert.ok(u.h.qr.timer);u.advance(181000);await u.h.pollQr();assert.equal(calls.length,2);assert.equal(u.h.qr.id,'');assert.match(u.h.qr.status,/过期/);}finally{await u.close();}
});
test('cancel or platform switch aborts QR and ignores a late confirmed response',async()=>{
 const u=ui();try{let complete;const calls=await startQrFixture(u,()=>new Promise(r=>{complete=r;}));const pending=u.h.pollQr();await u.h.pollQr();assert.equal(calls.length,2);const signal=calls[1][4];u.h.screen.value='platform:bilibili-vip';await nextTick();assert.equal(signal.aborted,true);complete({status:'confirmed',account_id:'should-not-bind-in-ui'});await pending;assert.equal(u.h.qr.id,'');assert.equal(u.h.qr.busy,false);assert.equal(u.h.qr.timer,0);assert.equal(calls.length,2);}finally{await u.close();}
});
test('confirmed QR without an account id never reports success',async()=>{
 const u=ui();try{const calls=await startQrFixture(u,async()=>({status:'confirmed',account_id:null}));await u.h.pollQr();assert.equal(u.h.qr.id,'');assert.equal(u.h.qr.timer,0);assert.equal(calls.length,2);}finally{await u.close();}
});
test('admin resolution refuses missing evidence and sends an explicit no-replay acknowledgement',async()=>{
 const u=ui();try{const h=u.h,calls=[];h.setApi(async(...a)=>{calls.push(a);return {items:[],next_page:null};});h.openResolution({id:'review-run'});await assert.rejects(h.resolveRun(),/20–2000/);assert.equal(calls.length,0);h.resolveForm.evidence='已在上游实际记录逐项核对，指定日期该操作确实未执行，余额没有变化。';h.resolveForm.confirmNoRepeat=true;await h.resolveRun();assert.equal(calls[0][0],'/api/v1/admin/runs/review-run/resolve');assert.equal(calls[0][2].confirmNoRepeat,true);assert.equal(calls[0][2].outcome,'failed');assert.equal(h.resolution.value,null);}finally{await u.close();}
});
test('QR reauthentication pins the intended existing account when the challenge is created',async()=>{
 const u=ui();try{const h=u.h,calls=[];h.logged.value=true;h.screen.value='platform:baidu-netdisk';h.activePlatform.value='baidu-netdisk';h.platformDetail.value={module:{enabled:true},group:{features:['baidu.daily']}};await nextTick();h.editPlatformAccount({id:'existing-account',label:'Existing'});
 h.setApi(async(...args)=>{calls.push(args);return args[0].endsWith('/start')?{id:'qr-2',qr:'data:image/png;base64,AA==',expires_at:Date.now()+180000}:{status:'processing',retry_after_ms:6000};});
 await h.startQr();assert.equal(calls[0][2].accountId,'existing-account');assert.equal(calls[0][2].resumeJobs,true);h.editingAccountId.value='another-account';await h.pollQr();assert.equal(Object.hasOwn(calls[1][2],'accountId'),false);assert.equal(h.qr.accountId,'existing-account');assert.equal(u.timers.get(h.qr.timer).delay,6000);
 }finally{await u.close();}
});
