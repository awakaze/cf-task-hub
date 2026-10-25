import test from 'node:test';
import assert from 'node:assert/strict';
import {zoneDate,nextDaily,zonedParts} from '../src/core/time.ts';
import {DEFAULT_POLICY,routeChannels,validateWebhookTarget} from '../src/core/notifications.ts';
import {randomToken,sha256,encrypt,decrypt,fingerprint} from '../src/core/crypto.ts';

test('Daily scheduler uses IANA time zones',()=>{
 const at=Date.parse('2026-10-25T00:01:00Z');
 assert.equal(new Date(nextDaily('Asia/Tokyo',10,0,at)).toISOString(),'2026-10-25T01:00:00.000Z');
 assert.equal(new Date(nextDaily('Asia/Shanghai',11,30,at)).toISOString(),'2026-10-25T03:30:00.000Z');
 assert.equal(zoneDate(at,'Asia/Tokyo'),'2026-10-25');
});
test('DST spring gap skipped rather than inventing a date',()=>{
 const at=Date.parse('2026-03-08T05:00:00Z');
 const next=nextDaily('America/New_York',2,30,at);
 assert.equal(zoneDate(next,'America/New_York'),'2026-03-09');
});
test('default exception inherits success channel even when success is disabled',()=>{
 const policy={...DEFAULT_POLICY,success_enabled:false,success_channels:['telegram']};
 assert.deepEqual(routeChannels(policy,'success'),[]);
 assert.deepEqual(routeChannels(policy,'exception'),['telegram']);
 assert.deepEqual(routeChannels({...policy,error_mode:'custom',exception_channels:['webhook','webhook']},'exception'),['webhook']);
});
test('Webhook allowlist blocks unknown, private and non-HTTPS targets',()=>{
 assert.equal(validateWebhookTarget('https://push.example.org/notify',['push.example.org']).hostname,'push.example.org');
 assert.throws(()=>validateWebhookTarget('http://push.example.org/notify',['push.example.org']));
 assert.throws(()=>validateWebhookTarget('https://localhost/api',['localhost']));
 assert.throws(()=>validateWebhookTarget('https://127.0.0.1/c',['127.0.0.1']));
 assert.throws(()=>validateWebhookTarget('https://evil.example/api',['push.example.org']));
});
test('AES-GCM encrypts and binds to user/resource IDs',async()=>{
 const master=randomToken(32);const plain={cookie:'SESSDATA=secret',x:1};const cipher=await encrypt(master,'user-a','account-1',plain);
 assert.ok(!cipher.includes('SESSDATA'));
 assert.deepEqual(await decrypt(master,'user-a','account-1',cipher),plain);
 await assert.rejects(()=>decrypt(master,'user-b','account-1',cipher));
 assert.notEqual(await fingerprint(master,'bilibili','same-cookie'),await fingerprint(master,'baidu','same-cookie'));
 assert.equal(await sha256('repeat'),await sha256('repeat'));
});
