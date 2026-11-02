import {boundedText,identityNumber,cookieInput} from './network.ts';
import {fingerprint} from './crypto.ts';
import type {Env} from './types.ts';
export class SessionExpiredError extends Error {constructor(){super('Upstream session expired');this.name='SessionExpiredError';}}
// Carries the upstream business code/message (never the Cookie) so callers can
// distinguish risk-control blocks (-352/-412) from invalid credentials.
export class UpstreamIdentityError extends Error {detail:string;constructor(detail:string){super(detail);this.name='UpstreamIdentityError';this.detail=detail;}}
function upstreamDetail(data:any,status:number):string{
 const code=data&&typeof data==='object'&&!Array.isArray(data)?(data.code??data.errno):undefined;
 const message=data&&typeof data==='object'&&!Array.isArray(data)?String(data.message??''):'';
 const parts=[`HTTP ${status}`,code===undefined?'':`code=${code}`,message?`message=${message}`:''].filter(Boolean);
 return parts.join(' ').replace(/[\r\n]+/g,' ').slice(0,200);
}
// Real Edge/Chrome desktop UA: bare 'Mozilla/5.0' style UAs are likelier to be
// filtered by Bilibili's WAF alongside datacenter IPs.
const BROWSER_UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0';
// Never trust a UID copied from a browser cookie or supplied by the caller.
// These are read-only endpoints; failure prevents binding and scheduled writes.
export async function upstreamIdentity(moduleId:string,credentials:Record<string,unknown>,fetcher:typeof fetch=fetch):Promise<string>{
 const cookie=cookieInput(credentials.cookie);
 const call=async(url:string)=>{
  const response=await fetcher(url,{headers:{Cookie:cookie,'User-Agent':BROWSER_UA,Referer:moduleId==='bilibili-vip'?'https://www.bilibili.com/':'https://pan.baidu.com/'},redirect:'manual',signal:AbortSignal.timeout(15000)});
  let text:string;
  try{text=await boundedText(response);}
  catch{throw new UpstreamIdentityError(`上游响应读取失败（HTTP ${response.status}）`);}
  let data:any;
  try{data=JSON.parse(text);}
  catch{throw new UpstreamIdentityError(`上游返回非 JSON 响应（HTTP ${response.status}）`);}
  if(response.status!==200)throw new UpstreamIdentityError(`上游请求失败：${upstreamDetail(data,response.status)}`);
  return data;
 };
 if(moduleId==='bilibili-vip'){
  const data=await call('https://api.bilibili.com/x/web-interface/nav');
  if(data.code===-101||(data.code===0&&data.data?.isLogin===false))throw new SessionExpiredError();
  if(data.code!==0)throw new UpstreamIdentityError(`B站身份接口拒绝：${upstreamDetail(data,200)}`);
  if(data.data?.isLogin!==true)throw new UpstreamIdentityError('B站身份接口未确认登录（code=0 但 isLogin!=true）');
  try{return identityNumber(data.data.mid);}
  catch(error){throw error instanceof Error?new UpstreamIdentityError(`上游账号标识无效（${error.message}）`):error;}
 }
 if(moduleId==='baidu-netdisk'){
  // loginStatus is the primary probe. Older sessions may support the template
  // endpoint instead. No sign-in/reward/asset endpoint is called here.
  // Any failure here (including business errors) falls back, as before.
  try{const data=await call('https://pan.baidu.com/api/loginStatus?clienttype=1&channel=web&version=0');
   if(data.errno!==0)throw new UpstreamIdentityError(`百度登录状态接口拒绝：${upstreamDetail(data,200)}`);
   return identityNumber(data.login_info?.uk??data.data?.login_info?.uk);
  }catch{/* fall through to the template endpoint fallback */}
  const data=await call('https://pan.baidu.com/api/gettemplatevariable?clienttype=0&web=1&fields=%5B%22uk%22%5D');
  if(data.errno===-6)throw new SessionExpiredError();
  if(data.errno!==0)throw new UpstreamIdentityError(`百度身份接口拒绝：${upstreamDetail(data,200)}`);
  try{return identityNumber(data.result?.uk);}
  catch(error){throw error instanceof Error?new UpstreamIdentityError(`上游账号标识无效（${error.message}）`):error;}
 }
 throw new Error('Unsupported platform');
}
export async function verifiedIdentity(env:Env,moduleId:string,credentials:Record<string,unknown>,fetcher:typeof fetch=fetch){
 const externalId=await upstreamIdentity(moduleId,credentials,fetcher);
 return {externalId,fingerprint:await fingerprint(env.IDENTITY_KEY||env.DATA_KEY,'identity-v2:'+moduleId,externalId)};
}
