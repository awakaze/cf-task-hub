// Scheduling always uses China Standard Time (UTC+8). Time zones are no longer
// selectable: a run's wall-clock time means Beijing time for every tenant.
export const BEIJING='Asia/Shanghai';
const formatters=new Map<string,Intl.DateTimeFormat>();
function formatter(zone:string){
 if(typeof zone!=='string'||zone.length<1||zone.length>80)throw new Error('IANA time zone is required');
 let fmt=formatters.get(zone);if(!fmt){fmt=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});if(formatters.size>=64)formatters.delete(formatters.keys().next().value!);formatters.set(zone,fmt);}return fmt;
}
export function zonedParts(epoch:number,zone:string):{year:number;month:number;day:number;hour:number;minute:number} {
  const pieces=formatter(zone).formatToParts(epoch);
  const map=Object.fromEntries(pieces.filter(x=>x.type!=='literal').map(x=>[x.type,Number(x.value)]));
  return {year:map.year,month:map.month,day:map.day,hour:map.hour,minute:map.minute};
}
export function zoneDate(epoch:number,zone:string=BEIJING):string {
  const p=zonedParts(epoch,zone);
  return `${p.year}-${String(p.month).padStart(2,'0')}-${String(p.day).padStart(2,'0')}`;
}
export function validZone(zone:string):boolean {
  try{formatter(zone);return true;}catch{return false;}
}
// Converts a local wall-clock time to an absolute epoch. Returns null when the
// wall clock does not exist in that zone (for example a DST spring-forward gap).
function localToUtc(zone:string,year:number,month:number,day:number,hour:number,minute:number):number|null {
 const naive=Date.UTC(year,month-1,day,hour,minute);
 let candidate=naive;
 for(let k=0;k<4;k++){
  const actual=zonedParts(candidate,zone);
  const represented=Date.UTC(actual.year,actual.month-1,actual.day,actual.hour,actual.minute);
  const next=candidate+(naive-represented);
  if(next===candidate)break;
  candidate=next;
 }
 const check=zonedParts(candidate,zone);
 return check.year===year&&check.month===month&&check.day===day&&check.hour===hour&&check.minute===minute?candidate:null;
}
function nextLocalTime(zone:string,hour:number,minute:number,from:number,match:(day:{year:number;month:number;day:number;weekday:number})=>boolean,maxDays=760):number {
 const start=zonedParts(from,zone);
 const startUtc=Date.UTC(start.year,start.month-1,start.day);
 for(let i=0;i<maxDays;i++){
  const date=new Date(startUtc+i*86400000);
  const year=date.getUTCFullYear(),month=date.getUTCMonth()+1,day=date.getUTCDate(),weekday=date.getUTCDay();
  if(!match({year,month,day,weekday}))continue;
  const candidate=localToUtc(zone,year,month,day,hour,minute);
  if(candidate!==null&&candidate>from)return candidate;
 }
 throw new Error('无法计算下一次执行时间');
}
export function nextDaily(zone:string,hour:number,minute:number,from=Date.now()):number {
  if(!validZone(zone)||!Number.isInteger(hour)||hour<0||hour>23||!Number.isInteger(minute)||minute<0||minute>59)throw new Error('时区或执行时间无效');
  return nextLocalTime(zone,hour,minute,from,()=>true,4);
}
export function formatSchedule(hour:number,minute:number){return `${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')} 北京时间`;}
export type Schedule=
 |{type:'daily';hour:number;minute:number}
 |{type:'weekly';hour:number;minute:number;weekdays:number[]}
 |{type:'monthly';hour:number;minute:number;days:number[]}
 |{type:'cron';expression:string};
