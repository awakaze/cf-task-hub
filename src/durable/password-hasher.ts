import type {Env} from '../core/types.ts';
import {hashPassword,verifyAndUpgradePassword,validPassword} from '../core/password.ts';
import {PASSWORD_RPC_ORIGIN,PASSWORD_RPC_MAX_BYTES,passwordRpcSignature,signaturesEqual} from '../core/password-service.ts';

type Throttle={window:number;attempts:number;failures:number;lastFailureAt:number;nextAllowedAt:number;leaseUntil:number;leaseToken:string|null;expiresAt:number};
const WINDOW=15*60000,LEASE=45000;

// No public route: callers need the PASSWORDS binding and a signed request.
// Plaintext passwords are never persisted or logged.
export class PasswordHasher implements DurableObject{
 private state:DurableObjectState;private env:Env;private busy=false;
 private throttleTail:Promise<unknown>=Promise.resolve();
 constructor(state:DurableObjectState,env:Env){this.state=state;this.env=env;}
 private exclusive<T>(fn:()=>Promise<T>):Promise<T>{const result=this.throttleTail.then(fn);this.throttleTail=result.catch(()=>{});return result;}
 private json(value:unknown,status=200,headers:Record<string,string>={}){return Response.json(value,{status,headers:{'Cache-Control':'no-store',...headers}});}
 async fetch(req:Request):Promise<Response>{
  const url=new URL(req.url);
  if(req.method!=='POST'||url.origin!==PASSWORD_RPC_ORIGIN||url.pathname!=='/rpc'||req.headers.get('Content-Type')!=='application/json')return this.json({error:'Invalid internal request'},403);
  let body='';const reader=req.body?.getReader();let size=0;
  if(!reader)return this.json({error:'Invalid internal request'},400);
  try{
   const decoder=new TextDecoder();
   while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>PASSWORD_RPC_MAX_BYTES){await reader.cancel();return this.json({error:'Request too large'},413);}body+=decoder.decode(value,{stream:true});}
   body+=decoder.decode();
  }catch{return this.json({error:'Invalid internal request'},400);}
  const sent=req.headers.get('X-TaskHub-Signature')||'';
  if(!signaturesEqual(sent,await passwordRpcSignature(this.env.DATA_KEY,body)))return this.json({error:'Invalid internal request'},403);
  let data:any;try{data=JSON.parse(body);}catch{return this.json({error:'Invalid internal request'},400);}
  if(!data||typeof data.subject!=='string'||data.subject.length>160||!Number.isSafeInteger(data.at)||Math.abs(Date.now()-data.at)>30000||typeof data.nonce!=='string'||data.nonce.length>80)return this.json({error:'Invalid internal request'},400);
  if(data.kind==='auth-begin'||data.kind==='auth-finish')return this.exclusive(()=>this.throttle(data));
  if(!['hash','verify'].includes(data.kind)||typeof data.password!=='string'||data.password.length<1||data.password.length>128)return this.json({error:'Invalid internal request'},400);
  if(data.kind==='hash'&&!validPassword(data.password))return this.json({error:'Invalid internal request'},400);
  if(data.kind==='verify'&&(typeof data.stored!=='string'||data.stored.length>256))return this.json({error:'Invalid internal request'},400);
  if(this.busy)return this.json({error:'Authentication busy'},429,{'Retry-After':'1'});
  this.busy=true;
  try{return data.kind==='hash'?this.json({hash:await hashPassword(data.password)}):this.json(await verifyAndUpgradePassword(data.password,data.stored));}
  catch{return this.json({error:'Password operation unavailable'},503);}
  finally{data.password='';this.busy=false;}
 }
 private async throttle(data:any):Promise<Response>{
  const now=Date.now(),window=Math.floor(now/WINDOW);
  const old=await this.state.storage.get<Throttle>('auth-throttle');
  const value:Throttle=old&&old.expiresAt>now?{...old}:{window,attempts:0,failures:0,lastFailureAt:0,nextAllowedAt:0,leaseUntil:0,leaseToken:null,expiresAt:now+WINDOW};
  if(value.window!==window){value.window=window;value.attempts=0;}
  if(value.lastFailureAt<now-WINDOW){value.failures=0;value.nextAllowedAt=0;}
  if(data.kind==='auth-begin'){
   const retryUntil=Math.max(value.nextAllowedAt,value.leaseUntil,value.attempts>=20?(window+1)*WINDOW:0);
   if(retryUntil>now)return this.json({error:'Authentication temporarily limited'},429,{'Retry-After':String(Math.max(1,Math.ceil((retryUntil-now)/1000)))});
   value.attempts++;value.leaseToken=crypto.randomUUID();value.leaseUntil=now+LEASE;value.expiresAt=now+WINDOW;
   await this.state.storage.put('auth-throttle',value);await this.state.storage.setAlarm(value.expiresAt);
   return this.json({token:value.leaseToken});
  }
  if(typeof data.token!=='string'||data.token!==value.leaseToken||value.leaseUntil<=now||!['success','failure','error'].includes(data.outcome))return this.json({accepted:false});
  value.leaseToken=null;value.leaseUntil=0;
  if(data.outcome==='success'){value.failures=0;value.nextAllowedAt=0;value.lastFailureAt=0;}
  if(data.outcome==='failure'){
   value.failures=Math.min(12,value.failures+1);value.lastFailureAt=now;
   value.nextAllowedAt=now+(value.failures<3?0:Math.min(60000,1000*2**(value.failures-3)));
  }
  value.expiresAt=now+WINDOW;
  await this.state.storage.put('auth-throttle',value);await this.state.storage.setAlarm(value.expiresAt);
  return this.json({accepted:true});
 }
 async alarm(){await this.exclusive(async()=>{
  const value=await this.state.storage.get<Throttle>('auth-throttle');
  if(!value||value.expiresAt<=Date.now())await this.state.storage.deleteAll();
  else await this.state.storage.setAlarm(value.expiresAt);
 });}
}
