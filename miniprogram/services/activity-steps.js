const store=require('../core/store'),api=require('./api'),release=require('../core/release'),d=require('../shared/domain');
let flight;
// getWeRunData has callback semantics; never depend on its native return value.
const native=(name,args={})=>new Promise((resolve,reject)=>wx[name]({...args,success:resolve,fail:reject}));
async function sync({connect=false,force=false}={}){
 if(flight)return flight;
 const s=store.get(),owner=s.owner,stage=release.stage(),epoch=s.stepsEpoch||0;
 if(!connect&&(!s.stepsConsent||s.stepsPlatformBlocked))return;
 const same=()=>store.get().owner===owner&&release.stage()===stage&&(store.get().stepsEpoch||0)===epoch&&(store.get().dataEpoch||0)===(s.dataEpoch||0);
 const save=patch=>{if(same())store.save(patch);};
 if(!s.online){save({stepsStatus:'离线，显示上次同步结果'});return;}
 if(!force&&!connect&&Date.now()-(s.stepsLastAttempt||0)<300000)return;
 const work=async()=>{
  let phase='capability';
  save({stepsLastAttempt:Date.now()});
  try{
   if(!wx.getWeRunData||!wx.getSetting)throw new Error('当前微信版本不支持微信运动，请更新后重试');
   phase='privacy';if(connect)await require('../core/feedback').requirePrivacy();
   phase='permission';const setting=await native('getSetting');if(!same())return;
   const permission=setting.authSetting?.['scope.werun'];
   if(permission===false){save({stepsConsent:false,stepsNeedsSettings:true,stepsStatus:'未授权微信运动，请点击“开启权限”进入权限设置，开启后返回同步'});return;}
   if(permission!==true){
    if(!connect){save({stepsConsent:false,stepsNeedsSettings:false,stepsStatus:'微信运动未授权，请先开启权限'});return;}
    phase='authorize';await native('authorize',{scope:'scope.werun'});
   }
   if(!same())return;save({stepsConsent:true,stepsNeedsSettings:false,stepsPlatformBlocked:false,stepsStatus:'正在同步微信步数…'});
   phase='login';const login=await native('login',{timeout:10000});if(!same())return;if(!login?.code)throw new Error('微信登录凭据为空');
   phase='werun';const data=await native('getWeRunData');if(!same())return;
   if(!data.cloudID){const error=new Error('微信运动开放数据凭据缺失，请更新微信并重新进入小程序后重试');error.code='MISSING_CLOUD_ID';throw error;}
   phase='cloud';const result=await api.call('activity.steps.sync',{cloudID:data.cloudID,consent:true});if(!same())return;
   const current=store.get().activitySteps||{},days={...current};
   for(const [date,row] of Object.entries(result.days||{})){const old=days[date];if(!old||row.observedAt>old.observedAt||row.observedAt===old.observedAt&&row.sequence>=old.sequence)days[date]=row;}
   const hasToday=!!result.days?.[d.localDate()];
   save({activitySteps:days,stepsReference:result.referenceSteps,stepsStatus:hasToday?'':'微信运动暂未返回今天的步数，请先打开微信运动刷新后重试',stepsFailure:null,stepsLastSync:Date.now()});
  }catch(e){
   if(!same())return;
   const raw=String(e.errMsg||e.message||''),denied=['authorize','werun'].includes(phase)&&/auth deny|auth denied|user deny|user denied|用户拒绝|拒绝授权/i.test(raw);
   const code=[e.errCode,e.code].find(x=>Number.isFinite(x)||typeof x==='string'&&/^[A-Z_]{3,40}$/.test(x))??null;
   const messages={capability:'当前微信版本不支持微信运动，请更新后重试',privacy:'隐私授权未完成，请同意小程序隐私保护指引后重试',permission:'暂时无法读取微信授权状态，请重试',authorize:'微信运动授权未完成，请点击“权限设置”查看并开启微信运动',login:'微信登录失败，请重新连接微信运动',werun:'微信运动取数失败，请确认已启用微信运动并在手机微信中重试',cloud:e.message||'微信运动云端同步失败，请稍后重试'};
   const message=denied?'未授权微信运动，请点击“开启权限”进入权限设置，开启后返回同步':e.code==='MISSING_CLOUD_ID'?e.message:messages[phase];
   const undeclared=/api scope is not declared in the privacy agreement|未.{0,12}隐私.{0,8}声明/i.test(raw);
   if(undeclared){save({stepsConsent:false,stepsNeedsSettings:false,stepsPlatformBlocked:true,stepsStatus:'小程序尚未在微信公众平台声明微信运动步数，当前无法授权，需由开发者补充后重试',stepsFailure:{phase,code,reason:'privacy_not_declared'}});return;}
   save({stepsStatus:message+(code===null?'':'（'+code+'）'),stepsFailure:{phase,code,reason:denied?'user_denied':'api_failed'},...(denied||phase==='authorize'?{stepsConsent:false,stepsNeedsSettings:true}:{})});
  }
 };
 flight=work();try{return await flight;}finally{flight=null;}
}
// Invoked only by the native openSetting button callback, never by a timer.
async function settingsChanged(result){
 const permission=result?.authSetting?.['scope.werun'];
 if(permission===undefined){
  const blocked=store.get().stepsPlatformBlocked;
  store.save({stepsConsent:false,stepsNeedsSettings:false,stepsStatus:blocked?'小程序尚未在微信公众平台声明微信运动步数，权限设置中不会出现对应开关':'尚未发起微信运动授权，请先点击“开启权限”'});return;
 }
 const granted=permission===true;
 store.save({stepsConsent:granted,stepsNeedsSettings:!granted,stepsPlatformBlocked:false,stepsStatus:granted?'正在同步微信步数…':'微信运动权限仍未开启，开启后才能同步'});
 if(granted)return sync({connect:true,force:true});
}
function view(s,date=d.localDate()){
 const row=s.activitySteps?.[date];
 const today=d.localDate(),from=d.localDate(Date.parse(today+'T12:00:00+08:00')-7*d.DAY);
 const days=Object.values(s.activitySteps||{}).filter(x=>x.date>=from&&x.date<today);
 return {steps:row?.steps??null,display:row?String(row.steps):'未同步',updated:row?new Date(row.syncedAt+8*3600000).toISOString().slice(5,16).replace('T',' '):'',status:s.stepsStatus||'',connected:!!s.stepsConsent,needsSettings:!!s.stepsNeedsSettings,platformBlocked:!!s.stepsPlatformBlocked,reference:days.length>=3?Math.round(days.reduce((n,x)=>n+x.steps,0)/days.length):null};
}
module.exports={sync,settingsChanged,view};
