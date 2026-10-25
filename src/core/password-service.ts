import type {Env} from './types.ts';
import {fingerprint,sha256} from './crypto.ts';
import {HttpError} from './response.ts';

export const PASSWORD_RPC_ORIGIN='https://passwords.internal';
export const PASSWORD_RPC_MAX_BYTES=4096;
export type AuthAttempt={subject:string;token:string};
type RpcInput={kind:string;[key:string]:unknown};

export async function passwordRpcSignature(secret:string,body:string){return fingerprint(secret,'password-rpc-v1',body);}
export function signaturesEqual(left:string,right:string){
 if(left.length!==right.length)return false;
 let diff=0;for(let i=0;i<left.length;i++)diff|=left.charCodeAt(i)^right.charCodeAt(i);return diff===0;
}
async function rpc(env:Env,subject:string,input:RpcInput):Promise<any>{
 if(!env.PASSWORDS)throw new HttpError(503,'AUTH_SERVICE_UNAVAILABLE','Password service binding is unavailable');
 const body=JSON.stringify({...input,subject,at:Date.now(),nonce:crypto.randomUUID()});
 if(new TextEncoder().encode(body).byteLength>PASSWORD_RPC_MAX_BYTES)throw new HttpError(400,'INVALID_AUTH_REQUEST','Invalid authentication request');
 const signature=await passwordRpcSignature(env.DATA_KEY,body);
 const response=await env.PASSWORDS.get(env.PASSWORDS.idFromName('auth:'+await sha256(subject))).fetch(PASSWORD_RPC_ORIGIN+'/rpc',{
  method:'POST',headers:{'Content-Type':'application/json','X-TaskHub-Signature':signature},body,signal:AbortSignal.timeout(15000),
 });
 if(response.status===429)throw new HttpError(429,'AUTH_RATE_LIMIT','登录尝试过于频繁，请稍后再试；也可使用已配置的 Passkey');
 if(!response.ok)throw new HttpError(503,'AUTH_SERVICE_UNAVAILABLE','Authentication service temporarily unavailable');
 return response.json();
}
export async function hashPasswordForUser(env:Env,subject:string,password:string):Promise<string>{
 const result=await rpc(env,'kdf:'+subject,{kind:'hash',password});
 if(typeof result.hash!=='string'||!result.hash.startsWith('pbkdf2$600000$'))throw new HttpError(503,'AUTH_SERVICE_UNAVAILABLE','Password service returned an invalid result');
 return result.hash;
}
export async function verifyPasswordForUser(env:Env,subject:string,password:string,stored:string):Promise<{ok:boolean;upgradedHash?:string}>{
 const result=await rpc(env,'kdf:'+subject,{kind:'verify',password,stored});
 if(typeof result.ok!=='boolean')throw new HttpError(503,'AUTH_SERVICE_UNAVAILABLE','Password service returned an invalid result');
 return {ok:result.ok,...(result.ok&&typeof result.upgradedHash==='string'?{upgradedHash:result.upgradedHash}:{})};
}
export async function beginAuthAttempt(env:Env,username:string):Promise<AuthAttempt>{
 const subject='attempt:'+username.trim().toLowerCase();
 const result=await rpc(env,subject,{kind:'auth-begin'});
 if(typeof result.token!=='string')throw new HttpError(503,'AUTH_SERVICE_UNAVAILABLE','Authentication service returned an invalid result');
 return {subject,token:result.token};
}
export async function finishAuthAttempt(env:Env,attempt:AuthAttempt,outcome:'success'|'failure'|'error'):Promise<void>{
 // Completion failure must not cause an otherwise successful login to be
 // repeated. The account's short in-flight lease still expires safely.
 await rpc(env,attempt.subject,{kind:'auth-finish',token:attempt.token,outcome}).catch(()=>{});
}
