export const DEFAULT_QUOTAS={max_accounts:5,max_jobs:10,max_manual_runs:5,max_auto_runs:10,max_notifications:20,max_channels:5,max_invites:200,max_users:100};
export function resolveQuota(row:Record<string,unknown>|null,defaults:Partial<typeof DEFAULT_QUOTAS>=DEFAULT_QUOTAS){return {
 max_accounts:Number(row?.max_accounts??defaults.max_accounts??DEFAULT_QUOTAS.max_accounts),max_jobs:Number(row?.max_jobs??defaults.max_jobs??DEFAULT_QUOTAS.max_jobs),
 max_manual_runs:Number(row?.max_manual_runs??defaults.max_manual_runs??DEFAULT_QUOTAS.max_manual_runs),max_auto_runs:Number(row?.max_auto_runs??defaults.max_auto_runs??DEFAULT_QUOTAS.max_auto_runs),
 max_notifications:Number(row?.max_notifications??defaults.max_notifications??DEFAULT_QUOTAS.max_notifications),max_channels:Number(row?.max_channels??defaults.max_channels??DEFAULT_QUOTAS.max_channels)
};}
