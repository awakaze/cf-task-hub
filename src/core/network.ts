// Read a bounded body including the body-transfer time, not only response headers.
export async function boundedText(response:Response,maxBytes=131072):Promise<string>{
 const reader=response.body?.getReader();if(!reader)return '';
 const decoder=new TextDecoder();let total=0,text='';
 try{for(;;){const item=await reader.read();if(item.done)break;total+=item.value.byteLength;
  if(total>maxBytes)throw new Error('Response exceeds size limit');
  text+=decoder.decode(item.value,{stream:true});}return text+decoder.decode();
 }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export async function boundedJson(response:Response,maxBytes=131072):Promise<any>{return JSON.parse(await boundedText(response,maxBytes));}
export function identityNumber(value:unknown):string{
 if(typeof value==='number'){if(!Number.isSafeInteger(value)||value<=0)throw new Error('Invalid upstream account identifier');return String(value);}
 if(typeof value!=='string'||!/^\d{1,24}$/.test(value)||/^0+$/.test(value))throw new Error('Invalid upstream account identifier');
 return value.replace(/^0+/,'');
}
export function cookieInput(value:unknown):string{
 if(typeof value!=='string'||value.length<10||value.length>16000||/[\r\n\0]/.test(value))throw new Error('Invalid cookie format');
 return value.trim();
}
