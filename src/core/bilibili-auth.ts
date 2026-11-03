import qrcode from 'qrcode-generator';
import {cookieInput,identityNumber} from './network.ts';

const PASSPORT='https://passport.bilibili.com/x/passport-login/web/';
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
export class BiliAuthError extends Error{
 readonly relogin:boolean;readonly code?:number;
 constructor(relogin=false,code?:number){super(relogin?'B站登录凭据无法续期，请重新扫码登录':'B站登录服务暂不可用，请稍后重试');this.name='BiliAuthError';this.relogin=relogin;this.code=code;}
}
export function biliToken(value:unknown):string{
 if(typeof value!=='string'||!value||value.length>4096||!/^[A-Za-z0-9._~-]+$/.test(value))throw new BiliAuthError(true);
 return value;
}
export function biliCookieValue(cookie:string,name:string){return cookie.split(';').map(v=>v.trim()).find(v=>v.startsWith(name+'='))?.slice(name.length+1)||'';}

// Fixed endpoints only, no automatic redirects, no upstream messages or URLs in errors.
async function authText(response:Response,signal:AbortSignal){
 const reader=response.body?.getReader();if(!reader)return '';
 const decoder=new TextDecoder();let size=0,text='';
 const abort=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
 try{for(;;){if(signal.aborted)throw new BiliAuthError();const item=await reader.read();if(signal.aborted)throw new BiliAuthError();if(item.done)break;
  size+=item.value.byteLength;if(size>131072)throw new BiliAuthError();text+=decoder.decode(item.value,{stream:true});
 }return text+decoder.decode();}finally{signal.removeEventListener('abort',abort);await reader.cancel().catch(()=>{});reader.releaseLock();}
}
async function request(url:string,fetcher:typeof fetch,cookie?:string,form?:Record<string,string>){
 const signal=AbortSignal.timeout(15000);
 try{
  const response=await fetcher(url,{method:form?'POST':'GET',redirect:'manual',signal,headers:{'User-Agent':UA,Referer:'https://www.bilibili.com/',...(cookie?{Cookie:cookieInput(cookie)}:{}),...(form?{'Content-Type':'application/x-www-form-urlencoded'}:{})},...(form?{body:new URLSearchParams(form).toString()}:{})});
  if(response.status!==200){await response.body?.cancel();throw new BiliAuthError(false,response.status);}
  // Covers reconstructed relay bodies as well as native fetch bodies.
  const body=await authText(response,signal);
  return {response,body};
 }catch(error){throw error instanceof BiliAuthError?error:new BiliAuthError();}
}
function payload(text:string):any{
 let data:any;try{data=JSON.parse(text);}catch{throw new BiliAuthError();}
 if(data?.code!==0)throw new BiliAuthError([-101,-111,86095].includes(data?.code),typeof data?.code==='number'?data.code:undefined);
 return data.data;
}
// Only the passport response can supply these parent-domain session cookies.
// Never consume a crossDomain URL: it may contain credentials in its query.
export function biliResponseCookie(response:Response,previous=''):string{
 const headers=response.headers as Headers&{getSetCookie?:()=>string[];getAll?:(name:string)=>string[]};
 const lines=(headers.getSetCookie?.()??headers.getAll?.('Set-Cookie')??[headers.get('Set-Cookie')||'']).flatMap(v=>v.split(/,(?=\s*[A-Za-z0-9_]+=)/));
 if(lines.length>64||lines.join('').length>32768)throw new BiliAuthError();
 const values=new Map(previous.split(';').map(v=>v.trim()).filter(Boolean).map(v=>{const i=v.indexOf('=');return [v.slice(0,i),v.slice(i+1)] as [string,string];}));
 const received=new Set<string>();
 for(const line of lines){
  const [first,...attrs]=line.split(';'),i=first.indexOf('=');if(i<=0)continue;
  const name=first.slice(0,i).trim(),value=first.slice(i+1).trim();
  if(!['SESSDATA','bili_jct','DedeUserID','DedeUserID__ckMd5','sid'].includes(name))continue;
  const attributes=new Map(attrs.map(v=>{const p=v.indexOf('=');return [(p<0?v:v.slice(0,p)).trim().toLowerCase(),p<0?'':v.slice(p+1).trim()] as [string,string];}));
  const domain=attributes.get('domain')?.toLowerCase().replace(/^\./,'');
  if(domain!=='bilibili.com'||attributes.get('path')!=='/')continue;
  const maxAge=attributes.get('max-age');
  if(!value||value.length>4096||/[^\x21-\x7e]|[;,"\\]/.test(value)||maxAge!==undefined&&(!/^\d+$/.test(maxAge)||Number(maxAge)<=0))throw new BiliAuthError();
  const expiry=attributes.get('expires');if(expiry&&Date.parse(expiry)<=Date.now())throw new BiliAuthError();
  values.set(name,value);received.add(name);
 }
 if(!['SESSDATA','bili_jct','DedeUserID'].every(v=>received.has(v)))throw new BiliAuthError();
 try{identityNumber(values.get('DedeUserID'));return cookieInput([...values].map(([k,v])=>k+'='+v).join('; '));}catch{throw new BiliAuthError();}
}
export async function biliQrStart(fetcher:typeof fetch=fetch){
 const {body}=await request(PASSPORT+'qrcode/generate',fetcher),data=payload(body),sign=biliToken(data?.qrcode_key);
 let url:URL;try{url=new URL(data?.url);}catch{throw new BiliAuthError();}
 const approvedPage=url.hostname==='passport.bilibili.com'&&url.pathname==='/h5-app/passport/login/scan'||url.hostname==='account.bilibili.com'&&url.pathname==='/h5/account-h5/auth/scan-web';
 if(url.protocol!=='https:'||!approvedPage||url.port||url.username||url.password||url.hash||url.searchParams.get('qrcode_key')!==sign||url.href.length>2048)throw new BiliAuthError();
 const image=qrcode(0,'M');image.addData(url.href);image.make();
 return {sign,auth_url:url.href,qr:'data:image/svg+xml;base64,'+btoa(image.createSvgTag(4,16))};
}
export async function biliQrPoll(sign:string,fetcher:typeof fetch=fetch):Promise<{status:'pending'|'scanned'|'expired'|'confirmed';credentials?:{cookie:string;refresh_token:string}}>{
 const {body,response}=await request(PASSPORT+'qrcode/poll?qrcode_key='+encodeURIComponent(biliToken(sign)),fetcher),data=payload(body);
 if(data?.code===86101)return {status:'pending'};
 if(data?.code===86090)return {status:'scanned'};
 if(data?.code===86038)return {status:'expired'};
 if(data?.code!==0)throw new BiliAuthError();
 return {status:'confirmed',credentials:{cookie:biliResponseCookie(response),refresh_token:biliToken(data.refresh_token)}};
}
export async function biliRefreshInfo(cookie:string,fetcher:typeof fetch=fetch){
 const {body}=await request(PASSPORT+'cookie/info?csrf='+encodeURIComponent(biliCookieValue(cookie,'bili_jct')),fetcher,cookie),data=payload(body);
 if(typeof data?.refresh!=='boolean'||!Number.isSafeInteger(data.timestamp)||data.timestamp<=0)throw new BiliAuthError();
 return {refresh:data.refresh as boolean,timestamp:data.timestamp as number};
}
export async function biliCorrespondPath(timestamp:number){
 const key=await crypto.subtle.importKey('jwk',{kty:'RSA',n:'y4HdjgJHBlbaBN04VERG4qNBIFHP6a3GozCl75AihQloSWCXC5HDNgyinEnhaQ_4-gaMud_GF50elYXLlCToR9se9Z8z433U3KjM-3Yx7ptKkmQNAMggQwAVKgq3zYAoidNEWuxpkY_mAitTSRLnsJW-NCTa0bqBFF6Wm1MxgfE',e:'AQAB'},{name:'RSA-OAEP',hash:'SHA-256'},false,['encrypt']);
 const encrypted=await crypto.subtle.encrypt('RSA-OAEP',key,new TextEncoder().encode('refresh_'+timestamp));
 return [...new Uint8Array(encrypted)].map(v=>v.toString(16).padStart(2,'0')).join('');
}
export async function biliRefreshCsrf(cookie:string,timestamp:number,fetcher:typeof fetch=fetch){
 const {body}=await request('https://www.bilibili.com/correspond/1/'+await biliCorrespondPath(timestamp),fetcher,cookie);
 const match=/<div\s+id=["']1-name["']\s*>([A-Za-z0-9._~-]+)<\/div>/.exec(body);if(!match)throw new BiliAuthError();return biliToken(match[1]);
}
export async function biliRefresh(cookie:string,token:string,csrf:string,fetcher:typeof fetch=fetch){
 const {body,response}=await request(PASSPORT+'cookie/refresh',fetcher,cookie,{csrf:biliCookieValue(cookie,'bili_jct'),refresh_csrf:biliToken(csrf),source:'main_web',refresh_token:biliToken(token)});
 const data=payload(body);return {cookie:biliResponseCookie(response,cookie),refresh_token:biliToken(data?.refresh_token)};
}
export async function biliConfirm(cookie:string,oldToken:string,fetcher:typeof fetch=fetch){
 const {body}=await request(PASSPORT+'confirm/refresh',fetcher,cookie,{csrf:biliCookieValue(cookie,'bili_jct'),refresh_token:biliToken(oldToken)});payload(body);
}
