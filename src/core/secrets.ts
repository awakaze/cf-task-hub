import type {Env} from './types.ts';
import {decrypt} from './crypto.ts';
export async function decryptConfig<T>(env:Env,owner:string,resource:string,packed:string):Promise<T>{
 return decrypt<T>(env.DATA_KEY,owner,resource,packed);
}
