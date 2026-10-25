// Complete application in real Wrangler/workerd, using only synthetic users.
// A stable private copy prevents editor changes and existing local resources
// from changing the test halfway through. Remote resources are untouched.
import {spawn} from 'node:child_process';
import {cpSync,existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';

const project=fileURLToPath(new URL('../',import.meta.url));
const wrangler=join(project,'node_modules/wrangler/bin/wrangler.js');
if(!existsSync(wrangler))throw Error('Install dependencies first');
if(!existsSync(join(project,'web/dist/index.html')))throw Error('Run npm run build first');
const parsed=ts.parseConfigFileTextToJson('wrangler.jsonc',readFileSync(join(project,'wrangler.jsonc'),'utf8'));
if(parsed.error||!parsed.config)throw Error('Cannot parse the project Wrangler configuration');
const workspace=mkdtempSync(join(tmpdir(),'cf-task-hub-smoke-'));
const state=resolve(workspace,'local-state'),configPath=join(workspace,'wrangler.json');
const keepWorkspace=process.env.TASK_HUB_SMOKE_KEEP_WORKSPACE==='1';
const childEnv={...process.env,WRANGLER_SEND_METRICS:'false',CI:'true',NO_COLOR:'1',FORCE_COLOR:'0'};
const children=new Set();let worker;

async function unusedPort(){
 const server=createServer();await new Promise((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});
 const port=server.address().port;await new Promise((yes,no)=>server.close(error=>error?no(error):yes()));return port;
}
function launch(args,{capture=false}={}){
 const child=spawn(process.execPath,[wrangler,...args,'--config',configPath],{cwd:workspace,env:childEnv,stdio:capture?['ignore','pipe','pipe']:['ignore','inherit','inherit'],detached:process.platform!=='win32'});
 children.add(child);child.once('exit',()=>children.delete(child));return child;
}
async function stop(child){
 if(!child?.pid)return;
 const signal=kind=>{try{if(process.platform==='win32')child.kill(kind);else process.kill(-child.pid,kind);}catch(error){if(error.code!=='ESRCH')throw error;}};
 signal('SIGTERM');
 if(child.exitCode===null&&child.signalCode===null)await Promise.race([new Promise(done=>child.once('exit',done)),new Promise(done=>setTimeout(done,3000))]);
 // Only this test's process group, including any remaining workerd child.
 signal('SIGKILL');
}
async function command(args,{json=false}={}){
 const child=launch(args,{capture:json});let output='';
 if(json){child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.resume();}
 const timer=setTimeout(()=>{void stop(child);},60000);
 try{
  const code=await new Promise((yes,no)=>{child.once('error',no);child.once('exit',yes);});
  if(code!==0)throw Error(`Local Wrangler command failed (${args.slice(0,3).join(' ')}, exit ${String(code)})`);
  if(json){try{return JSON.parse(output);}catch{throw Error('Local D1 verification did not return JSON');}}
 }finally{clearTimeout(timer);await stop(child);}
}
// Never print arbitrary response bodies, passwords, recovery codes, Cookies,
// session values, or database password hashes during failure diagnosis.
const safeMessages=new Set([
 'Database migration required: run npm run db:remote','D1 binding or database initialization unavailable',
 'Set a valid DATA_KEY in Cloudflare Secrets','Deploy the PASSWORDS Durable Object binding',
 'Set BOOTSTRAP_TOKEN before the first administrator registration','Authentication service temporarily unavailable',
 'Password service binding is unavailable','Configure the final HTTPS APP_ORIGIN before using authentication',
 'APP_ORIGIN must contain only the approved origin','Use the configured login domain',
 'Request failed; sensitive details are not exposed','API access is temporarily paused'
]);
async function expect(response,expected,label){
 if(response.status!==expected){
  const body=await response.clone().json().catch(()=>({}));
  const code=typeof body.error==='string'&&/^[A-Z0-9_]{1,64}$/.test(body.error)?body.error:'UNKNOWN';
  const message=safeMessages.has(body.message)?body.message:'response detail omitted';
  throw Error(`${label}: expected HTTP ${expected}, got ${response.status}; ${code}; ${message}`);
 }
 console.log(`Smoke: ${label} (${response.status})`);return response;
}
async function sessionFrom(response){
 const body=await response.json(),cookies=response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
 if(typeof body.csrf!=='string'||!cookies.includes('th_session=')||!cookies.includes('th_csrf='))throw Error('Authentication session response incomplete');
 return {body,csrf:body.csrf,cookies};
}
try{
 for(const directory of ['src','migrations','web/dist'])cpSync(join(project,directory),join(workspace,directory),{recursive:true});
 for(const file of ['package.json','tsconfig.json'])cpSync(join(project,file),join(workspace,file));
 symlinkSync(join(project,'node_modules'),join(workspace,'node_modules'),process.platform==='win32'?'junction':'dir');
 mkdirSync(state,{recursive:true});
 const port=await unusedPort(),inspectorPort=await unusedPort(),base=`http://127.0.0.1:${port}`;
 const localConfig={...parsed.config,name:'cf-task-hub-smoke',workers_dev:false};
 const database=localConfig.d1_databases?.find(binding=>binding.binding==='DB');
 if(!database)throw Error('The application DB binding is missing');
 // Migrations and dev use the same explicitly local database ID.
 database.database_id='11111111-1111-4111-8111-111111111111';database.preview_database_id=database.database_id;database.remote=false;
 for(const binding of localConfig.queues?.producers||[])binding.remote=false;
 writeFileSync(configPath,JSON.stringify(localConfig,null,2));
 const bootstrap=randomBytes(32).toString('base64url'),password='Smoke-'+randomBytes(24).toString('base64url');
 writeFileSync(join(workspace,'.dev.vars'),`DATA_KEY=${randomBytes(32).toString('base64url')}\nIDENTITY_KEY=${randomBytes(32).toString('base64url')}\nBOOTSTRAP_TOKEN=${bootstrap}\nAPP_ORIGIN=${base}\nAPI_PAUSED=false\nBACKGROUND_PAUSED=false\n`,{flag:'wx',mode:0o600});
 await command(['d1','migrations','apply','DB','--local','--persist-to',state]);
 const expectedMigrations=readdirSync(join(workspace,'migrations')).filter(name=>name.endsWith('.sql')).length;
 const verification=await command(['d1','execute','DB','--local','--persist-to',state,'--json','--command',"SELECT CAST(value_json AS INTEGER) AS schema_version FROM system_settings WHERE key='schema_version'; SELECT count(*) AS migration_count FROM d1_migrations; SELECT count(*) AS guard_tables FROM sqlite_master WHERE type='table' AND name='mutation_guards';"],{json:true});
 const rows=verification.flatMap(result=>result.results||[]);
 const schema=rows.find(row=>Object.hasOwn(row,'schema_version'))?.schema_version;
 const applied=rows.find(row=>Object.hasOwn(row,'migration_count'))?.migration_count;
 const guards=rows.find(row=>Object.hasOwn(row,'guard_tables'))?.guard_tables;
 if(schema!==8||applied!==expectedMigrations||guards!==1)throw Error(`Persisted local migrations incomplete: schema ${String(schema)} (expected 8), migrations ${String(applied)} (expected ${expectedMigrations}), guard table ${String(guards)} (expected 1)`);
 console.log(`Smoke: persisted D1 schema ${schema}, all ${applied} migrations verified by an independent local query`);
 worker=launch(['dev','--local','--ip','127.0.0.1','--port',String(port),'--inspector-port',String(inspectorPort),'--persist-to',state]);
 const fetchLocal=(path,init={})=>fetch(base+path,{...init,signal:AbortSignal.timeout(30000)});
 let healthy=false;
 for(let attempt=0;attempt<60;attempt++){
  if(worker.exitCode!==null||worker.signalCode!==null)throw Error('Local Wrangler exited before becoming healthy');
  try{if((await fetchLocal('/health')).ok){healthy=true;break;}}catch{}
  await new Promise(done=>setTimeout(done,500));
 }
 if(!healthy)throw Error('Local worker did not become healthy');
 const home=await expect(await fetchLocal('/'),200,'static application');
 if(!(await home.text()).includes('id="app"'))throw Error('Static application HTML incomplete');
 const setup=await expect(await fetchLocal('/api/v1/auth/setup-status'),200,'migrated readiness/setup');
 if((await setup.json()).needsSetup!==true)throw Error('The isolated database was not empty');
 await expect(await fetchLocal('/api/v1/me'),401,'private API requires authentication');
 const post=(path,body,session)=>fetchLocal(path,{method:'POST',headers:{'Content-Type':'application/json',Origin:base,...(session?{Cookie:session.cookies,'X-CSRF-Token':session.csrf}:{})},body:JSON.stringify(body)});
 const registered=await expect(await post('/api/v1/auth/register/password',{username:'smoke_admin',password,bootstrapToken:bootstrap}),201,'synthetic administrator registration');
 const first=await sessionFrom(registered);
 if(first.body.user.role!=='admin'||first.body.recoveryCodes?.length!==8)throw Error('Registration response incomplete');
 const login=await expect(await post('/api/v1/auth/login/password',{username:'smoke_admin',password}),200,'real PASSWORDS Durable Object login');
 const active=await sessionFrom(login);
 const me=await expect(await fetchLocal('/api/v1/me',{headers:{Cookie:active.cookies,Origin:base}}),200,'authenticated profile');
 if((await me.json()).user.role!=='admin')throw Error('Administrator profile mismatch');
 await expect(await post('/api/v1/auth/logout',{},active),200,'logout');
 await expect(await fetchLocal('/api/v1/me',{headers:{Cookie:active.cookies,Origin:base}}),401,'logout revokes the session');
 const recovered=await expect(await post('/api/v1/auth/recover',{username:'smoke_admin',code:first.body.recoveryCodes[0]}),200,'single-use recovery code login');
 const recoveredSession=await sessionFrom(recovered),newPassword='Changed-'+randomBytes(24).toString('base64url');
 if(!recoveredSession.body.user.recovery_password_reset_allowed)throw Error('Recovery password reset grant missing');
 await expect(await fetchLocal('/api/v1/me',{headers:{Cookie:first.cookies,Origin:base}}),401,'recovery revokes the other session');
 await expect(await post('/api/v1/auth/password',{newPassword,recoveryReset:true},recoveredSession),200,'forgotten-password reset');
 await expect(await post('/api/v1/auth/password',{newPassword,recoveryReset:true},recoveredSession),403,'reset grant cannot be reused');
 await expect(await post('/api/v1/auth/login/password',{username:'smoke_admin',password}),401,'old password is rejected');
 await expect(await post('/api/v1/auth/login/password',{username:'smoke_admin',password:newPassword}),200,'new password login');
 console.log('Real local Wrangler/workerd smoke passed: stable application snapshot; assets; persisted migrations; D1 and PASSWORDS binding; 600000-iteration registration/login; session revocation; single-use recovery password reset. No browser Passkey or live upstream business action was tested.');
}finally{
 for(const child of [...children])await stop(child);
 if(worker)await stop(worker);
 rmSync(join(workspace,'.dev.vars'),{force:true});
 if(keepWorkspace)console.log(`Synthetic smoke workspace retained for diagnosis (temporary secrets removed): ${workspace}`);
 else rmSync(workspace,{recursive:true,force:true});
}
