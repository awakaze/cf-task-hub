import {HttpError} from './response.ts';

const BROWSER_UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
// These are the passport and Netdisk endpoints used by this login flow. Do not
// approve arbitrary *.baidu.com names or third-party image hosts automatically.
const BAIDU_HOSTS=new Set(['passport.baidu.com','wappass.baidu.com','pan.baidu.com']);
const PAN_ROOT=new URL('https://pan.baidu.com/');
const IMAGE_LIMIT=200000;
const IMAGE_TYPES=new Set(['image/png','image/jpeg','image/gif','image/webp']);
function upstreamError(message='百度登录服务暂不可用，请稍后重试或改用 Cookie 导入'):HttpError{return new HttpError(502,'UPSTREAM_ERROR',message);}
export class BaiduQrError extends HttpError{
 constructor(code:string,message:string,status=502){super(status,code,message);}
}
function approvedUrl(input:string,base?:URL):URL{
 let url:URL;try{url=new URL(input,base);}catch{throw upstreamError('百度登录服务返回了无效地址');}
 if(input.length>16384||url.protocol!=='https:'||url.port&&url.port!=='443'||url.username||url.password||url.hash||!BAIDU_HOSTS.has(url.hostname.toLowerCase()))throw upstreamError('百度登录服务返回了不受信任的地址');
 return url;
}
function opaqueToken(value:unknown,max=4096):string{
 if(typeof value!=='string'||!value||value.length>max||/[^\x21-\x7e]|[;,"\\]/.test(value))throw upstreamError('百度登录服务返回了无效登录参数');
 return value;
}
function requestSignal(timeout:number,parent?:AbortSignal):AbortSignal{return parent?AbortSignal.any([parent,AbortSignal.timeout(timeout)]):AbortSignal.timeout(timeout);}
async function boundedBytes(response:Response,limit:number,signal?:AbortSignal):Promise<Uint8Array>{
 const declared=Number(response.headers.get('Content-Length'));
 if(Number.isFinite(declared)&&declared>limit){await response.body?.cancel();throw upstreamError('百度响应超过允许大小');}
 const reader=response.body?.getReader();if(!reader)return new Uint8Array();
 const chunks:Uint8Array[]=[];let size=0;
 const abort=()=>{void reader.cancel().catch(()=>{});};
 signal?.addEventListener('abort',abort,{once:true});
 try{
  for(;;){if(signal?.aborted)throw new DOMException('Request canceled','AbortError');const part=await reader.read();if(signal?.aborted)throw new DOMException('Request canceled','AbortError');if(part.done)break;
   size+=part.value.byteLength;if(size>limit)throw upstreamError('百度响应超过允许大小');chunks.push(part.value);
  }
  const out=new Uint8Array(size);let offset=0;for(const chunk of chunks){out.set(chunk,offset);offset+=chunk.byteLength;}return out;
 }finally{signal?.removeEventListener('abort',abort);await reader.cancel().catch(()=>{});reader.releaseLock();}
}
async function boundedBody(response:Response,limit:number,signal?:AbortSignal):Promise<string>{return new TextDecoder().decode(await boundedBytes(response,limit,signal));}
function parseCallback(text:string):any{
 const match=/^[\w$.]*\((.*)\)\s*;?\s*$/s.exec(text.trim());
 try{return JSON.parse(match?match[1]:text);}catch{return null;}
}
type StoredCookie={name:string;value:string;domain:string;hostOnly:boolean;path:string;secure:boolean;expiresAt:number|null;sourceHost:string;order:number};
function defaultCookiePath(url:URL){const path=url.pathname;if(!path.startsWith('/'))return '/';const i=path.lastIndexOf('/');return i<=0?'/':path.slice(0,i);}
function pathMatches(request:string,path:string){return request===path||request.startsWith(path)&&(path.endsWith('/')||request[path.length]==='/');}
export class BaiduCookieJar{
 private cookies=new Map<string,StoredCookie>();private sequence=0;
 constructor(snapshot:StoredCookie[]=[]){
  if(!Array.isArray(snapshot)||snapshot.length>64)throw upstreamError('百度扫码会话无效，请重新生成二维码');
  for(const c of snapshot){
   if(!c||typeof c.sourceHost!=='string'||!BAIDU_HOSTS.has(c.sourceHost)||typeof c.path!=='string'||!c.path.startsWith('/')||/[;\r\n]/.test(c.path)||typeof c.name!=='string'||typeof c.value!=='string'||typeof c.domain!=='string'||/[;\r\n]/.test(c.domain)||typeof c.hostOnly!=='boolean'||typeof c.secure!=='boolean'||c.expiresAt!==null&&!Number.isFinite(c.expiresAt))throw upstreamError('百度扫码会话无效，请重新生成二维码');
   const headers=new Headers({'Set-Cookie':`${c.name}=${c.value}; Path=${c.path}${c.hostOnly?'':'; Domain='+c.domain}${c.secure?'; Secure':''}${c.expiresAt===null?'':'; Expires='+new Date(c.expiresAt).toUTCString()}`});
   this.collect(new Response(null,{headers}),approvedUrl('https://'+c.sourceHost+c.path));
  }
 }
 snapshot(){return [...this.cookies.values()].filter(c=>c.expiresAt===null||c.expiresAt>Date.now()).map(c=>({...c}));}
 private key(name:string,domain:string,path:string){return name+'\n'+domain+'\n'+path;}
 collect(response:Response,url:URL){
  const headers=response.headers as Headers&{getSetCookie?:()=>string[]};
  const raw=typeof headers.getSetCookie==='function'?headers.getSetCookie():[headers.get('set-cookie')||''];
  const lines=raw.flatMap(line=>line.split(/,(?=\s*[A-Za-z0-9!#$%&'*+.^_`|~-]+=)/));
  if(lines.length>64||lines.reduce((sum,line)=>sum+line.length,0)>32768)throw upstreamError('百度登录响应包含过多 Cookie');
  for(const line of lines){
   const parts=line.split(';'),first=parts.shift()||'',equal=first.indexOf('=');if(equal<=0)continue;
   const name=first.slice(0,equal).trim();let value=first.slice(equal+1).trim();
   if(!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/.test(name))continue;
   if(value.startsWith('"')&&value.endsWith('"'))value=value.slice(1,-1);
   if(value.length>4096||/[^\x21-\x7e]|[;,"\\]/.test(value))continue;
   const attrs=new Map<string,string>();for(const part of parts){const i=part.indexOf('='),key=(i<0?part:part.slice(0,i)).trim().toLowerCase();attrs.set(key,i<0?'':part.slice(i+1).trim());}
   let domain=url.hostname,hostOnly=true;
   if(attrs.has('domain')){
    domain=attrs.get('domain')!.toLowerCase().replace(/^\./,'');hostOnly=false;
    if(domain!=='baidu.com'&&!BAIDU_HOSTS.has(domain))continue;
    if(url.hostname!==domain&&!url.hostname.endsWith('.'+domain))continue;
   }
   const givenPath=attrs.get('path')||'',path=givenPath.startsWith('/')?givenPath:defaultCookiePath(url),secure=attrs.has('secure');
   if(name.startsWith('__Secure-')&&!secure||name.startsWith('__Host-')&&(!secure||!hostOnly||path!=='/'))continue;
   let expiresAt:number|null=null;
   const maxAge=attrs.get('max-age');if(maxAge&&/^-?\d+$/.test(maxAge)){const seconds=Number(maxAge);if(Number.isFinite(seconds))expiresAt=Date.now()+seconds*1000;}
   else if(attrs.has('expires')){const expires=Date.parse(attrs.get('expires')!);if(Number.isFinite(expires))expiresAt=expires;}
   const key=this.key(name,domain,path);if(expiresAt!==null&&expiresAt<=Date.now()){this.cookies.delete(key);continue;}
   if(!value){this.cookies.delete(key);continue;}
   const order=this.cookies.get(key)?.order??this.sequence++;
   this.cookies.set(key,{name,value,domain,hostOnly,path,secure,expiresAt,sourceHost:url.hostname,order});
   if(this.cookies.size>64)throw upstreamError('百度登录响应包含过多 Cookie');
  }
 }
 // Only trusted passport JSON session fields may create a known parent-domain
 // cookie. Never grant a Domain attribute to arbitrary host-only Set-Cookie data.
 setPassportSession(name:'BDUSS'|'PTOKEN',value:string,source:URL){
  if(!['passport.baidu.com','wappass.baidu.com'].includes(source.hostname))return;
  const cookie:StoredCookie={name,value:opaqueToken(value),domain:'baidu.com',hostOnly:false,path:'/',secure:true,expiresAt:null,sourceHost:source.hostname,order:this.sequence++};
  this.cookies.set(this.key(name,'baidu.com','/'),cookie);
 }
 private applicable(url:URL){return [...this.cookies.values()].filter(c=>(c.expiresAt===null||c.expiresAt>Date.now())&&(!c.secure||url.protocol==='https:')&&(c.hostOnly?url.hostname===c.domain:url.hostname===c.domain||url.hostname.endsWith('.'+c.domain))&&pathMatches(url.pathname,c.path)).sort((a,b)=>b.path.length-a.path.length||a.order-b.order);}
 header(url:URL){const value=this.applicable(url).map(c=>c.name+'='+c.value).join('; ');if(value.length>16000)throw upstreamError('百度登录 Cookie 超过允许大小');return value;}
 value(name:string,url:URL,sourceHost?:string){return this.applicable(url).find(c=>c.name===name&&(!sourceHost||c.sourceHost===sourceHost))?.value||'';}
}
type BaiduResponse={response:Response;url:URL;signal:AbortSignal;cookiesReady?:boolean};
function qrDebug(trace:string|undefined,event:string,fields:Record<string,unknown>){if(trace)console.info('[baidu-qr-debug]',JSON.stringify({trace,event,...fields}));}
function cookieShape(jar:BaiduCookieJar){return jar.snapshot().filter(c=>['BDUSS','STOKEN','PTOKEN','BAIDUID','SBOXTKN','PANWEB'].includes(c.name)).map(c=>({name:c.name,domain:c.domain,host_only:c.hostOnly,source_host:c.sourceHost,value_length:c.value.length,usable_for_pan:(c.hostOnly?c.domain===PAN_ROOT.hostname:PAN_ROOT.hostname===c.domain||PAN_ROOT.hostname.endsWith('.'+c.domain))&&pathMatches(PAN_ROOT.pathname,c.path)}));}
async function requestBaidu(input:string|URL,fetcher:typeof fetch,{jar,timeout=10000,parent,maxRequests=4,diagnostics,stopOnCookies=false}:{jar?:BaiduCookieJar;timeout?:number;parent?:AbortSignal;maxRequests?:number;diagnostics?:string;stopOnCookies?:boolean}={}):Promise<BaiduResponse>{
 let url=approvedUrl(String(input));const signal=requestSignal(timeout,parent);
 for(let count=0;count<maxRequests;count++){
  // One deadline covers the complete redirect chain and final response body.
  if(signal.aborted)throw new DOMException('Request canceled','AbortError');
  const route=url.pathname.endsWith('/qrbdusslogin')?'callback':url.hostname==='pan.baidu.com'?'netdisk':'passport_other';
  const requestStarted=Date.now();
  qrDebug(diagnostics,'request',{hop:count,host:url.hostname,route,cookies:jar?cookieShape(jar):[]});
  const cookie=jar?.header(url)||'';const response=await fetcher(url.toString(),{redirect:'manual',headers:{'User-Agent':BROWSER_UA,Referer:PAN_ROOT.toString(),...(cookie?{Cookie:cookie}:{})},signal});
  try{jar?.collect(response,url);}catch(error){await response.body?.cancel();throw error;}
  const declared=response.headers.get('Content-Length'),contentType=response.headers.get('Content-Type')||'';
  qrDebug(diagnostics,'response',{hop:count,host:url.hostname,route,http_status:response.status,elapsed_ms:Date.now()-requestStarted,redirect:response.status>=300&&response.status<400,content_kind:contentType.includes('json')?'json':contentType.includes('html')?'html':'other',declared_bytes:declared!==null&&/^\d{1,12}$/.test(declared)?Number(declared):undefined,cookies:jar?cookieShape(jar):[]});
  if(response.status>=300&&response.status<400){
   const location=response.headers.get('Location');await response.body?.cancel();if(!location)throw upstreamError('百度登录重定向缺少目标地址');const next=approvedUrl(location,url);
   // Netdisk can issue STOKEN on a redirect and keep redirecting afterwards.
   // End credential collection here; account binding still verifies the UID.
   if(stopOnCookies&&jar?.value('BDUSS',PAN_ROOT)&&jar.value('STOKEN',PAN_ROOT)){
    qrDebug(diagnostics,'redirect_cookies_ready',{hop:count,host:url.hostname});
    return {response,url,signal,cookiesReady:true};
   }
   url=next;continue;
  }
  return {response,url,signal};
 }
 throw upstreamError('百度登录重定向次数超过限制');
}
function imageSignature(type:string,bytes:Uint8Array):boolean{
 const prefix=(values:number[])=>values.every((value,index)=>bytes[index]===value);
 if(type==='image/png')return prefix([137,80,78,71,13,10,26,10]);
 if(type==='image/jpeg')return prefix([255,216,255]);
 if(type==='image/gif'){const head=new TextDecoder().decode(bytes.subarray(0,6));return head==='GIF87a'||head==='GIF89a';}
 return type==='image/webp'&&new TextDecoder().decode(bytes.subarray(0,4))==='RIFF'&&new TextDecoder().decode(bytes.subarray(8,12))==='WEBP';
}
function bytesToBase64(bytes:Uint8Array){let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(text);}
function safeError(error:unknown,message:string,parent?:AbortSignal):never{
 if(parent?.aborted)throw new DOMException('Request canceled','AbortError');
 if(error instanceof HttpError)throw error;
 throw upstreamError(message);
}
export function baiduAuthUrl(sign:string){return `https://wappass.baidu.com/wp/?qrlogin&t=${Math.ceil(Date.now()/1000)}&error=0&sign=${encodeURIComponent(opaqueToken(sign,512))}&cmd=login&lp=pc&tpl=netdisk&adapter=3&qrloginfrom=pc`;}
export async function baiduQrStart(fetcher:typeof fetch=fetch,parent?:AbortSignal):Promise<{sign:string;qr:string;cookies:StoredCookie[]}>{
 try{
  const jar=new BaiduCookieJar();
  const first=await requestBaidu('https://passport.baidu.com/v2/api/getqrcode?lp=pc&qrloginfrom=pc&tpl=netdisk',fetcher,{parent,jar});
  if(!first.response.ok){await first.response.body?.cancel();throw upstreamError('百度二维码接口暂不可用，请改用 Cookie 导入');}
  const data=parseCallback(await boundedBody(first.response,32768,first.signal));if(data?.errno!==0||!data?.imgurl)throw upstreamError('百度二维码接口返回异常');
  const sign=opaqueToken(data.sign,512),raw=String(data.imgurl);
  const source=raw.startsWith('//')?'https:'+raw:/^[A-Za-z0-9.-]+\.baidu\.com\//.test(raw)?'https://'+raw:raw;
  const imageUrl=approvedUrl(source,first.url);
  const image=await requestBaidu(imageUrl,fetcher,{parent,jar});
  if(!image.response.ok){await image.response.body?.cancel();throw upstreamError('二维码图片获取失败');}
  const type=(image.response.headers.get('Content-Type')||'').split(';')[0].trim().toLowerCase();
  if(!IMAGE_TYPES.has(type)){await image.response.body?.cancel();throw upstreamError('二维码图片格式不受支持');}
  const bytes=await boundedBytes(image.response,IMAGE_LIMIT,image.signal);
  if(!bytes.length||!imageSignature(type,bytes))throw upstreamError('二维码图片内容无效');
  return {sign,qr:`data:${type};base64,${bytesToBase64(bytes)}`,cookies:jar.snapshot()};
 }catch(error){return safeError(error,'二维码获取失败，请稍后重试或改用 Cookie 导入',parent);}
}
export async function baiduQrPoll(sign:string,fetcher:typeof fetch=fetch,parent?:AbortSignal,jar=new BaiduCookieJar()):Promise<{status:number;v?:string}>{
 try{
  const ticket=opaqueToken(sign,512);
  const result=await requestBaidu(`https://passport.baidu.com/channel/unicast?channel_id=${encodeURIComponent(ticket)}&callback=this_is_callback&tpl=netdisk`,fetcher,{timeout:32000,parent,jar});
  if(!result.response.ok){await result.response.body?.cancel();return {status:0};}
  const payload=parseCallback(await boundedBody(result.response,16384,result.signal));if(payload?.errno!==0)return {status:0};
  let channel=payload.channel_v;if(typeof channel==='string'){try{channel=JSON.parse(channel);}catch{return {status:0};}}
  const status=Number(channel?.status);if(!Number.isFinite(status))return {status:0};
  return {status,...(typeof channel.v==='string'?{v:opaqueToken(channel.v)}:{})};
 }catch(error){if(parent?.aborted)throw new DOMException('Request canceled','AbortError');return {status:0};}
}
export async function baiduQrCookie(bduss:string,fetcher:typeof fetch=fetch,parent?:AbortSignal,jar=new BaiduCookieJar(),diagnostics?:string):Promise<string>{
 let stage:'CALLBACK'|'CALLBACK_BODY'|'NETDISK'='CALLBACK',httpStatus:number|undefined,upstreamCode:number|undefined;
 const started=Date.now();
 // A relay adds a round trip per redirect. Keep each chain bounded while
 // leaving room for polling and UID verification inside the 120-second lease.
 const exchangeDeadline=requestSignal(45000,parent);
 try{
  const ticket=opaqueToken(bduss),target=encodeURIComponent(PAN_ROOT.toString()),now=Date.now();
  qrDebug(diagnostics,'exchange_start',{cookies:cookieShape(jar)});
  const initial=`https://passport.baidu.com/v3/login/main/qrbdusslogin?v=${now}&bduss=${encodeURIComponent(ticket)}&u=${target}&loginVersion=v4&qrcode=1&tpl=netdisk&apiver=v3&tt=${now}&time=${Math.floor(now/1000)}&alg=v3&callback=bd__cbs__login`;
  const login=await requestBaidu(initial,fetcher,{jar,parent:exchangeDeadline,timeout:30000,diagnostics,stopOnCookies:true});
  httpStatus=login.response.status;
  if(!login.response.ok&&!login.cookiesReady){await login.response.body?.cancel();throw new BaiduQrError('BAIDU_QR_CALLBACK_HTTP','百度登录回调暂不可用');}
  // Redirects may finish on a large Netdisk HTML page. Cookies have already
  // been collected at every hop; only read a passport body for BDUSS fallback.
  let session:any;
  if(!jar.value('BDUSS',PAN_ROOT)&&['passport.baidu.com','wappass.baidu.com'].includes(login.url.hostname)){
   stage='CALLBACK_BODY';
   const parsed=parseCallback(await boundedBody(login.response,16384,login.signal));session=parsed?.data?.session;
   const code=parsed?.errInfo?.no??parsed?.errno??parsed?.data?.errno;
   if((typeof code==='number'||typeof code==='string'&&/^-?\d{1,10}$/.test(code))&&Number.isSafeInteger(Number(code)))upstreamCode=Number(code);
   qrDebug(diagnostics,'callback_body',{parsed:!!parsed,has_session:!!session,upstream_code:upstreamCode});
  }else await login.response.body?.cancel();
  // Passport session.stoken is not a Netdisk STOKEN and is intentionally ignored.
  for(const [name,key] of [['BDUSS','bduss'],['PTOKEN','ptoken']] as const){const value=session?.[key];if(!jar.value(name,PAN_ROOT)&&typeof value==='string')jar.setPassportSession(name,opaqueToken(value),login.url);}
  if(!jar.value('BDUSS',PAN_ROOT))throw new BaiduQrError('BAIDU_QR_BDUSS_MISSING','百度登录回调未返回网盘登录态，请重新扫码');
  if(!jar.value('STOKEN',PAN_ROOT)){
   stage='NETDISK';httpStatus=undefined;
   const pan=await requestBaidu(new URL('/disk/home',PAN_ROOT),fetcher,{jar,parent:exchangeDeadline,timeout:30000,diagnostics,stopOnCookies:true});
   httpStatus=pan.response.status;
   // Only bounded headers/cookies are needed; do not download the HTML page.
   await pan.response.body?.cancel();
   if(!pan.response.ok&&!pan.cookiesReady)throw new BaiduQrError('BAIDU_QR_NETDISK_HTTP','百度网盘登录态获取失败，请重新扫码');
  }
  const stoken=jar.value('STOKEN',PAN_ROOT);
  if(!stoken)throw new BaiduQrError('BAIDU_QR_STOKEN_MISSING','百度扫码登录未返回网盘 STOKEN，请改用完整 Cookie 导入',422);
  qrDebug(diagnostics,'exchange_complete',{elapsed_ms:Date.now()-started,cookies:cookieShape(jar)});
  return jar.header(PAN_ROOT);
 }catch(error){
  if(parent?.aborted)throw new DOMException('Request canceled','AbortError');
  const reason=error instanceof BaiduQrError?error.code:`BAIDU_QR_${stage}_${error instanceof HttpError?'RESPONSE':error instanceof Error&&['TimeoutError','AbortError'].includes(error.name)?'TIMEOUT':'NETWORK'}`;
  // Fixed fields only: never log URLs, callback bodies, token values or errors.
  qrDebug(diagnostics,'exchange_failed',{stage,reason,http_status:httpStatus,upstream_code:upstreamCode,elapsed_ms:Date.now()-started,has_bduss:!!jar.value('BDUSS',PAN_ROOT),has_stoken:!!jar.value('STOKEN',PAN_ROOT)});
  if(error instanceof BaiduQrError)throw error;
  throw new BaiduQrError(reason,error instanceof HttpError?error.detail:stage==='NETDISK'?'访问百度网盘时连接失败或超时，请重新扫码':'百度登录回调连接失败或超时，请重新扫码');
 }
}
