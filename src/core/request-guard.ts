import type {Env} from './types.ts';
import {HttpError} from './response.ts';

// Cheap, bounded admission control before D1/DO. It supplements durable user
// limits and edge Access/WAF; isolate-local state is NOT a global security cap.
const buckets=new WeakMap<object,Map<string,{until:number;count:number}>>();
export async function boundedRequestBody(request:Request,maxBytes=65536):Promise<string>{
 const reader=request.body?.getReader();if(!reader)return '';
 let size=0,text='',timedOut=false;const decoder=new TextDecoder();
 const timer=setTimeout(()=>{timedOut=true;void reader.cancel().catch(()=>{});},10000);
 try{
  for(;;){const part=await reader.read();if(timedOut)throw new HttpError(408,'BODY_TIMEOUT','Request body transfer timed out');if(part.done)break;
   size+=part.value.byteLength;if(size>maxBytes)throw new HttpError(413,'BODY_TOO_LARGE','Request limit is 64 KiB');
   text+=decoder.decode(part.value,{stream:true});
  }
  return text+decoder.decode();
 }finally{clearTimeout(timer);await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export function earlyAdmission(env:Env,ip:string,now=Date.now()){
 let state=buckets.get(env.DB);if(!state){state=new Map();buckets.set(env.DB,state);}
 const key=ip.slice(0,100),old=state.get(key);
 if(old&&old.until>now){if(old.count>=120)throw new HttpError(429,'RATE_LIMIT','Too many API requests; try again shortly');old.count++;return;}
 if(state.size>=2048){for(const [k,v] of state){if(v.until<=now)state.delete(k);}if(state.size>=2048)state.delete(state.keys().next().value!);}
 state.set(key,{until:now+60000,count:1});
}

// Reject oversized collections before schema validators walk every member.
// The 64 KiB streamed body limit is separate; depth and issue amplification
// also need limits even when the wire payload is small.
export function assertJsonComplexity(value:unknown){
 const stack:Array<{value:unknown;depth:number}>=[{value,depth:0}];let nodes=0;
 while(stack.length){const entry=stack.pop()!;if(++nodes>2000||entry.depth>12)throw new HttpError(400,'INPUT_TOO_COMPLEX','Request contains too many nested values');
  if(!entry.value||typeof entry.value!=='object')continue;
  const entries=Object.entries(entry.value);
  if(entries.length>100)throw new HttpError(400,'COLLECTION_TOO_LARGE','A request collection may contain at most 100 items');
  for(const [key,item] of entries){if(['__proto__','prototype','constructor'].includes(key))throw new HttpError(400,'INVALID_FIELD','Unsupported object field');stack.push({value:item,depth:entry.depth+1});}
 }
}

export function routeMatcher(routes:ReadonlyArray<{method:string;path:string}>){
 const patterns=routes.filter(r=>r.method!=='ALL'&&r.path.startsWith('/api/')).map(r=>({method:r.method,re:new RegExp('^'+r.path.split('/').map(s=>s.startsWith(':')?'[^/]+':s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('/')+'$')}));
 return (method:string,path:string)=>path.length<=500&&patterns.some(p=>p.method===(method==='HEAD'?'GET':method)&&p.re.test(path));
}
