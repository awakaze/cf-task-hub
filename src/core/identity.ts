import {boundedJson,identityNumber,cookieInput} from './network.ts';
import {fingerprint} from './crypto.ts';
import type {Env} from './types.ts';
export class SessionExpiredError extends Error {constructor(){super('Upstream session expired');this.name='SessionExpiredError';}}
// Never trust a UID copied from a browser cookie or supplied by the caller.
// These are read-only endpoints; failure prevents binding and scheduled writes.
export async function upstreamIdentity(moduleId:string,credentials:Record<string,unknown>,fetcher:typeof fetch=fetch):Promise<string>{
 const cookie=cookieInput(credentials.cookie);
 const call=async(url:string)=>{
  const response=await fetcher(url,{headers:{Cookie:cookie,'User-Agent':'Mozilla/5.0',Referer:moduleId==='bilibili-vip'?'https://www.bilibili.com/':'https://pan.baidu.com/'},redirect:'manual',signal:AbortSignal.timeout(15000)});
  if(response.status!==200)throw new Error('Account identity request failed');return boundedJson(response);
 };
 if(moduleId==='bilibili-vip'){
  const data=await call('https://api.bilibili.com/x/web-interface/nav');
  if(data.code===-101||(data.code===0&&data.data?.isLogin===false))throw new SessionExpiredError();
  if(data.code!==0||data.data?.isLogin!==true)throw new Error('Bilibili identity unavailable');
  return identityNumber(data.data.mid);
 }
 if(moduleId==='baidu-netdisk'){
  // loginStatus is the primary probe. Older sessions may support the template
  // endpoint instead. No sign-in/reward/asset endpoint is called here.
  try{const data=await call('https://pan.baidu.com/api/loginStatus?clienttype=1&channel=web&version=0');
   if(data.errno!==0)throw new Error('Baidu session is not authenticated');
   return identityNumber(data.login_info?.uk??data.data?.login_info?.uk);
  }catch{
   const data=await call('https://pan.baidu.com/api/gettemplatevariable?clienttype=0&web=1&fields=%5B%22uk%22%5D');
   if(data.errno===-6)throw new SessionExpiredError();
   if(data.errno!==0)throw new Error('Baidu identity unavailable');return identityNumber(data.result?.uk);
  }
 }
 throw new Error('Unsupported platform');
}
export async function verifiedIdentity(env:Env,moduleId:string,credentials:Record<string,unknown>,fetcher:typeof fetch=fetch){
 const externalId=await upstreamIdentity(moduleId,credentials,fetcher);
 return {externalId,fingerprint:await fingerprint(env.IDENTITY_KEY||env.DATA_KEY,'identity-v2:'+moduleId,externalId)};
}
