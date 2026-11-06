const d=require('./domain'),b=require('./business');
function reference(days,today){
 const from=d.localDate(Date.parse(today+'T12:00:00+08:00')-7*d.DAY);
 const rows=Object.values(days||{}).filter(x=>x.date>=from&&x.date<today);
 return rows.length>=3?Math.round(rows.reduce((sum,x)=>sum+x.steps,0)/rows.length):null;
}
async function handle(event,runtime,now=Date.now()){
 const {cloud,transact}=runtime,userId=cloud.getWXContext().OPENID;
 if(!userId)b.fail('请从小程序登录','UNAUTHORIZED');
 if(event.consent!==true||typeof event.cloudID!=='string'||!event.cloudID||event.cloudID.length>1024)b.fail('请先授权微信运动并重新同步');
 const reserved=await transact(userId,s=>{s.stepsSequence=(s.stepsSequence||0)+1;return {sequence:s.stepsSequence,epoch:s.deletedAt||0};});
 let result;try{result=await cloud.getOpenData({list:[event.cloudID]});}catch(e){b.fail('微信运动同步失败，请稍后重试');}
 const row=result?.list?.[0],data=row?.data,ctx=cloud.getWXContext();
 if(row?.cloudID!==event.cloudID||!Array.isArray(data?.stepInfoList)||data.stepInfoList.length>31||!data.watermark||data.watermark.appid!==ctx.APPID||!Number.isFinite(data.watermark.timestamp)||data.watermark.timestamp*1000>now+60000)b.fail('微信运动数据无效，请重新授权同步');
 const observedAt=data.watermark.timestamp*1000,from=d.localDate(now-30*d.DAY),today=d.localDate(now);
 const days={};
 for(const item of data.stepInfoList){
  if(!Number.isInteger(item.step)||item.step<0||item.step>200000||!Number.isInteger(item.timestamp)||item.timestamp<0)b.fail('微信运动数据无效');
  const date=d.localDate(item.timestamp*1000);if(date<from||date>today)continue;
  days[date]={date,steps:item.step,source:'wechat',observedAt,syncedAt:now,sequence:reserved.sequence};
 }
 return transact(userId,s=>{
  if((s.deletedAt||0)!==reserved.epoch)b.fail('账号数据已删除，请重新打开','ACCOUNT_CHANGED');
  s.activitySteps=s.activitySteps||{};
  for(const [date,value] of Object.entries(days)){const old=s.activitySteps[date];if(!old||value.observedAt>old.observedAt||value.observedAt===old.observedAt&&value.sequence>old.sequence)s.activitySteps[date]=value;}
  s.activitySteps=Object.fromEntries(Object.entries(s.activitySteps).filter(([date])=>date>=from&&date<=today));s.revision++;
  return {days:s.activitySteps,referenceSteps:reference(s.activitySteps,today)};
 });
}
module.exports={handle,reference};
