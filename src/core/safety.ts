import type {Env} from './types.ts';
import {HttpError,assert} from './response.ts';
import {setting} from './db.ts';
export const ACTIVE_STATES=['scheduled','queued','running','waiting_retry','waiting_verification'];
export async function noUnsettled(env:Env,owner:string,accountId?:string,jobId?:string){
 const row=await env.DB.prepare(`SELECT r.id FROM job_runs r JOIN jobs j ON j.id=r.job_id
 WHERE r.owner_user_id=? AND (? IS NULL OR j.account_id=?) AND (? IS NULL OR j.id=?)
 AND r.status IN ('scheduled','queued','running','waiting_retry','waiting_verification') LIMIT 1`)
 .bind(owner,accountId??null,accountId??null,jobId??null,jobId??null).first();
 assert(!row,409,'UNSETTLED_RUN','Pending runs must be completed, canceled or reconciled before deleting or changing credentials');
}
export async function requireRunning(env:Env){
 if(env.MAINTENANCE_MODE==='true'||await setting(env,'maintenance',false))throw new HttpError(503,'MAINTENANCE','Task execution is paused by the administrator');
}
export async function takeRate(env:Env,key:string,limit:number,windowMs:number){
 const r=await env.ACCOUNTS.get(env.ACCOUNTS.idFromName('rate:'+key.split(':')[0])).fetch('https://internal/rate',{method:'POST',body:JSON.stringify({key,limit,windowMs})});
 if(r.status===429)throw new HttpError(429,'RATE_LIMIT','Too many requests');
 if(!r.ok)throw new HttpError(503,'RATE_UNAVAILABLE','Rate limiter unavailable');
}
// Keep report structure intact. Truncating a JSON string makes valid reports
// unreadable, and regex redaction alone cannot protect arbitrary nested fields.
export function sanitizeReport(value:unknown,depth=0):any{
 if(depth>8)return '[depth limit]';
 if(value===null||typeof value==='boolean'||typeof value==='number')return value;
 if(typeof value==='string')return value.replace(/(SESSDATA|bili_jct|BDUSS|cookie|token|sendkey|authorization)\s*[:=]\s*[^\s,;"}]+/gi,'$1=[REDACTED]').replace(/https?:\/\/[^\s]+/gi,'[URL]').slice(0,800);
 if(Array.isArray(value))return value.slice(0,60).map(v=>sanitizeReport(v,depth+1));
 if(typeof value==='object'&&value){const out:Record<string,unknown>={};for(const [k,v] of Object.entries(value).slice(0,80)){
  if(/cookie|csrf|token|secret|password|authorization|credentials|headers|sendkey|^mid$|^uname$|^externalId$/i.test(k))continue;
  out[k]=sanitizeReport(v,depth+1);
 }return out;}
 return null;
}
