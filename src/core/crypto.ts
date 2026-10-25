const enc = new TextEncoder();
export function randomToken(bytes=32):string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return toB64(b);
}
export function toB64(data:Uint8Array):string {
  let s='';for (const v of data) s+=String.fromCharCode(v);
  return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
export function fromB64(s:string):Uint8Array<ArrayBuffer> {
  const fixed=s.replace(/-/g,'+').replace(/_/g,'/');
  const raw=atob(fixed+'='.repeat((4-fixed.length%4)%4));
  return Uint8Array.from(raw,c=>c.charCodeAt(0));
}
export async function sha256(s:string):Promise<string> {
  return toB64(new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(s))));
}
export async function keyMaterial(secret:string, purpose:string):Promise<CryptoKey> {
  if(!secret || secret.length < 32) throw new Error('DATA_KEY 未设置或长度不足');
  // Explicit domain separation between encryption and fingerprint HMAC keys.
  const raw=fromB64(secret);
  if(raw.byteLength!==32) throw new Error('DATA_KEY 必须是 Base64URL 编码的 32 字节密钥');
  const base=await crypto.subtle.importKey('raw',raw,'HKDF',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:enc.encode('cf-task-hub-v1'),info:enc.encode(purpose)},base,purpose==='encryption'?{name:'AES-GCM',length:256}:{name:'HMAC',hash:'SHA-256',length:256},false,purpose==='encryption'?['encrypt','decrypt']:['sign']);
}
export async function encrypt(secret:string,owner:string,resource:string,payload:unknown):Promise<string> {
  const key=await keyMaterial(secret,'encryption');
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const data=enc.encode(JSON.stringify(payload));
  const aad=enc.encode(`v1:${owner}:${resource}`);
  const out=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad},key,data);
  return JSON.stringify({v:1,iv:toB64(iv),data:toB64(new Uint8Array(out))});
}
export async function decrypt<T>(secret:string,owner:string,resource:string,packed:string):Promise<T> {
  const parsed=JSON.parse(packed);
  if(parsed?.v!==1) throw new Error('加密记录版本不支持');
  const key=await keyMaterial(secret,'encryption');
  const aad=enc.encode(`v1:${owner}:${resource}`);
  const decrypted=await crypto.subtle.decrypt({name:'AES-GCM',iv:fromB64(parsed.iv),additionalData:aad},key,fromB64(parsed.data));
  return JSON.parse(new TextDecoder().decode(decrypted));
}
export async function fingerprint(secret:string,namespace:string,input:string):Promise<string> {
  const key=await keyMaterial(secret,'fingerprint');
  return toB64(new Uint8Array(await crypto.subtle.sign('HMAC',key,enc.encode(namespace+':'+input))));
}
export function redact(text:string):string {
  return String(text).replace(/(SESSDATA|bili_jct|BDUSS|BAIDU_COOKIE|cookie|sendkey|token|authorization)\s*[:=]\s*[^\s,;"}]+/gi,'$1=[REDACTED]').slice(0,1200);
}
