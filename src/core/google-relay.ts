import type {Env} from './types.ts';

/**
 * Optional Google Apps Script HTTPS relay.
 * This module is isolated from business logic and is selected only when
 * GOOGLE_RELAY_ENABLED is exactly the string "true".
 */
const MAX_REQUEST_BYTES=700_000;
const MAX_RESPONSE_BYTES=700_000;
const MAX_ENVELOPE_CHARS=1_050_000;
const MAX_HEADER_CHARS=7_000;
const MAX_URL_LENGTH=2_082;
const MAX_REDIRECTS=5;
const BLOCKED_REQUEST_HEADERS=new Set([
 'host','content-length','connection','keep-alive','transfer-encoding',
 'accept-encoding','proxy-authorization','proxy-connection',
 'proxy-authenticate','te','trailer','upgrade','expect','forwarded'
]);
const BLOCKED_RESPONSE_HEADERS=new Set([
 'content-length','content-encoding','connection','keep-alive',
 'transfer-encoding','proxy-authenticate','proxy-authorization',
 'te','trailer','upgrade'
]);
const SENSITIVE_HEADERS=[
 'authorization','cookie','proxy-authorization','x-api-key',
 'x-auth-token','x-access-token','x-csrf-token'
];

export function createGoogleRelayFetch(env:Env):typeof fetch{
 const relayUrl=String(env.GOOGLE_RELAY_URL||'');
 const secret=String(env.GOOGLE_RELAY_HMAC_SECRET||'');
 if(!relayUrl||secret.length<32)throw new Error('GOOGLE_RELAY_CONFIG_MISSING');
 const endpoint=new URL(relayUrl);
 if(endpoint.protocol!=='https:'||endpoint.hostname!=='script.google.com'||endpoint.username||endpoint.password||(endpoint.port&&endpoint.port!=='443')||endpoint.pathname.length>1800||!/^\/macros\/s\/[^/]+\/exec$/.test(endpoint.pathname)||endpoint.search||endpoint.hash){
  throw new Error('GOOGLE_RELAY_URL_INVALID');
 }
 return (input:RequestInfo|URL,init?:RequestInit)=>googleRelayFetch(input,init,relayUrl,secret);
}

async function googleRelayFetch(input:RequestInfo|URL,init:RequestInit|undefined,relayUrl:string,secret:string):Promise<Response>{
 const request=input instanceof Request?(init?new Request(input,init):input.clone()):new Request(input,init);
 let currentUrl=validateTargetUrl(request.url);
 let method=request.method.toUpperCase();
 if(!['GET','POST','PUT','PATCH','DELETE'].includes(method))throw new Error('GOOGLE_RELAY_METHOD_UNSUPPORTED');
 let headers=cleanHeaders(new Headers(request.headers));
 let headerChars=0;
 for(const [name,value] of headers.entries())headerChars+=name.length+value.length;
 if(headerChars>MAX_HEADER_CHARS)throw new Error('GOOGLE_RELAY_HEADERS_TOO_LARGE');
 let bodyBytes:Uint8Array|null=null;
 if(request.body){
  const buffer=await request.arrayBuffer();
  if(buffer.byteLength>MAX_REQUEST_BYTES)throw new Error('GOOGLE_RELAY_REQUEST_TOO_LARGE');
  bodyBytes=new Uint8Array(buffer);
 }
 if(method==='GET'&&bodyBytes?.length)throw new Error('GOOGLE_RELAY_GET_BODY_NOT_ALLOWED');
 const redirectMode=request.redirect;
 for(let redirects=0;redirects<=MAX_REDIRECTS;redirects++){
  const result=await sendSignedRequest({url:currentUrl.href,method,headers,bodyBytes,signal:request.signal,relayUrl,secret});
  const status=Number(result.status);
  const location=readHeader(result.headers,'location');
  const isRedirect=[301,302,303,307,308].includes(status)&&!!location;
  if(isRedirect&&redirectMode==='error')throw new Error('GOOGLE_RELAY_REDIRECT_BLOCKED');
  if(isRedirect&&redirectMode!=='manual'){
   if(redirects===MAX_REDIRECTS)throw new Error('GOOGLE_RELAY_TOO_MANY_REDIRECTS');
   const nextUrl=validateTargetUrl(new URL(String(location),currentUrl.href).href);
   if(nextUrl.origin!==currentUrl.origin)for(const name of SENSITIVE_HEADERS)headers.delete(name);
   if(status===303||((status===301||status===302)&&method==='POST')){
    method='GET';bodyBytes=null;headers.delete('content-type');
   }
   currentUrl=nextUrl;
   continue;
  }
  return restoreUpstreamResponse(result);
 }
 throw new Error('GOOGLE_RELAY_TOO_MANY_REDIRECTS');
}

