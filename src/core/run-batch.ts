import type {Env,JobRecord} from './types.ts';

export type RunSpec={job:JobRecord;windowKey:string;manual?:boolean;at?:number;dependsOn?:{jobId:string;windowKey:string}};
export type RunBatchOptions={publish?:boolean;before?:D1PreparedStatement[];after?:D1PreparedStatement[]};
export async function manualRunUsage(env:Env,userId:string,now=Date.now()):Promise<number>{
 const row=await env.DB.prepare('SELECT count(*) n FROM run_usage_claims WHERE owner_user_id=? AND manual=1 AND created_at>?').bind(userId,now-86400000).first<{n:number}>();
 return Number(row?.n||0);
}
export async function autoRunUsage(env:Env,userId:string,now=Date.now()):Promise<number>{
 const start=Math.floor(now/86400000)*86400000;
 const row=await env.DB.prepare('SELECT count(*) n FROM run_usage_claims WHERE owner_user_id=? AND manual=0 AND created_at>=?').bind(userId,start).first<{n:number}>();
 return Number(row?.n||0);
}

// All claims, runs, dependencies and queue intents commit together. Publication
// happens afterwards and can be recovered from outbox even when Queues is down.
// The returned IDs retain the caller's order; coupon claims are inserted first.
export async function queueRunBatch(env:Env,specs:RunSpec[],options:RunBatchOptions={}):Promise<string[]>{
 if(!specs.length)return [];
 if(specs.length>20)throw new Error('Run batch exceeds its bounded limit');
 const owners=new Set(specs.map(s=>s.job.owner_user_id));
 if(owners.size!==1)throw new Error('A run batch must have one owner');
 const now=Date.now();
 const prepared=specs.map((spec,index)=>({...spec,index,runId:crypto.randomUUID()}));
 for(const spec of prepared){
  if(spec.job.task_key!=='bili.exchange'||spec.dependsOn)continue;
  const parent=prepared.find(s=>s.job.account_id===spec.job.account_id&&s.job.task_key==='bili.vip_claim');
  if(parent)spec.dependsOn={jobId:parent.job.id,windowKey:parent.windowKey};
 }
 const statements:D1PreparedStatement[]=[...(options.before??[])];
 for(const spec of [...prepared].sort((a,b)=>Number(!!a.dependsOn)-Number(!!b.dependsOn)||a.index-b.index)){
  const dependency=spec.dependsOn;
  // A requested dependency must exist; a missing prerequisite cannot silently
  // become NULL and turn a guarded exchange into an independent transaction.
  const dependencySQL=dependency?"coalesce((SELECT id FROM job_runs WHERE job_id=? AND window_key=?),'missing-prerequisite')":'NULL';
  const select=' VALUES(?,?,?,?,?,?,?,?,'+dependencySQL+')';
  const args:unknown[]=[spec.runId,spec.job.owner_user_id,spec.job.id,spec.windowKey,'scheduled',spec.manual?1:0,spec.at??now,now];
  if(dependency)args.push(dependency.jobId,dependency.windowKey);
  statements.push(env.DB.prepare('INSERT OR IGNORE INTO job_runs(id,owner_user_id,job_id,window_key,status,manual,scheduled_for,created_at,depends_on_run_id)'+select).bind(...args));
  statements.push(env.DB.prepare("INSERT OR IGNORE INTO outbox(id,owner_user_id,kind,ref_id,payload_json,status,next_attempt_at,updated_at) SELECT ?,owner_user_id,'run',id,json_object('kind','run','id',id),'pending',?,? FROM job_runs WHERE job_id=? AND window_key=? AND status IN('scheduled','queued','running','waiting_retry')").bind(crypto.randomUUID(),now,now,spec.job.id,spec.windowKey));
 }
 statements.push(...(options.after??[]));
 await env.DB.batch(statements);
 const rows=await env.DB.prepare('SELECT id,job_id,window_key FROM job_runs WHERE owner_user_id=? AND ('+prepared.map(()=>'(job_id=? AND window_key=?)').join(' OR ')+')').bind(prepared[0].job.owner_user_id,...prepared.flatMap(s=>[s.job.id,s.windowKey])).all<{id:string;job_id:string;window_key:string}>();
 const ids=prepared.map(spec=>{const row=rows.results.find(r=>r.job_id===spec.job.id&&r.window_key===spec.windowKey);if(!row)throw new Error('Run batch prerequisite is missing');return row.id;});
 if(options.publish){
  // One dispatcher message avoids an HTTP request paying 3 D1 statements per
  // job just to publish. All intents are already durable if this send fails.
  await env.TASK_QUEUE.send({kind:'dispatch',id:crypto.randomUUID()}).catch(()=>{});
 }
 return ids;
}
