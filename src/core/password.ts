import {pbkdf2Async} from '@noble/hashes/pbkdf2.js';
import {sha256 as sha256Hash} from '@noble/hashes/sha2.js';
import {toB64,fromB64} from './crypto.ts';

// Run this KDF inside PasswordHasher, never on the public Free-plan HTTP path.
// Standard PBKDF2-HMAC-SHA256, not repeated/concatenated shorter PBKDF2 calls.
// Local workerd's WebCrypto limit differs from the production runtime, so use
// the standard implementation consistently instead of silently lowering c.
export const PASSWORD_ITERATIONS=600000;
const HASH_BYTES=32;
type ParsedPassword={iterations:number;salt:Uint8Array;expected:Uint8Array};
function parsePassword(stored:string|null):ParsedPassword|null{
 if(typeof stored!=='string'||stored.length>256)return null;
 const parts=stored.split('$');
 if(parts.length!==4||parts[0]!=='pbkdf2')return null;
 const iterations=Number(parts[1]);
 if(!Number.isSafeInteger(iterations)||iterations<1000||iterations>1000000)return null;
 try{
  const salt=fromB64(parts[2]),expected=fromB64(parts[3]);
  if(salt.length<8||salt.length>64||expected.length!==HASH_BYTES)return null;
  return {iterations,salt,expected};
 }catch{return null;}
}
export function validPassword(value:string):boolean{return typeof value==='string'&&value.length>=1&&value.length<=128;}
export function passwordNeedsUpgrade(stored:string|null):boolean{
 const parsed=parsePassword(stored);return !!parsed&&parsed.iterations<PASSWORD_ITERATIONS;
}
async function derive(password:string,salt:Uint8Array,iterations:number){
 // Yield during CPU work so the DO can reject overlapping KDF requests.
 return pbkdf2Async(sha256Hash,password,salt,{c:iterations,dkLen:HASH_BYTES,asyncTick:8});
}
export async function hashPassword(password:string):Promise<string>{
 if(!validPassword(password))throw new Error('Invalid password length');
 const salt=crypto.getRandomValues(new Uint8Array(16));
 return `pbkdf2$${PASSWORD_ITERATIONS}$${toB64(salt)}$${toB64(await derive(password,salt,PASSWORD_ITERATIONS))}`;
}
export async function verifyPassword(password:string,stored:string|null):Promise<boolean>{
 if(typeof password!=='string'||password.length<1||password.length>128)return false;
 const parsed=parsePassword(stored);if(!parsed)return false;
 const actual=await derive(password,parsed.salt,parsed.iterations);
 let diff=0;for(let i=0;i<HASH_BYTES;i++)diff|=actual[i]^parsed.expected[i];
 actual.fill(0);return diff===0;
}
export async function verifyAndUpgradePassword(password:string,stored:string):Promise<{ok:boolean;upgradedHash?:string}>{
 const ok=await verifyPassword(password,stored);
 if(passwordNeedsUpgrade(stored)&&validPassword(password)){
  // Also do the stronger work after an unsuccessful legacy attempt, reducing
  // the difference in response time between legacy and current accounts.
  const replacement=await hashPassword(password);
  return ok?{ok:true,upgradedHash:replacement}:{ok:false};
 }
 return {ok};
}