async function sendSignedRequest(args:{url:string;method:string;headers:Headers;bodyBytes:Uint8Array|null;signal:AbortSignal;relayUrl:string;secret:string}):Promise<any>{
 const payload=JSON.stringify({
  url:args.url,
  method:args.method,
  headers:Object.fromEntries(args.headers.entries()),
  bodyB64:args.bodyBytes===null?null:bytesToBase64(args.bodyBytes)
 });
 const timestamp=String(Date.now());
 const nonce=crypto.randomUUID();
 const signingText=timestamp+'\n'+nonce+'\n'+payload;
 const signature=await hmacHex(args.secret,signingText);
 const envelope=timestamp+'\n'+nonce+'\n'+signature+'\n'+payload;
 if(envelope.length>MAX_ENVELOPE_CHARS)throw new Error('GOOGLE_RELAY_ENVELOPE_TOO_LARGE');
 const postResponse=await fetch(args.relayUrl,{
  method:'POST',
  headers:{'Content-Type':'text/plain;charset=UTF-8'},
  body:envelope,
  redirect:'manual',
  signal:args.signal
 });
 const responseText=await readContentServiceResponse(postResponse,args.relayUrl,args.signal);
 let result:any;
 try{result=JSON.parse(responseText);}catch{throw new Error('GOOGLE_RELAY_INVALID_RESPONSE');}
 if(!result||result.ok!==true){
  const code=typeof result?.error==='string'&&/^[A-Z0-9_]{1,80}$/.test(result.error)?result.error:'UNKNOWN';
  throw new Error('GOOGLE_RELAY_UPSTREAM_ERROR_'+code);
 }
 return result;
}

async function readContentServiceResponse(response:Response,relayUrl:string,signal:AbortSignal):Promise<string>{
 if([301,302,303,307,308].includes(response.status)){
  const location=response.headers.get('Location');
  if(!location)throw new Error('GOOGLE_RELAY_REDIRECT_WITHOUT_LOCATION');
  const contentUrl=new URL(location,relayUrl);
  if(contentUrl.protocol!=='https:'||contentUrl.hostname!=='script.googleusercontent.com')throw new Error('GOOGLE_RELAY_UNEXPECTED_REDIRECT');
  const contentResponse=await fetch(contentUrl.href,{method:'GET',redirect:'follow',signal});
  if(!contentResponse.ok)throw new Error('GOOGLE_RELAY_CONTENT_FETCH_FAILED');
  const text=await contentResponse.text();
  if(text.length>MAX_ENVELOPE_CHARS)throw new Error('GOOGLE_RELAY_RESPONSE_ENVELOPE_TOO_LARGE');
  return text;
 }
 if(!response.ok)throw new Error('GOOGLE_RELAY_HTTP_'+response.status);
 const text=await response.text();
 if(text.length>MAX_ENVELOPE_CHARS)throw new Error('GOOGLE_RELAY_RESPONSE_ENVELOPE_TOO_LARGE');
 return text;
}

function restoreUpstreamResponse(result:any):Response{
 const status=Number(result.status);
 if(!Number.isInteger(status)||status<200||status>599||status===101)throw new Error('GOOGLE_RELAY_INVALID_UPSTREAM_STATUS');
 const headers=new Headers();
 for(const [name,value] of Object.entries(result.headers||{})){
  const lower=name.toLowerCase();
  if(BLOCKED_RESPONSE_HEADERS.has(lower))continue;
  if(Array.isArray(value))for(const item of value)headers.append(name,String(item));
  else headers.set(name,String(value));
 }
 const bytes=base64ToBytes(String(result.bodyB64||''));
 if(bytes.byteLength>MAX_RESPONSE_BYTES)throw new Error('GOOGLE_RELAY_RESPONSE_TOO_LARGE');
 const body=[204,205,304].includes(status)?null:bytes;
 return new Response(body,{status,headers});
}

function validateTargetUrl(rawUrl:string):URL{
 if(typeof rawUrl!=='string'||rawUrl.length>MAX_URL_LENGTH||/[\r\n\\]/.test(rawUrl))throw new Error('GOOGLE_RELAY_INVALID_URL');
 let url:URL;try{url=new URL(rawUrl);}catch{throw new Error('GOOGLE_RELAY_INVALID_URL');}
 if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443'))throw new Error('GOOGLE_RELAY_HTTPS_ONLY');
 const host=url.hostname.toLowerCase();
 const hostnamePattern=/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
 if(!hostnamePattern.test(host)||/^[0-9.]+$/.test(host)||host==='localhost'||host==='metadata'||host==='metadata.google.internal')throw new Error('GOOGLE_RELAY_BLOCKED_HOST');
 const blocked=['.localhost','.local','.internal','.test','.invalid','.example','.onion','.home','.lan'];
 if(blocked.some(suffix=>host.endsWith(suffix)))throw new Error('GOOGLE_RELAY_BLOCKED_HOST');
 return url;
}

function cleanHeaders(headers:Headers):Headers{
 for(const name of [...headers.keys()]){
  const lower=name.toLowerCase();
  if(BLOCKED_REQUEST_HEADERS.has(lower)||lower.startsWith('cf-')||lower.startsWith('x-forwarded-'))headers.delete(name);
 }
 return headers;
}

function readHeader(headers:Record<string,unknown>,name:string):string|null{
 const key=Object.keys(headers||{}).find(item=>item.toLowerCase()===name.toLowerCase());
 if(!key)return null;
 const value=headers[key];return Array.isArray(value)?String(value[0]??''):String(value??'');
}

async function hmacHex(secret:string,message:string):Promise<string>{
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const signature=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(message));
 return [...new Uint8Array(signature)].map(value=>value.toString(16).padStart(2,'0')).join('');
}

function bytesToBase64(bytes:Uint8Array):string{
 let binary='';for(let offset=0;offset<bytes.length;offset+=0x8000)binary+=String.fromCharCode(...bytes.subarray(offset,offset+0x8000));
 return btoa(binary);
}

function base64ToBytes(value:string):Uint8Array<ArrayBuffer>{
 const binary=atob(value);const bytes=new Uint8Array(binary.length);
 for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
 return bytes;
}
