import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {PasswordHasher} from '../../src/durable/password-hasher.ts';
// Real SQLite, with a small D1 API adapter. This is NOT Cloudflare/workerd.
export class D1Fixture {
 constructor({migrate=true}={}){this.sqlite=new DatabaseSync(':memory:');this.sqlite.exec('PRAGMA foreign_keys=ON;');this.calls=0;this.failBatchAt=null;
  if(migrate){const dir=new URL('../../migrations/',import.meta.url);for(const name of readdirSync(dir).filter(n=>n.endsWith('.sql')).sort())this.sqlite.exec(readFileSync(new URL(name,dir),'utf8'));}
 }
 prepare(sql){const db=this;const values=[];const p={sql,values,
  bind(...args){return Object.assign(Object.create(p),{values:args});},
  _rows(){db.calls++;const stmt=db.sqlite.prepare(this.sql);return stmt.all(...this.values).map(r=>({...r}));},
  async first(column){const row=this._rows()[0]??null;return column?(row?.[column]??null):row;},
  async all(){return {success:true,results:this._rows(),meta:{}};},
  async run(){db.calls++;const r=db.sqlite.prepare(this.sql).run(...this.values);return {success:true,results:[],meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};},
 };return p;}
 async batch(statements){this.sqlite.exec('BEGIN');try{const out=[];for(let i=0;i<statements.length;i++){if(this.failBatchAt===i)throw new Error('Injected database failure');out.push(await statements[i].all());}this.sqlite.exec('COMMIT');return out;}catch(e){this.sqlite.exec('ROLLBACK');throw e;}}
 async exec(sql){this.sqlite.exec(sql);return {count:1,duration:0};}
 close(){this.sqlite.close();}
}
export function memoryStorage(){const map=new Map();let alarm=null;return {map,
 async get(key){return structuredClone(map.get(key));},async put(key,value){if(typeof key==='object'){for(const[k,v]of Object.entries(key))map.set(k,structuredClone(v));}else map.set(key,structuredClone(value));},
 async delete(key){if(Array.isArray(key)){let n=0;for(const k of key)if(map.delete(k))n++;return n;}return map.delete(key);},async deleteAll(){map.clear();alarm=null;},
 async list({prefix='',limit=1000,start,startAfter,end,reverse=false}={}){let rows=[...map.entries()].filter(([k])=>k.startsWith(prefix)&&(!start||k>=start)&&(!startAfter||k>startAfter)&&(!end||k<end)).sort(([a],[b])=>a<b?-1:a>b?1:0);if(reverse)rows.reverse();return new Map(rows.slice(0,limit).map(([k,v])=>[k,structuredClone(v)]));},
 async setAlarm(value){alarm=Number(value);},async getAlarm(){return alarm;},async deleteAlarm(){alarm=null;},async transaction(fn){const saved=structuredClone(map);try{return await fn(this);}catch(e){map.clear();for(const[k,v]of saved)map.set(k,v);throw e;}}
 };}
export async function fixture(){const DB=new D1Fixture(),queued=[];const env={DB,DATA_KEY:Buffer.alloc(32,3).toString('base64url'),BOOTSTRAP_TOKEN:'b'.repeat(40),TASK_QUEUE:{async send(body,options){queued.push({body,options});},async sendBatch(batch){queued.push(...batch);}},ACCOUNTS:{idFromName(n){return n;},get(){return {fetch:async()=>Response.json({allowed:true})};}}};
 const passwordObjects=new Map();env.PASSWORDS={idFromName(name){return name;},get(name){let object=passwordObjects.get(name);if(!object){object=new PasswordHasher({storage:memoryStorage()},env);passwordObjects.set(name,object);}return {fetch:(input,init)=>object.fetch(input instanceof Request?input:new Request(input,init))};}};
 await DB.prepare("INSERT INTO users(id,username,role,status,created_at) VALUES('admin','admin','admin','active',?)").bind(Date.now()).run();
 await DB.prepare("INSERT INTO invites(id,code_hash,max_uses,created_at) VALUES('invite','hash',100,?)").bind(Date.now()).run();
 for(const id of ['alice','bob'])await DB.prepare("INSERT INTO users(id,username,role,status,invite_id,created_at) VALUES(?,?,'user','active','invite',?)").bind(id,id,Date.now()).run();
 return {env,DB,queued};
}
export async function account(DB,{id='account',owner='alice',module='bilibili-vip',fingerprint=id,enc='{}',enabled=1}={}){await DB.prepare('INSERT INTO accounts(id,owner_user_id,module_id,label,fingerprint,credentials_enc,enabled,created_at,updated_at,identity_verified_at) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(id,owner,module,'Test',fingerprint,enc,enabled,Date.now(),Date.now(),Date.now()).run();return id;}
export async function job(DB,{id='job',owner='alice',accountId='account',task='bili.vip_claim',enabled=1,due=Date.now()-1000}={}){await DB.prepare('INSERT INTO jobs(id,owner_user_id,account_id,task_key,schedule_json,enabled,next_run_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(id,owner,accountId,task,JSON.stringify({type:'daily',hour:11,minute:0,timezone:'Asia/Shanghai'}),enabled,due,Date.now(),Date.now()).run();return DB.prepare('SELECT * FROM jobs WHERE id=?').bind(id).first();}
export async function run(DB,{id='run',owner='alice',jobId='job',status='succeeded',created=Date.now(),manual=0}={}){await DB.prepare('INSERT INTO job_runs(id,owner_user_id,job_id,window_key,status,manual,scheduled_for,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(id,owner,jobId,id,status,manual,created,created).run();return id;}
