import type {Env} from './types.ts';
import {setSetting} from './db.ts';
// Recovery is driven by active targets, not every historical sent intent.
// CROSS JOIN keeps the small status-indexed target set on the outer loop.
export async function maintenance(env:Env){
 const now=Date.now();
 await env.DB.batch([
  env.DB.prepare("UPDATE notification_deliveries SET status='failed',last_error='Final delivery attempt was interrupted; manual retry may duplicate delivery',lease_token=NULL,lease_until=NULL WHERE id IN(SELECT id FROM notification_deliveries WHERE status='sending' AND attempts>=3 AND lease_until<? LIMIT 100)").bind(now),
  env.DB.prepare("UPDATE outbox SET status='pending',lease_token=NULL,lease_until=NULL,next_attempt_at=? WHERE id IN(SELECT id FROM outbox WHERE status='sending' AND lease_until<? LIMIT 100)").bind(now,now),
  env.DB.prepare(`UPDATE outbox SET status='pending',lease_token=NULL,lease_until=NULL,next_attempt_at=? WHERE id IN(
   SELECT o.id FROM job_runs r INDEXED BY ix_runs_status CROSS JOIN outbox o
   WHERE r.status IN('scheduled','queued','running','waiting_retry') AND o.kind='run' AND o.ref_id=r.id
   AND o.status='sent' AND o.updated_at<? LIMIT 100)`).bind(now,now-600000),
  env.DB.prepare(`UPDATE outbox SET status='pending',lease_token=NULL,lease_until=NULL,next_attempt_at=? WHERE id IN(
   SELECT o.id FROM notification_deliveries d INDEXED BY ix_deliveries_status CROSS JOIN outbox o
   WHERE d.status IN('queued','retry','sending') AND o.kind='notify' AND o.ref_id=d.id
   AND o.status='sent' AND o.updated_at<? LIMIT 100)`).bind(now,now-600000),
  env.DB.prepare("DELETE FROM outbox WHERE id IN(SELECT id FROM outbox WHERE status IN('done','dead','canceled') AND updated_at<? LIMIT 100)").bind(now-7*86400000),
  env.DB.prepare('DELETE FROM auth_challenges WHERE id IN(SELECT id FROM auth_challenges WHERE expires_at<? LIMIT 100)').bind(now),
  env.DB.prepare('DELETE FROM login_challenges WHERE id IN(SELECT id FROM login_challenges WHERE expires_at<? AND (lease_until IS NULL OR lease_until<=?) LIMIT 100)').bind(now,now),
  env.DB.prepare('DELETE FROM sessions WHERE id IN(SELECT id FROM sessions WHERE expires_at<? LIMIT 100)').bind(now-86400000),
  env.DB.prepare('DELETE FROM sessions WHERE id IN(SELECT id FROM sessions WHERE revoked_at IS NOT NULL AND revoked_at<? LIMIT 100)').bind(now-86400000),
  env.DB.prepare("DELETE FROM job_runs WHERE id IN (SELECT r.id FROM job_runs r JOIN jobs j ON j.id=r.job_id WHERE r.status IN ('succeeded','already_done','failed','canceled') AND r.created_at<? AND (j.task_key<>'bili.exchange' OR r.created_at<?) LIMIT 25)").bind(now-90*86400000,now-365*86400000),
  env.DB.prepare('DELETE FROM audit_logs WHERE id IN(SELECT id FROM audit_logs WHERE created_at<? LIMIT 100)').bind(now-365*86400000),
  env.DB.prepare('DELETE FROM usage_claims WHERE id IN(SELECT id FROM usage_claims WHERE created_at<? LIMIT 100)').bind(now-7*86400000),
  env.DB.prepare("DELETE FROM manual_resolutions WHERE run_id IN(SELECT run_id FROM manual_resolutions m WHERE cleanup_confirmed_at IS NOT NULL AND created_at<? AND NOT EXISTS(SELECT 1 FROM job_runs r WHERE r.id=m.run_id AND r.status NOT IN('succeeded','already_done','failed','canceled')) LIMIT 100)").bind(now-365*86400000),
  env.DB.prepare('DELETE FROM platform_run_requests WHERE request_key IN(SELECT request_key FROM platform_run_requests WHERE created_at<? LIMIT 100)').bind(now-7*86400000),
  env.DB.prepare('DELETE FROM run_usage_claims WHERE run_id IN(SELECT run_id FROM run_usage_claims WHERE created_at<? LIMIT 100)').bind(now-2*86400000),
  env.DB.prepare("DELETE FROM usage_daily WHERE day<date(?/1000,'unixepoch','-30 day')").bind(now),
 ]);
 await setSetting(env,'maintenance_heartbeat',now);
}
