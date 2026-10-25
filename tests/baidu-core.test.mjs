import test from 'node:test';
import assert from 'node:assert/strict';
import {cookieField,options,BaiduClient,runAttempt} from '../src/modules/baidu-netdisk/original-core.js';

test('Baidu cookie parser and safe default flags',()=>{
 assert.equal(cookieField('foo=bar; BAIDUCUID=abc; other=x','BAIDUCUID'),'abc');
 assert.equal(options({BAIDU_COOKIE:'BAIDUCUID=abc; BDUSS=secret'}).awards,true);
 assert.equal(options({ENABLE_PC:'false'}).pc,false);
});
test('Baidu client refuses status 200 with business failure',async()=>{
 const c=new BaiduClient({cookie:'BDUSS=1',cuid:'dev',headers:{},timeout:1000},async()=>new Response(JSON.stringify({errno:-6}),{status:200}));
 await assert.rejects(()=>c.growth(),/百度业务失败/);
});
test('Baidu PC sign in measures real growth delta',async()=>{
 let growth=100;const reports=[];
 const client={growth:async()=>growth,pcSign:async()=>{growth+=4;return 'signed';}};
 const report={attempts:0,steps:[],errors:[]};
 await runAttempt(report,client,{pc:true,app:false,awards:false,retryMinutes:30},async r=>reports.push(JSON.stringify(r)));
 assert.equal(report.ok,true);assert.equal(report.steps[0].delta,4);assert.ok(reports.length>=2);
});
