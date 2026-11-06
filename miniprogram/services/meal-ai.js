const api=require('./api'),repo=require('./repository'),store=require('../core/store'),d=require('../shared/domain');
const image=require('./meal-image');
// Only retain a few in-flight compressed images in memory for transport retries.
const pendingImages=new Map();
async function recognize(filePath,pending,{onProgress=()=>{},check=()=>{},resume=false}={}){
 const s=store.get();
 if(!s.config.mealRecognitionEnabled)throw new Error('饮食照片识别暂未开放，可继续手动记录');
 const stage=require('../core/release').stage();
 const ticket={...(pending||{requestId:repo.id(),date:d.localDate()}),planId:pending?.planId||s.entitlement?.id,...(pending?.planId?{owner:s.owner,epoch:s.dataEpoch||0}:{})};
 const key=[stage,s.owner,s.dataEpoch||0,ticket.planId,ticket.date,ticket.requestId].join(':');
 let cached=pendingImages.get(key);
 if(cached&&cached.filePath!==filePath)throw new Error('识别请求已用于其他照片，请重新选择');
 check();
 if(!cached){
  cached={filePath};pendingImages.set(key,cached);
  while(pendingImages.size>3)pendingImages.delete(pendingImages.keys().next().value);
 }
 const isCurrent=()=>{
  check();
  const latest=store.get();
  if(latest.owner!==s.owner||(latest.dataEpoch||0)!==(s.dataEpoch||0)||!pending?.planId&&latest.entitlement?.id!==s.entitlement?.id||ticket.date!==d.localDate()||require('../core/release').stage()!==stage)throw new Error('账号、日期或计划已变化，请重新识别');
 };
 isCurrent();
 if(s.online===false)throw new Error('当前离线，联网后可重试这张照片');
 const prepare=async()=>{
  if(!cached.image)cached.image=await compressedImage(filePath);
  isCurrent();
 };
 if(!resume&&!cached.submitted)await prepare();
 const result=await require('./meal-request').run({isCurrent,resume:resume||!!cached.submitted,onRecover:()=>onProgress('recovering'),
  canReuseExpired:!!cached.submitted,
  submit:async()=>{await prepare();onProgress('recognizing');cached.submitted=true;return api.call('meal.recognize',{...ticket,consent:true,image:cached.image});},
  status:()=>api.call('meal.status',ticket)
 });
 pendingImages.delete(key);return result;
}
async function compressedImage(filePath){
 const {data}=await image.prepare(filePath,[[1280,75],[1080,60],[900,48],[720,38]]);
 return image.imageUrl(data);
}
module.exports={recognize,compressedImage};
