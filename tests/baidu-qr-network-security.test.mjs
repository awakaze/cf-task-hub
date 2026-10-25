import test from 'node:test';
import assert from 'node:assert/strict';
import {baiduQrStart,baiduQrPoll,baiduQrCookie} from '../src/core/baidu-qr.ts';
const png=new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0]);
const qrData=url=>Response.json({errno:0,sign:'synthetic-sign',imgurl:url});
function responseWithCookies(body,cookies,status=200,location){const headers=new Headers();for(const value of cookies)headers.append('Set-Cookie',value);if(location)headers.set('Location',location);return new Response(body,{status,headers});}
test('QR rejects unapproved image hosts, insecure URLs and userinfo before fetching them',async()=>{
 for(const url of ['https://evil.example/qr.png','http://passport.baidu.com/qr.png','https://passport.baidu.com:8443/qr.png','https://secret@passport.baidu.com/qr.png','https://passport.baidu.com.evil.example/qr.png']){
  const calls=[];await assert.rejects(baiduQrStart(async(input,init)=>{calls.push(String(input));assert.equal(init.redirect,'manual');return qrData(url);}),error=>error.code==='UPSTREAM_ERROR'&&!error.detail.includes(url));assert.equal(calls.length,1);
 }
});
test('QR image follows only validated official HTTPS redirects with manual fetches',async()=>{
 const calls=[];const out=await baiduQrStart(async(input,init)=>{const url=String(input);calls.push(url);assert.equal(init.redirect,'manual');if(url.includes('getqrcode'))return qrData('https://passport.baidu.com/qr.png');if(url.endsWith('/qr.png'))return new Response(null,{status:302,headers:{Location:'https://pan.baidu.com/final.png'}});return new Response(png,{headers:{'Content-Type':'image/png'}});});assert.equal(calls.length,3);assert.match(out.qr,/^data:image\/png;base64,/);
 const blocked=[];await assert.rejects(baiduQrStart(async(input,init)=>{blocked.push(String(input));return blocked.length===1?qrData('https://passport.baidu.com/qr.png'):new Response(null,{status:302,headers:{Location:'https://evil.example/leak'}});}));assert.equal(blocked.length,2);
});
test('QR image stream is canceled as soon as it exceeds 200KB and never accepts SVG',async()=>{
 let canceled=false,reads=0;await assert.rejects(baiduQrStart(async input=>{if(String(input).includes('getqrcode'))return qrData('https://passport.baidu.com/qr.png');return new Response(new ReadableStream({pull(controller){reads++;controller.enqueue(new Uint8Array(100000));},cancel(){canceled=true;}}),{headers:{'Content-Type':'image/png'}});}));assert.equal(canceled,true);assert.ok(reads<=4);
 for(const [type,body] of [['image/svg+xml','<svg xmlns="http://www.w3.org/2000/svg"></svg>'],['image/png','<svg></svg>']])await assert.rejects(baiduQrStart(async input=>String(input).includes('getqrcode')?qrData('https://passport.baidu.com/qr.png'):new Response(body,{headers:{'Content-Type':type}})));
});
test('login redirect to an unapproved host is never requested or given cookies',async()=>{
 const calls=[];await assert.rejects(baiduQrCookie('synthetic-ticket',async(input,init)=>{calls.push({url:String(input),init});return responseWithCookies(null,['BDUSS=synthetic-sensitive; Domain=.baidu.com; Path=/; Secure'],302,'https://evil.example/capture');}),error=>error.code==='UPSTREAM_ERROR'&&!error.detail.includes('synthetic-sensitive')&&!error.detail.includes('evil.example'));assert.equal(calls.length,1);assert.equal(calls[0].init.redirect,'manual');
});
test('Cookie Domain and Path are isolated and passport host-only STOKEN is not used for Netdisk',async()=>{
 const calls=[];const cookie=await baiduQrCookie('synthetic-ticket',async(input,init)=>{const url=String(input);calls.push({url,init});assert.equal(init.redirect,'manual');
  if(calls.length===1)return responseWithCookies(null,[
   'BDUSS=shared-bduss; Domain=.baidu.com; Path=/; Secure',
   'STOKEN=passport-only; Path=/; Secure',
   'PTOKEN=path-restricted; Domain=.baidu.com; Path=/v3/login; Secure',
   'BAD=cross-domain; Domain=evil.example; Path=/',
  ],302,'https://pan.baidu.com/disk/home');
  assert.equal(url,'https://pan.baidu.com/disk/home');const forwarded=init.headers.Cookie||'';assert.match(forwarded,/BDUSS=shared-bduss/);assert.doesNotMatch(forwarded,/passport-only|path-restricted|cross-domain/);
  return responseWithCookies('{}',['STOKEN=netdisk-token; Path=/; Secure']);
 });assert.equal(calls.length,2);assert.match(cookie,/BDUSS=shared-bduss/);assert.match(cookie,/STOKEN=netdisk-token/);assert.doesNotMatch(cookie,/passport-only|path-restricted|cross-domain/);
});
test('passport JSON session may supply known BDUSS/PTOKEN but its STOKEN is ignored',async()=>{
 const calls=[];const cookie=await baiduQrCookie('synthetic-ticket',async(input,init)=>{const url=String(input);calls.push(url);if(calls.length===1)return Response.json({data:{session:{bduss:'json-bduss',ptoken:'json-ptoken',stoken:'untrusted-passport-stoken'}}});assert.equal(url,'https://pan.baidu.com/disk/home');assert.match(init.headers.Cookie,/BDUSS=json-bduss/);assert.match(init.headers.Cookie,/PTOKEN=json-ptoken/);assert.doesNotMatch(init.headers.Cookie,/STOKEN/);return responseWithCookies('', ['STOKEN=pan-session; Path=/; Secure']);});assert.match(cookie,/STOKEN=pan-session/);assert.doesNotMatch(cookie,/untrusted-passport-stoken/);
 const attempts=[];await assert.rejects(baiduQrCookie('synthetic-ticket',async input=>{attempts.push(String(input));return Response.json({data:{session:{bduss:'bad\r\nvalue'}}});}));assert.equal(attempts.length,1);
});
test('a passport host-only STOKEN cannot satisfy a missing Netdisk STOKEN',async()=>{
 let calls=0;await assert.rejects(baiduQrCookie('synthetic-ticket',async()=>{calls++;return calls===1?responseWithCookies('{}',['BDUSS=shared; Domain=.baidu.com; Path=/; Secure','STOKEN=passport-only; Path=/; Secure']):new Response('');}),error=>error.code==='UPSTREAM_COOKIE_INCOMPLETE');assert.equal(calls,2);
});
test('poll redirects are validated and parent cancellation causes no upstream request',async()=>{
 let calls=0;const result=await baiduQrPoll('synthetic-sign',async(_input,init)=>{calls++;assert.equal(init.redirect,'manual');return new Response(null,{status:302,headers:{Location:'http://passport.baidu.com/leak'}});});assert.equal(result.status,0);assert.equal(calls,1);
 const controller=new AbortController();controller.abort();await assert.rejects(baiduQrPoll('synthetic-sign',async()=>{throw new Error('must not fetch');},controller.signal),{name:'AbortError'});
});
