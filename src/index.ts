import {SessionExpiredError} from './core/identity.ts';
import {Hono} from 'hono';
import type {Env,CurrentUser,QueueItem} from './core/types.ts';
import {HttpError} from './core/response.ts';
import {currentUser,assertCsrf,registerAuthRoutes} from './api/auth.ts';
import {registerUserRoutes} from './api/user.ts';
import {registerPlatformRoutes} from './api/platforms.ts';
import {registerAdminRoutes} from './api/admin.ts';
import {scheduledTick,consumeMessage,deadLetter} from './core/scheduler.ts';
import {readiness} from './core/readiness.ts';
import {earlyAdmission,assertJsonComplexity,routeMatcher,boundedRequestBody} from './core/request-guard.ts';
import {takeRate} from './core/safety.ts';
export {AccountCoordinator} from './durable/account-coordinator.ts';
export {PasswordHasher} from './durable/password-hasher.ts';
type AppContext={Bindings:Env;Variables:{user:CurrentUser}};
export const app=new Hono<AppContext>();
let knownApiRoute:ReturnType<typeof routeMatcher>;
app.use('*',async(c,next)=>{
 c.header('X-Content-Type-Options','nosniff');c.header('Referrer-Policy','same-origin');
 c.header('Cache-Control','no-store');c.header('X-Frame-Options','DENY');
 c.header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'");
 if(c.req.path.startsWith('/api/')&&!['GET','HEAD','OPTIONS'].includes(c.req.method)){
  const origin=c.req.header('Origin');
  if(origin&&origin!==new URL(c.req.url).origin)throw new HttpError(403,'INVALID_ORIGIN','Cross-origin writes are not allowed');
  if(!origin&&c.req.header('Sec-Fetch-Site')==='cross-site')throw new HttpError(403,'INVALID_ORIGIN','Cross-origin writes are not allowed');
 }
 await next();
});
app.use('/api/*',async(c,next)=>{
 if(!knownApiRoute(c.req.method,c.req.path))return c.json({ok:false,error:'NOT_FOUND',message:'Route not found'},404);
 if(c.env.API_PAUSED==='true')return c.json({ok:false,error:'API_PAUSED',message:'API access is temporarily paused'},503);
 earlyAdmission(c.env,c.req.header('CF-Connecting-IP')||'local');
 await next();
});
// Always count actual streamed bytes, including when Content-Length is present.
app.use('/api/*',async(c,next)=>{
 if(!['GET','HEAD','OPTIONS'].includes(c.req.method)&&c.req.raw.body){
  const raw=await boundedRequestBody(c.req.raw);
  // Reconstruct the bounded body through the public Request API. Hono owns
  // its body cache; its runtime cache values differ from the exposed typings.
  c.req.raw=new Request(c.req.raw,{body:raw});
  if(raw.trim()){let body:unknown;try{body=await c.req.json();}catch{throw new HttpError(400,'INVALID_JSON','A valid JSON request body is required');}assertJsonComplexity(body);}
 }
 await next();
});
app.use('/api/*',async(c,next)=>{
 const ready=await readiness(c.env);
 if(!ready.ready)return c.json({ok:false,error:'SETUP_REQUIRED',message:ready.reason,ready:false},503);
 await next();
});
app.use('/api/v1/*',async(c,next)=>{
 if(c.req.path.startsWith('/api/v1/auth/'))return next();
 const u=await currentUser(c);c.set('user',u);await assertCsrf(c,u);
 if(!['GET','HEAD','OPTIONS'].includes(c.req.method)&&!/^\/api\/v1\/platforms\/[^/]+\/qr\/[^/]+\/poll$/.test(c.req.path)){
  await takeRate(c.env,'api-write:'+u.id,60,60000);
  await takeRate(c.env,'api-write-day:'+u.id,500,86400000);
  await takeRate(c.env,'api-write-global:all',1200,86400000);
 }
 await next();
});
registerAuthRoutes(app);registerUserRoutes(app);registerPlatformRoutes(app);registerAdminRoutes(app);
knownApiRoute=routeMatcher(app.routes);
app.get('/health',c=>c.json({ok:true,service:'cf-task-hub',version:'0.1.0',meaning:'HTTP handler only; login/setup API checks readiness'}));
app.notFound(c=>c.json({ok:false,error:'NOT_FOUND',message:'Route not found'},404));
app.onError((err,c)=>{
 if(err instanceof SessionExpiredError)return c.json({ok:false,error:'UPSTREAM_SESSION_EXPIRED',message:'Platform login expired; update the platform Cookie, not your Task Hub login.'},422);
 if(err instanceof HttpError)return c.json({ok:false,error:err.code,message:err.detail},err.status as any);
 if((err as any)?.name==='ZodError')return c.json({ok:false,error:'VALIDATION_ERROR',message:'Invalid request fields',details:(err as any).issues?.slice(0,10).map((x:any)=>({path:x.path?.slice(0,6).map((p:any)=>String(p).slice(0,80)),message:String(x.message).slice(0,160)}))},400);
 if(err instanceof SyntaxError)return c.json({ok:false,error:'INVALID_JSON',message:'Invalid JSON request'},400);
 const msg=err instanceof Error?err.message:'';
 if(msg.includes('mutation_guard_valid'))return c.json({ok:false,error:'RESOURCE_CHANGED',message:'账号、权限或扫码会话已变化，本次修改已全部回滚，请刷新后重试'},409);
 if(msg.includes('unsettled_run_limit'))return c.json({ok:false,error:'UNSETTLED_RUN_LIMIT',message:'该平台账号已有3个排队、执行中或待核对任务，请先完成或处理后再新建运行'},429);
 if(/limit|quota/i.test(msg)&&/D1|SQLITE|constraint|_limit/i.test(msg))return c.json({ok:false,error:'QUOTA_EXCEEDED',message:'Resource or daily platform quota reached'},429);
 if(/unsettled_account|unsettled_job|last_passkey/.test(msg))return c.json({ok:false,error:'PROTECTED_RESOURCE',message:'Unsettled work or security credentials prevent this change'},409);
 if(/constraint|SQLITE_CONSTRAINT/i.test(msg))return c.json({ok:false,error:'CONFLICT',message:'Resource conflict or ownership validation failed'},409);
 console.error('Task Hub error',err instanceof Error?err.name:'unknown');
 return c.json({ok:false,error:'INTERNAL_ERROR',message:'Request failed; sensitive details are not exposed'},500);
});
export default {
 fetch:(request:Request,env:Env,ctx:ExecutionContext)=>app.fetch(request,env,ctx),
 async scheduled(_event:ScheduledEvent,env:Env,ctx:ExecutionContext){
  ctx.waitUntil((async()=>{if(env.BACKGROUND_PAUSED==='true'||!(await readiness(env)).ready)return;
   await env.TASK_QUEUE.send({kind:'maintenance',id:crypto.randomUUID()});await scheduledTick(env);
  })());
 },
 async queue(batch:MessageBatch<QueueItem>,env:Env,_ctx:ExecutionContext){
  // A paused delivery is recoverable from its durable outbox after resuming.
  // Acknowledge instead of generating a retry/DLQ storm while intentionally
  // paused. Dispatch/maintenance messages are regenerated by the next Cron.
  if(env.BACKGROUND_PAUSED==='true'){batch.ackAll();return;}
  if(!(await readiness(env)).ready){batch.retryAll({delaySeconds:300});return;}
  for(const message of batch.messages){
   try{if(batch.queue===(env.DLQ_NAME||'cf-task-hub-dlq'))await deadLetter(env,message.body);else await consumeMessage(env,message.body);message.ack();}
   catch{message.retry({delaySeconds:60});}
  }
 }
};
