export interface Env {
  DB: D1Database;
  ACCOUNTS: DurableObjectNamespace;
  PASSWORDS: DurableObjectNamespace;
  TASK_QUEUE: Queue;
  ASSETS: Fetcher;
  DATA_KEY: string;
  BOOTSTRAP_TOKEN: string;
  APP_TITLE?: string;
  MAINTENANCE_MODE?: string;
  APP_ORIGIN?: string;
  IDENTITY_KEY?: string;
  DLQ_NAME?: string;
  API_PAUSED?: string;
  BACKGROUND_PAUSED?: string;
}
export type User = {id:string;username:string;role:'admin'|'user';status:'active'|'suspended'|'deleted';timezone:string;created_at:number;password_hash?:string|null};
export type CurrentUser = User & {sessionId:string;csrfHash:string;csrfToken?:string;recovery_password_reset_allowed?:boolean;recovery_password_reset_expires_at?:number|null};
export type AccountRecord = {id:string;owner_user_id:string;module_id:string;label:string;fingerprint:string;credentials_enc:string;config_json:string;enabled:number};
export type JobRecord = {id:string;owner_user_id:string;account_id:string;task_key:string;schedule_json:string;enabled:number;next_run_at:number|null};
export type QueueItem = {kind:'run'|'notify'|'dispatch'|'maintenance';id:string};
export type TaskResult = {status:'succeeded'|'already_done'|'failed'|'waiting_verification';summary:string;details?:Record<string,unknown>};
