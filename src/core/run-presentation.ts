// Display verified evidence without changing the scheduler's stored statuses.
type Row={label:string;status:string;description:string};
export type RunOverview={statusLabel:string;taskTitle:string;summary:string;progress:string;nextAction:string;items:Row[];metrics:{label:string;value:string}[];retryAt?:number};
const STATUS:Record<string,string>={scheduled:'已排期',queued:'已排队',running:'执行中',succeeded:'执行成功',already_done:'检查完成',failed:'执行失败',waiting_retry:'等待重试',waiting_verification:'需要核对',canceled:'已取消'};
const TASK:Record<string,string>={'baidu.daily':'PC / App 签到及累计奖励','bili.vip_claim':'检查 / 领取 B 币券','bili.exchange':'兑换直播电池'};
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const object=(v:any):Record<string,any>=>v&&typeof v==='object'&&!Array.isArray(v)?v:{};
const list=(v:any):any[]=>Array.isArray(v)?v:[];
const change=(n:number)=>(n>0?'+':'')+n;
function failureReason(value:unknown){
 const text=typeof value==='string'?value:'';
 const business=/^百度业务失败（(-?\d{1,10})）$/.exec(text),http=/^百度接口 HTTP (\d{3})$/.exec(text);
 if(business)return '百度接口返回错误码 '+business[1];
 if(http)return '百度接口返回 HTTP '+http[1];
 const known:Record<string,string>={'百度网络超时或响应不是 JSON':'百度接口超时或返回异常内容','缺少有效 cuid':'签到设备信息缺失，请检查账号设置','未找到有效 App 签到任务':'未取得有效的 App 签到任务','App 签到状态无法确认':'未能确认今日 App 签到状态','App 请求成功，但签到状态未确认':'已发送签到请求，但尚未确认签到结果','成长值响应缺少有效数值':'未能确认成长值','累计奖励状态格式错误':'未能确认累计奖励状态','仍有已达标奖励未领取':'仍有已达标奖励未确认领取'};
 return known[text]||'本步骤请求失败或结果尚未能核实';
}
function resultOf(run:Record<string,any>){
 if(run.result)return object(run.result);
 try{return typeof run.result_json==='string'&&run.result_json.length<=512000?object(JSON.parse(run.result_json)):{};}catch{return {};}
}
export function runOverview(run:Record<string,any>,detailed=true):RunOverview{
 const result=resultOf(run),report=object(result.details?.report),steps=list(report.steps).filter(s=>s&&typeof s==='object'),items:Row[]=[],metrics:RunOverview['metrics']=[];
 const status=String(run.status),task=String(run.task_key||'');
 const defaults:Record<string,string>={scheduled:'任务已安排，尚未开始检查',queued:'任务已进入队列，等待检查',running:'正在检查账号状态并处理当前可执行项目',succeeded:'任务已正常完成，历史记录未提供更详细的分项结果',already_done:'检查已完成，当前没有新增操作；历史记录未提供具体原因',failed:'本次未能确认任务全部完成',waiting_retry:'本次检查或结果核实尚未完成，已安排稍后重试',waiting_verification:'部分操作的最终结果尚未确认，已停止重复提交',canceled:'本次运行已取消，记录中未提供具体取消原因'};
 let summary=defaults[status]||'暂时无法识别这条运行记录的状态',nextAction='';
 if(task==='baidu.daily'){
  const enabled=object(report.enabled),parts:string[]=[];
  if(steps.length&&!report.reconciliation)items.push({label:'账号身份检查',status:'已通过',description:'执行步骤前已确认账号身份'});
  for(const [id,label] of [['pc','PC 签到'],['app','App 签到']]){
   const step=steps.find(s=>s.id===id);
   if(enabled[id]===false){items.push({label,status:'未启用',description:'本次未检查此项目'});continue;}
   if(report.reconciliation?.checks?.[id]===true){items.push({label,status:'已核实',description:'只读核对已确认此项目，未重新发送签到请求'});parts.push(label+'：已核实');continue;}
   if(!step){items.push({label,status:['scheduled','queued','running'].includes(status)?'等待检查':'未记录',description:'当前记录尚未提供此项目的确认结果'});continue;}
   const known=step.ok===true&&['signed','already_signed'].includes(step.state);
   const text=known?(step.state==='signed'?'本次已签到':'今日已签到'):'结果未确认';
   items.push({label,status:text,description:known?(step.state==='signed'?'签到结果已确认':id==='pc'?'百度返回今日重复签到，本次未新增签到':'查询确认今天已签到'):failureReason(step.message)});
   parts.push(label+'：'+text);
  }
  const awards=object(report.reconciliation?.observed?.awards||report.awards),tiers=list(awards.tiers),claimed=steps.filter(s=>String(s.id).startsWith('award-')&&s.ok===true&&s.state==='claimed');
  if(enabled.awards===false)items.push({label:'累计奖励',status:'未启用',description:'本次未领取累计奖励'});
  else if(Array.isArray(awards.claimable)){
   const received=tiers.filter(t=>finite(t?.day)&&finite(t.received)&&finite(t.count)&&t.count>0&&t.received>=t.count).slice(0,12).map(t=>t.day+' 天');
   const rewardStatus=awards.claimable.length?'领取尚未完成':claimed.length?'已领取新奖励':'暂无可领取奖励';
   let description=received.length?'已领完：'+received.join('、')+'档。':'';
   if(finite(awards.nextDay)&&finite(awards.remainingDays))description+=`下一档 ${awards.nextDay} 天奖励，还需签到 ${awards.remainingDays} 天。`;
   else if(tiers.length&&tiers.every(t=>finite(t?.received)&&finite(t.count)&&t.count>0&&t.received>=t.count))description+='已记录的累计奖励档位均已领取。';
   if(awards.claimable.length)description+='仍有已达标奖励未确认领取，请查看异常项目。';
   items.push({label:'累计奖励',status:rewardStatus,description:description||'已检查累计奖励状态'});parts.push(rewardStatus);
  }else items.push({label:'累计奖励',status:'未确认',description:'当前记录没有可核实的奖励状态'});
  if(finite(awards.signinDays))metrics.push({label:'累计签到',value:awards.signinDays+' 天'});
  if(enabled.awards!==false&&finite(awards.nextDay)&&finite(awards.remainingDays))metrics.push({label:'下一档奖励',value:`${awards.nextDay} 天档，还需签到 ${awards.remainingDays} 天`});
  const initial=report.initialGrowth,final=report.finalGrowth;
  metrics.push({label:'成长值',value:finite(initial)&&finite(final)?`${initial} → ${final}（${change(final-initial)}）`:finite(final)?`${final}（本轮变化未能确认）`:'未能确认'});
  if(['succeeded','already_done'].includes(status)&&parts.length)summary=parts.join('；');
  else if(['failed','waiting_retry','waiting_verification'].includes(status)){
   const unresolved=items.filter(i=>['结果未确认','领取尚未完成'].includes(i.status));
   if(unresolved.length)summary=unresolved.map(i=>i.label+'：'+i.description).join('；');
   else if(list(report.errors).length)summary='累计奖励检查未完成：'+failureReason(report.errors[0]);
  }
  if(['succeeded','already_done'].includes(status)&&finite(awards.nextDay)&&finite(awards.remainingDays)&&enabled.awards!==false)nextAction=`继续按计划签到，距离 ${awards.nextDay} 天奖励还需签到 ${awards.remainingDays} 天。`;
  if(list(report.errors).includes('全部任务均已关闭')){summary='PC、App 签到及累计奖励均未启用';nextAction='请在平台设置中开启需要执行的项目。';}
 }
 if(task.startsWith('bili.')){
  const active=task==='bili.exchange'?object(report.exchange):object(report.claim);
  for(const [key,label] of [['claim','B 币券领取'],['exchange','直播电池兑换']]){
   const step=object(report[key]);if(!step.state){if((task==='bili.exchange')===(key==='exchange'))items.push({label,status:'未确认',description:'当前记录尚未提供此项目的确认结果'});continue;}
   const states:Record<string,[string,string]>={confirmed:['已确认完成',key==='claim'?'已核实 B 币券余额增加':'已核实扣券及直播钱包余额变化'],not_available:['暂无可领取权益','本次没有提交领取请求'],no_coupons:['暂无可兑换币券','本次没有提交兑换请求'],disabled:['未启用','本次未执行此项目'],request_started:['结果待确认','请求可能已经提交，暂不重复操作'],pending_verification:['等待核实','正在等待余额变化核实'],unverified:['需要核对','已有信息不足以确认最终结果，暂不重复操作']};
   const state=states[String(step.state)]||['结果未确认','请查看诊断信息并核对平台实际记录'];items.push({label,status:state[0],description:state[1]});
  }
  if(['succeeded','already_done'].includes(status)){
   if(active.state==='not_available')summary='当前暂无可领取的 B 币券权益，本次未提交领取请求';
   else if(active.state==='no_coupons')summary='当前没有可兑换的 B 币券，本次未提交兑换请求';
   else if(active.state==='confirmed')summary=task==='bili.exchange'?'已核实 B 币券扣减和直播电池余额增长':'已核实 B 币券余额增加，领取完成';
  }
  if(finite(active.couponBeforeBp)&&finite(active.couponAfterBp))metrics.push({label:'B 币券余额',value:`${active.couponBeforeBp} → ${active.couponAfterBp}`});
  if(task==='bili.exchange'&&finite(active.batteryBefore)&&finite(active.batteryAfter))metrics.push({label:'直播电池折算余额',value:`${active.batteryBefore} → ${active.batteryAfter}`});
 }
 const reason=result.details?.reason;
 if(reason==='session_expired'||String(result.summary||'').startsWith('Platform session expired.')){summary='平台登录已失效，账号及计划任务已暂停';nextAction='请进入对应平台重新扫码更新登录，并恢复账号与任务。';}
 else if(reason==='credential_pending'){summary='登录状态正在续期或稍后重试，尚未执行任务';nextAction='请稍后查看账号续期状态；提示登录失效时再重新扫码。';}
 else if(status==='waiting_verification')nextAction='先使用“只读核对”检查结果；仍无法确认时请管理员核对平台记录，避免重复提交。';
 else if(status==='waiting_retry')nextAction=task.startsWith('bili.')?'稍后自动只读核实结果，不重复提交领取或兑换请求；维护暂停时将顺延。':'稍后自动重试，已确认完成的步骤会保留；维护暂停时将顺延。';
 else if(status==='failed'&&!nextAction)nextAction='请查看未确认的项目及诊断信息，处理异常后再运行。';
 else if(status==='canceled')nextAction='请检查账号和任务开关；需要继续时可重新运行。';
 else if(['succeeded','already_done'].includes(status)&&!nextAction)nextAction='当前没有需要处理的事项，后续按计划再次检查。';
 const retryAt=status==='waiting_retry'&&finite(result.retry_at)?result.retry_at:undefined;
 const progress=metrics.filter(m=>m.value!=='未能确认').map(m=>m.label+'：'+m.value).join(' · ');
 return {statusLabel:STATUS[status]||'状态待确认',taskTitle:TASK[task]||'任务运行',summary,progress,nextAction,items:detailed?items:[],metrics:detailed?metrics:[],...(retryAt?{retryAt}:{})};
}
export function publicRun(row:Record<string,any>,detailed=false){
 const {result_json,result,...rest}=row;
 return {...rest,overview:runOverview(row,detailed),...(detailed?{result:resultOf(row)}:{})};
}
