import test from 'node:test';
import assert from 'node:assert/strict';
import {pbkdf2Sync,randomBytes} from 'node:crypto';
import {hashPassword,verifyPassword,verifyAndUpgradePassword,passwordNeedsUpgrade} from '../src/core/password.ts';
import {PasswordHasher} from '../src/durable/password-hasher.ts';
import {passwordRpcSignature,beginAuthAttempt,finishAuthAttempt,hashPasswordForUser} from '../src/core/password-service.ts';
import {memoryStorage} from './helpers/d1.mjs';

function service(){
 const env={DATA_KEY:randomBytes(32).toString('base64url')},objects=new Map();
 env.PASSWORDS={idFromName:n=>n,get(name){if(!objects.has(name))objects.set(name,new PasswordHasher({storage:memoryStorage()},env));return {fetch:(input,init)=>objects.get(name).fetch(new Request(input,init))};}};
 return {env,objects};
}
async function signed(env,data){
 const body=JSON.stringify({...data,subject:'test',at:Date.now(),nonce:crypto.randomUUID()});
 return new Request('https://passwords.internal/rpc',{method:'POST',headers:{'Content-Type':'application/json','X-TaskHub-Signature':await passwordRpcSignature(env.DATA_KEY,body)},body});
}

test('600k PBKDF2 matches independent Node implementation and legacy hashes upgrade',async()=>{
 const password='独立标准验证 Password 2026',packed=await hashPassword(password);
 const [,iterations,salt,expected]=packed.split('$');
 assert.equal(Number(iterations),600000);
 assert.equal(pbkdf2Sync(password,Buffer.from(salt,'base64url'),600000,32,'sha256').toString('base64url'),expected);
 assert.equal(passwordNeedsUpgrade(packed),false);
 assert.equal(await verifyPassword('different-password',packed),false);
 const oldSalt=randomBytes(16),old=`pbkdf2$50000$${oldSalt.toString('base64url')}$${pbkdf2Sync(password,oldSalt,50000,32,'sha256').toString('base64url')}`;
 assert.equal(passwordNeedsUpgrade(old),true);
 const result=await verifyAndUpgradePassword(password,old);
 assert.equal(result.ok,true);assert.match(result.upgradedHash,/^pbkdf2\$600000\$/);
 const [,rounds,newSalt,newExpected]=result.upgradedHash.split('$');
 assert.equal(pbkdf2Sync(password,Buffer.from(newSalt,'base64url'),Number(rounds),32,'sha256').toString('base64url'),newExpected);
 assert.equal(await verifyPassword(password,'pbkdf2$1000001$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),false);
});

test('PasswordHasher requires signed bounded requests and refuses overlapping KDF work',async()=>{
 const {env}=service(),storage=memoryStorage(),hasher=new PasswordHasher({storage},env);
 const unsigned=new Request('https://passwords.internal/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:'hash',password:'NeverPersistPassword'})});
 assert.equal((await hasher.fetch(unsigned)).status,403);
 const tooLarge=new Request('https://passwords.internal/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:'x'.repeat(4097)});
 assert.equal((await hasher.fetch(tooLarge)).status,413);
 const requests=await Promise.all([signed(env,{kind:'hash',password:'NeverPersistPassword'}),signed(env,{kind:'hash',password:'NeverPersistPassword'})]);
 const results=await Promise.all(requests.map(r=>hasher.fetch(r)));
 assert.deepEqual(results.map(r=>r.status).sort(),[200,429]);
 assert.equal(storage.map.size,0,'KDF requests must not persist passwords or hashes');
});

test('account throttle normalizes username, bounds parallel attempts and expires backoff',async()=>{
 const {env,objects}=service(),clock=Date.now;let now=1760000000000;Date.now=()=>now;
 try{
  let attempt=await beginAuthAttempt(env,'Alice');
  await assert.rejects(beginAuthAttempt(env,' ALICE '),e=>e.status===429);
  await finishAuthAttempt(env,attempt,'failure');
  for(let i=0;i<2;i++){attempt=await beginAuthAttempt(env,'alice');await finishAuthAttempt(env,attempt,'failure');}
  await assert.rejects(beginAuthAttempt(env,'alice'),e=>e.status===429);
  now+=1001;attempt=await beginAuthAttempt(env,'alice');await finishAuthAttempt(env,attempt,'success');
  attempt=await beginAuthAttempt(env,'Alice');await finishAuthAttempt(env,attempt,'error');
  assert.equal(objects.size,1,'rotating username case must not create a fresh account budget');
  now+=16*60000;await [...objects.values()][0].alarm();
  attempt=await beginAuthAttempt(env,'alice');await finishAuthAttempt(env,attempt,'success');
 }finally{Date.now=clock;}
});

test('password RPC returns a current standard hash without storing plaintext',async()=>{
 const {env,objects}=service();const hash=await hashPasswordForUser(env,'user-id','Service password 2026');
 assert.match(hash,/^pbkdf2\$600000\$/);assert.equal(objects.size,1);
});
