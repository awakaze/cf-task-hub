import type {Env} from './types.ts';
// condition is internal, static SQL; all request values must be bound params.
export function mutationGuard(env:Env,condition:string,values:unknown[]){
 const id=crypto.randomUUID();
 return {
  before:env.DB.prepare(`INSERT INTO mutation_guards(id,ok) SELECT ?,CASE WHEN (${condition}) THEN 1 ELSE 0 END`).bind(id,...values),
  after:env.DB.prepare('DELETE FROM mutation_guards WHERE id=?').bind(id),
 };
}
