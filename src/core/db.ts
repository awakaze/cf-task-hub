import type {Env,User} from './types.ts';
import {resolveQuota,DEFAULT_QUOTAS} from './quotas.ts';
import {HttpError,assert} from './response.ts';
export async function getUser(env:Env,id:string):Promise<User|null>{return env.DB.prepare('SELECT * FROM users WHERE id=? AND status<>\'deleted\'').bind(id).first<User>();}
export async function getAccount(env:Env,id:string,userId:string){const row=await env.DB.prepare('SELECT * FROM accounts WHERE id=? AND owner_user_id=?').bind(id,userId).first();assert(row,404,'NOT_FOUND','账号不存在');return row as Record<string,unknown>;}
export async function countRows(env:Env,table:'accounts'|'jobs'|'notification_channels',userId:string):Promise<number>{const r=await env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE owner_user_id=?`).bind(userId).first<{n:number}>();return r?.n||0;}
export async function quotas(env:Env,userId:string){const r=await env.DB.prepare('SELECT * FROM user_quotas WHERE user_id=?').bind(userId).first<Record<string,unknown>>();const global=await setting(env,'global_quotas',DEFAULT_QUOTAS);return resolveQuota(r,global);}
export async function checkLimit(env:Env,userId:string,table:'accounts'|'jobs'|'notification_channels',limit:number){if(await countRows(env,table,userId)>=limit)throw new HttpError(429,'QUOTA_EXCEEDED','已达到该资源的数量上限');}
export async function audit(env:Env,actor:string,action:string,target:string,meta:Record<string,unknown>={}){
 await auditStatement(env,actor,action,target,meta).run();
}
export function auditStatement(env:Env,actor:string,action:string,target:string,meta:Record<string,unknown>={}){return env.DB.prepare('INSERT INTO audit_logs(id,actor_user_id,action,target_id,meta_json,created_at) VALUES(?,?,?,?,?,?)').bind(crypto.randomUUID(),actor,action,target,JSON.stringify(meta),Date.now());}
export async function setting<T>(env:Env,key:string,fallback:T):Promise<T>{const row=await env.DB.prepare('SELECT value_json FROM system_settings WHERE key=?').bind(key).first<{value_json:string}>();try{return row?JSON.parse(row.value_json):fallback;}catch{return fallback;}}
export async function setSetting(env:Env,key:string,value:unknown){await env.DB.prepare('INSERT INTO system_settings(key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at').bind(key,JSON.stringify(value),Date.now()).run();}
