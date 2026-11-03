import test from 'node:test';
import assert from 'node:assert/strict';
import {biliQrStart,biliQrPoll,biliCorrespondPath,biliResponseCookie,biliRefreshInfo,BiliAuthError} from '../src/core/bilibili-auth.ts';
import {sanitizeReport} from '../src/core/safety.ts';
import {upstreamFetch} from '../src/core/upstream-fetch.ts';

function sessionResponse(data={},session='new-session',csrf='new-csrf',uid='42'){
 const headers=new Headers();for(const [k,v]of [['SESSDATA',session],['bili_jct',csrf],['DedeUserID',uid]])headers.append('Set-Cookie',`${k}=${v}; Domain=.bilibili.com; Path=/; Expires=Wed, 01 Jan 2031 00:00:00 GMT; Secure`);
 return Response.json({code:0,data},{headers});
}
test('current Bilibili account QR URL is accepted while mismatched host/path pairs are rejected',async()=>{
 const key='c'.repeat(32),path='/h5/account-h5/auth/scan-web',url='https://account.bilibili.com'+path+'?navhide=1&qrcode_key='+key+'&from=main_web';
 const out=await biliQrStart(async()=>Response.json({code:0,data:{qrcode_key:key,url}}));assert.equal(out.auth_url,url);assert.match(out.qr,/^data:image\/svg\+xml;base64,/);
 for(const bad of ['https://account.bilibili.com/h5-app/passport/login/scan?qrcode_key='+key,'https://passport.bilibili.com'+path+'?qrcode_key='+key,'https://account.bilibili.com.evil.test'+path+'?qrcode_key='+key])await assert.rejects(biliQrStart(async()=>Response.json({code:0,data:{qrcode_key:key,url:bad}})),BiliAuthError);
});
test('Web QR renders locally, polls known states and reads credentials only from trusted cookies',async()=>{
 const key='a'.repeat(32),url='https://passport.bilibili.com/h5-app/passport/login/scan?qrcode_key='+key;
 const qr=await biliQrStart(async()=>Response.json({code:0,data:{qrcode_key:key,url}}));
 assert.equal(qr.sign,key);assert.equal(qr.auth_url,url);assert.ok(qr.qr.startsWith('data:image/svg+xml;base64,'));
 for(const [code,status]of [[86101,'pending'],[86090,'scanned'],[86038,'expired']])assert.equal((await biliQrPoll(key,async()=>Response.json({code:0,data:{code}}))).status,status);
 const logged=await biliQrPoll(key,async()=>sessionResponse({code:0,refresh_token:'new-token',url:'https://evil.test/?SESSDATA=do-not-fetch'}));
 assert.equal(logged.status,'confirmed');assert.match(logged.credentials.cookie,/SESSDATA=new-session/);assert.equal(logged.credentials.refresh_token,'new-token');
 await assert.rejects(biliQrPoll(key,async()=>Response.json({code:0,data:{code:0,refresh_token:'secret',url:'https://passport.biligame.com/?SESSDATA=untrusted'}})),BiliAuthError);
});

test('Google relay preserves each session Set-Cookie when rebuilding a QR response',async t=>{
 const endpoint='https://script.google.com/macros/s/test-deployment/exec';
 t.mock.method(globalThis,'fetch',async(input,init)=>{
  assert.equal(String(input),endpoint);assert.equal(init.method,'POST');
  return Response.json({ok:true,status:200,headers:{'content-type':'application/json','set-cookie':['SESSDATA=relay-session; Domain=.bilibili.com; Path=/; Expires=Wed, 01 Jan 2031 00:00:00 GMT','bili_jct=relay-csrf; Domain=.bilibili.com; Path=/','DedeUserID=42; Domain=.bilibili.com; Path=/']},bodyB64:Buffer.from(JSON.stringify({code:0,data:{code:0,refresh_token:'relay-token'}})).toString('base64')});
 });
 const result=await biliQrPoll('a'.repeat(32),upstreamFetch({GOOGLE_RELAY_ENABLED:'true',GOOGLE_RELAY_URL:endpoint,GOOGLE_RELAY_HMAC_SECRET:'x'.repeat(64)}));
 assert.equal(result.credentials.refresh_token,'relay-token');assert.match(result.credentials.cookie,/SESSDATA=relay-session/);assert.match(result.credentials.cookie,/bili_jct=relay-csrf/);assert.match(result.credentials.cookie,/DedeUserID=42/);
});
test('QR URL validation, redirects, response limits and cookie domain isolation fail closed',async()=>{
 const key='b'.repeat(32);
 for(const url of ['https://evil.test/','https://passport.bilibili.com.evil.test/h5-app/passport/login/scan?qrcode_key='+key,'http://passport.bilibili.com/h5-app/passport/login/scan?qrcode_key='+key])await assert.rejects(biliQrStart(async()=>Response.json({code:0,data:{qrcode_key:key,url}})),BiliAuthError);
 await assert.rejects(biliQrStart(async()=>new Response('',{status:302,headers:{Location:'https://evil.test/'}})),BiliAuthError);
 await assert.rejects(biliQrStart(async()=>new Response('x'.repeat(131073))),BiliAuthError);
 const headers=new Headers();for(const name of ['SESSDATA','bili_jct','DedeUserID'])headers.append('Set-Cookie',`${name}=42; Domain=evil.test; Path=/`);
 assert.throws(()=>biliResponseCookie(new Response('',{headers})),BiliAuthError);
 const merged=biliResponseCookie(sessionResponse(), 'SESSDATA=old; bili_jct=old; DedeUserID=42; buvid3=device');assert.match(merged,/buvid3=device/);assert.ok(!merged.includes('SESSDATA=old'));
});
test('RSA generation and refresh info validation use protocol values and safe errors',async()=>{
 assert.match(await biliCorrespondPath(1793664000000),/^[0-9a-f]{256}$/);
 await assert.rejects(biliRefreshInfo('SESSDATA=session',async()=>Response.json({code:0,data:{refresh:'false',timestamp:1}})),BiliAuthError);
 try{await biliRefreshInfo('SESSDATA=session',async()=>Response.json({code:-101,message:'SESSDATA=secret'}));assert.fail();}catch(e){assert.equal(e.relogin,true);assert.ok(!e.message.includes('secret'));}
 assert.deepEqual(sanitizeReport({ac_time_value:'secret',refresh_token:'secret',ok:'ac_time_value=secret'}),{ok:'ac_time_value=[REDACTED]'});
});
