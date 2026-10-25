import {baiduManifest,executeBaidu,probeBaidu,reconcileBaidu} from '../modules/baidu-netdisk/adapter.ts';
import {bilibiliManifest,executeBili,reconcileBili,probeBili} from '../modules/bilibili/adapter.ts';
import type {TaskResult} from './types.ts';
import {HttpError} from './response.ts';
export type ConfigField={key:string;title:string;type:'boolean'|'integer';default:boolean|number;min?:number;max?:number};
export type ModuleContext={taskKey:string;credentials:Record<string,unknown>;settings:Record<string,unknown>;load:()=>Promise<any>;save:(r:any)=>Promise<void>;fetcher?:typeof fetch};
const shared:ConfigField[]=[{key:'timeout_ms',title:'请求超时（毫秒）',type:'integer',default:15000,min:500,max:60000},{key:'retry_minutes',title:'失败重试间隔（分钟）',type:'integer',default:30,min:1,max:1440}];
export const moduleDefinitions=[
 {manifest:{...baiduManifest,version:'0.1.0',credentialSchema:[{key:'cookie',type:'secret',required:true},{key:'cuid',type:'secret',required:false},{key:'headers',type:'json',required:false}],configSchema:[{key:'enable_pc',title:'PC 端签到',type:'boolean',default:true},{key:'enable_app',title:'App 端签到',type:'boolean',default:true},{key:'enable_awards',title:'累计奖励领取',type:'boolean',default:true},...shared] as ConfigField[]},run:executeBaidu,probe:probeBaidu,reconcile:reconcileBaidu},
 {manifest:{...bilibiliManifest,version:'0.1.0',credentialSchema:[{key:'cookie',type:'secret',required:true}],configSchema:[...shared,{key:'settle_wait_ms',title:'余额结算等待（毫秒）',type:'integer',default:1200,min:0,max:10000},{key:'max_exchange_bp',title:'单次最多兑换 B 币券数',type:'integer',default:5,min:1,max:20}] as ConfigField[]},run:executeBili,probe:probeBili,reconcile:reconcileBili}
];
export const manifests=moduleDefinitions.map(m=>m.manifest);
export function moduleDefinition(id:string){return moduleDefinitions.find(m=>m.manifest.id===id);}
export function taskMatches(moduleId:string,taskKey:string){return manifests.find(m=>m.id===moduleId)?.tasks.some(t=>t.key===taskKey)||false;}
export function taskManifest(taskKey:string){for(const m of manifests){const task=m.tasks.find(t=>t.key===taskKey);if(task)return {...task,module_id:m.id};}return null;}
export function validateModuleSettings(moduleId:string,raw:unknown):Record<string,boolean|number>{
 const mod=moduleDefinition(moduleId);if(!mod)throw new HttpError(400,'INVALID_MODULE','Unknown module');
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new HttpError(400,'INVALID_CONFIG','Settings must be an object');
 const fields=mod.manifest.configSchema,out:Record<string,boolean|number>={};
 for(const [key,value]of Object.entries(raw)){
  const field=fields.find(f=>f.key===key);if(!field)throw new HttpError(400,'INVALID_CONFIG','Unknown module setting: '+key);
  if(field.type==='boolean'){if(typeof value!=='boolean')throw new HttpError(400,'INVALID_CONFIG','Expected boolean: '+key);out[key]=value;}
  else {if(typeof value!=='number'||!Number.isSafeInteger(value)||value<(field.min??0)||value>(field.max??Number.MAX_SAFE_INTEGER))throw new HttpError(400,'INVALID_CONFIG','Invalid integer setting: '+key);out[key]=value;}
 }
 return out;
}