type CronSpec={minutes:number[]|null;hours:number[]|null;dom:number[]|null;months:number[]|null;dow:number[]|null};
function expandCronField(raw:string,min:number,max:number):number[]|null {
 if(raw==='*')return null;
 const out=new Set<number>();
 for(const part of raw.split(',')){
  if(!part)throw new Error('无效的 cron 表达式');
  const slash=part.indexOf('/');
  const base=slash<0?part:part.slice(0,slash);
  const stepRaw=slash<0?null:part.slice(slash+1);
  if(stepRaw!==null&&!/^\d+$/.test(stepRaw))throw new Error('无效的 cron 表达式');
  const step=stepRaw===null?1:Number(stepRaw);
  if(!Number.isInteger(step)||step<1||step>max-min+1)throw new Error('无效的 cron 表达式');
  let lo:number,hi:number;
  if(base==='*'){lo=min;hi=max;}
  else if(base.includes('-')){
   const pair=base.split('-');
   if(pair.length!==2||pair.some(v=>!/^\d+$/.test(v)))throw new Error('无效的 cron 表达式');
   lo=Number(pair[0]);hi=Number(pair[1]);
  }else{
   if(!/^\d+$/.test(base))throw new Error('无效的 cron 表达式');
   lo=Number(base);hi=stepRaw===null?lo:max;
  }
  if(!Number.isInteger(lo)||!Number.isInteger(hi)||lo<min||hi>max||lo>hi)throw new Error('无效的 cron 表达式');
  for(let v=lo;v<=hi;v+=step)out.add(v);
 }
 return [...out].sort((a,b)=>a-b);
}
export function parseCron(expression:string):CronSpec {
 if(typeof expression!=='string')throw new Error('无效的 cron 表达式');
 const parts=expression.trim().split(/\s+/);
 if(parts.length!==5||!parts[0])throw new Error('无效的 cron 表达式');
 const minutes=expandCronField(parts[0],0,59),hours=expandCronField(parts[1],0,23),dom=expandCronField(parts[2],1,31),months=expandCronField(parts[3],1,12);
 const rawDow=expandCronField(parts[4],0,7);
 // Standard cron treats both 0 and 7 as Sunday.
 const dow=rawDow===null?null:[...new Set(rawDow.map(v=>v===7?0:v))].sort((a,b)=>a-b);
 return {minutes,hours,dom,months,dow};
}
const cronFeasible=new Map<string,true>();
// Schedules are fixed to contemporary Beijing time (UTC+8), so candidate
// timestamps need no Intl conversion and elapsed minutes can be skipped.
function nextCron(cron:CronSpec,from:number):number{
 if(!Number.isFinite(from))throw new Error('执行时间无效');
 const offset=8*3600000,local=from+offset,dayStart=Math.floor(local/86400000)*86400000;
 const minutes=cron.minutes??Array.from({length:60},(_,i)=>i);
 const hours=cron.hours??Array.from({length:24},(_,i)=>i);
 for(let i=0;i<2930;i++){
  const base=dayStart+i*86400000,date=new Date(base);
  const month=date.getUTCMonth()+1,day=date.getUTCDate(),weekday=date.getUTCDay();
  if(cron.months&&!cron.months.includes(month))continue;
  const domMatch=cron.dom===null||cron.dom.includes(day),dowMatch=cron.dow===null||cron.dow.includes(weekday);
  if(!(cron.dom!==null&&cron.dow!==null?(domMatch||dowMatch):(domMatch&&dowMatch)))continue;
  const earliest=i===0?Math.floor((local-dayStart)/60000)+1:0;
  for(const hour of hours){
   if((hour+1)*60<=earliest)continue;
   for(const minute of minutes){
    const minuteOfDay=hour*60+minute;if(minuteOfDay<earliest)continue;
    return base+minuteOfDay*60000-offset;
   }
  }
 }
 throw new Error('cron 表达式没有可执行的日期');
}
export function validateSchedule(raw:unknown):Schedule{
 const s=raw as any;
 if(!s||typeof s!=='object')throw new Error('执行时间无效');
 if(s.type==='cron'){
  if(typeof s.expression!=='string'||s.expression.length>120)throw new Error('cron 表达式无效');
  const expression=s.expression.trim().split(/\s+/).join(' '),parsed=parseCron(expression);
  if(!cronFeasible.has(expression)){nextCron(parsed,Date.UTC(2024,0,1));if(cronFeasible.size>=64)cronFeasible.delete(cronFeasible.keys().next().value!);cronFeasible.set(expression,true);}
  return {type:'cron',expression};
 }
 if(!['daily','weekly','monthly'].includes(s.type)||!Number.isInteger(s.hour)||s.hour<0||s.hour>23||!Number.isInteger(s.minute)||s.minute<0||s.minute>59)throw new Error('执行时间无效');
 if(s.type==='weekly'){
  if(!Array.isArray(s.weekdays)||!s.weekdays.length||s.weekdays.length>7||s.weekdays.some((n:any)=>!Number.isInteger(n)||n<0||n>6))throw new Error('请选择每周的执行日（0 为周日，6 为周六）');
  return {type:'weekly',hour:s.hour,minute:s.minute,weekdays:[...new Set<number>(s.weekdays)].sort((a,b)=>a-b)};
 }
 if(s.type==='monthly'){
  if(!Array.isArray(s.days)||!s.days.length||s.days.length>31||s.days.some((n:any)=>!Number.isInteger(n)||n<1||n>31))throw new Error('请选择每月的执行日（1–31）');
  return {type:'monthly',hour:s.hour,minute:s.minute,days:[...new Set<number>(s.days)].sort((a,b)=>a-b)};
 }
 return {type:'daily',hour:s.hour,minute:s.minute};
}
export function nextSchedule(raw:unknown,from=Date.now()):number{
 const s=validateSchedule(raw);
 if(s.type==='daily')return nextLocalTime(BEIJING,s.hour,s.minute,from,()=>true);
 if(s.type==='weekly')return nextLocalTime(BEIJING,s.hour,s.minute,from,day=>s.weekdays.includes(day.weekday));
 if(s.type==='monthly')return nextLocalTime(BEIJING,s.hour,s.minute,from,day=>s.days.includes(day.day));
 return nextCron(parseCron(s.expression),from);
}
export function scheduleWindow(raw:unknown,at:number):string{
 const s=validateSchedule(raw);
 if(s.type==='cron'){const p=zonedParts(at,BEIJING);return `cron:${zoneDate(at,BEIJING)}T${String(p.hour).padStart(2,'0')}:${String(p.minute).padStart(2,'0')}`;}
 return `${s.type}:${zoneDate(at,BEIJING)}`;
}
