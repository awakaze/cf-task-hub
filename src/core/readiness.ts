import type {Env} from './types.ts';
import {fromB64} from './crypto.ts';
const cache=new WeakMap<object,{expires:number;keys:string;result:{ready:boolean;reason?:string}}>();
export async function readiness(env:Env):Promise<{ready:boolean;reason?:string}>{
 const keys=[env.DATA_KEY,env.IDENTITY_KEY,env.BOOTSTRAP_TOKEN].join('|');
 const old=cache.get(env.DB);if(old&&old.expires>Date.now()&&old.keys===keys)return old.result;
 const result=await inspect(env);cache.set(env.DB,{keys,result,expires:Date.now()+(result.ready?30000:2000)});return result;
}
export function clearReadinessCache(env:Env){cache.delete(env.DB);}
async function inspect(env:Env):Promise<{ready:boolean;reason?:string}>{
 try{
  const schema=await env.DB.prepare("SELECT value_json FROM system_settings WHERE key='schema_version'").first<{value_json:string}>();
  if(Number(schema?.value_json)!==8)return {ready:false,reason:'Database migration required: run npm run db:remote'};
  if(!env.DATA_KEY||fromB64(env.DATA_KEY).length!==32)return {ready:false,reason:'Set a valid DATA_KEY in Cloudflare Secrets'};
  if(!env.PASSWORDS)return {ready:false,reason:'Deploy the PASSWORDS Durable Object binding'};
  const admin=await env.DB.prepare("SELECT id FROM users WHERE role='admin'").first();
  if(!admin&&(!env.BOOTSTRAP_TOKEN||env.BOOTSTRAP_TOKEN.length<32))return {ready:false,reason:'Set BOOTSTRAP_TOKEN before the first administrator registration'};
  return {ready:true};
 }catch{return {ready:false,reason:'D1 binding or database initialization unavailable'};}
}
