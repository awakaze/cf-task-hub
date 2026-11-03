import test from 'node:test';
import assert from 'node:assert/strict';
import {runOverview,publicRun} from '../src/core/run-presentation.ts';
const report=()=>({enabled:{pc:true,app:true,awards:true},steps:[{id:'pc',ok:true,state:'already_signed'},{id:'app',ok:true,state:'already_signed'}],initialGrowth:6344,finalGrowth:6344,awards:{signinDays:26,nextDay:30,remainingDays:4,claimable:[],tiers:[{day:7,received:2,count:2},{day:15,received:2,count:2},{day:30,received:0,count:2}]}});
const row=(data=report(),status='already_done')=>({status,task_key:'baidu.daily',result:{details:{report:data}}});
test('already-completed Baidu checks explain actual steps, zero growth and the next reward',()=>{
 const view=runOverview(row());assert.equal(view.statusLabel,'检查完成');assert.match(view.summary,/PC 签到：今日已签到/);assert.match(view.summary,/暂无可领取奖励/);assert.match(view.nextAction,/还需签到 4 天/);assert.match(view.items.find(i=>i.label==='累计奖励').description,/7 天、15 天/);assert.equal(view.metrics.find(i=>i.label==='成长值').value,'6344 → 6344（0）');
});
test('new operations are distinct from previously completed items even when growth does not change',()=>{
 const data=report();data.steps[0].state='signed';data.steps.push({id:'award-7',ok:true,state:'claimed'});
 const view=runOverview(row(data,'succeeded'));assert.equal(view.statusLabel,'执行成功');assert.match(view.summary,/本次已签到/);assert.match(view.summary,/已领取新奖励/);
});
test('disabled or unrecorded checks and unknown growth are never invented as successful zero changes',()=>{
 const data={enabled:{pc:false,app:true,awards:false},steps:[],initialGrowth:null,finalGrowth:null};const view=runOverview(row(data,'failed'));
 assert.equal(view.items.find(i=>i.label==='PC 签到').status,'未启用');assert.equal(view.items.find(i=>i.label==='App 签到').status,'未记录');assert.equal(view.metrics[0].value,'未能确认');assert.doesNotMatch(view.summary,/今日已签到/);
});
test('Bilibili unavailable benefits do not claim they were already collected and exchange explains no coupons',()=>{
 const claim=runOverview({status:'already_done',task_key:'bili.vip_claim',result:{details:{report:{claim:{state:'not_available'}}}}});assert.match(claim.summary,/暂无可领取/);assert.doesNotMatch(claim.summary,/已领取|领取完成/);
 const exchange=runOverview({status:'already_done',task_key:'bili.exchange',result:{details:{report:{exchange:{state:'no_coupons'}}}}});assert.match(exchange.summary,/没有可兑换/);
});
test('retry, uncertain and expired-login outcomes provide distinct next actions and preserve confirmed steps',()=>{
 const data=report();data.steps[1]={id:'app',ok:false,message:'百度网络超时或响应不是 JSON'};const retry=runOverview({...row(data,'waiting_retry'),result:{retry_at:123456,details:{report:data}}});
 assert.match(retry.summary,/App 签到：百度接口超时/);assert.equal(retry.retryAt,123456);assert.equal(retry.items.find(i=>i.label==='PC 签到').status,'今日已签到');
 assert.match(runOverview(row(data,'waiting_verification')).nextAction,/只读核对/);
 const expired=runOverview({status:'failed',task_key:'baidu.daily',result:{details:{reason:'session_expired'}}});assert.match(expired.summary,/登录已失效/);assert.match(expired.nextAction,/重新扫码/);
});
test('legacy, malformed and unexpected reports fall back without leaking stored bodies or fabricating reasons',()=>{
 for(const value of [null,'broken','{"details":{"report":null}}','{"details":{"report":{"steps":[null]}}}']){const view=publicRun({status:'already_done',task_key:'baidu.daily',result_json:value});assert.equal(view.status,'already_done');assert.equal(view.overview.statusLabel,'检查完成');assert.equal(Object.hasOwn(view,'result_json'),false);assert.equal(Object.hasOwn(view,'result'),false);}
 const view=runOverview(row({steps:[{id:'app',ok:false,message:'Cookie=private-value'}]},'failed'));assert.doesNotMatch(JSON.stringify(view),/private-value/);
 const canceled=runOverview({status:'canceled'});assert.match(canceled.summary,/未提供具体取消原因/);
});

test('read-only reconciliation shows newly verified evidence instead of stale incomplete steps',()=>{
 const data=report();data.steps[0].ok=false;data.steps[0].message='成长值响应缺少有效数值';data.awards.claimable=[{day:7}];data.reconciliation={readOnly:true,checks:{pc:true,app:true,awards:true},observed:{awards:{...data.awards,claimable:[]}}};
 const view=runOverview(row(data,'succeeded'));assert.equal(view.items.find(i=>i.label==='PC 签到').status,'已核实');assert.equal(view.items.find(i=>i.label==='累计奖励').status,'暂无可领取奖励');assert.doesNotMatch(view.summary,/未完成|未确认/);
});
