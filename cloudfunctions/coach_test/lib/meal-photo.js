const crypto=require('crypto'),d=require('./domain'),daily=require('./daily'),g=require('./guidance'),n=require('./nutrition'),b=require('./business');
const manifest=require('./stages.json'),imageData=require('./meal-ai').imageData;
const idPattern=/^[a-f0-9]{32}$/, requestPattern=/^[-a-zA-Z0-9]{5,80}$/;
const fail=b.fail, hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const prefix=(runtime,user)=>runtime.tables.storagePrefix+'meal-photos/'+hash(user)+'/';
const owns=(runtime,user,id,asset)=>idPattern.test(id)&&['jpg','png'].some(ext=>asset.fileId===manifest.storageFilePrefix+prefix(runtime,user)+id+'.'+ext);
const epoch=s=>s.deletedAt||0;

function references(s,previous=false) {
  const refs=new Set();
  for(const row of Object.values(s.records))if(row.kind==='meal'){
    if(row.value.text)for(const id of row.value.photoIds||[])refs.add(id);
    if(previous&&row.value.previous)for(const id of row.value.previousPhotoIds||[])refs.add(id);
  }
  return refs;
}
function reset(s){
  for(const asset of Object.values(s.mealPhotoAssets||{})){asset.garbage=true;asset.dueAt=asset.status==='pending'?Math.max(asset.lease||0,Date.now()):0;}
}
async function cleanup(runtime,user,now=Date.now()){
  const pending=await runtime.transact(user,s=>{
    const live=references(s,true), out=[];
    for(const [id,asset] of Object.entries(s.mealPhotoAssets||{})){
      if(out.length===40)break;
      if(!owns(runtime,user,id,asset)||live.has(id))continue;
      if(asset.garbage?asset.dueAt<=now:asset.status==='saved'||asset.until<=now&&asset.lease<=now){
        asset.garbage=true;asset.dueAt=now;out.push([id,asset.fileId]);
      }
    }
    return out;
  });
  if(!pending.length)return;
  let result;
  try{result=await runtime.cloud.deleteFile({fileList:pending.map(x=>x[1])});}
  catch{return;}
  const deleted=new Set((result.fileList||[]).filter(x=>x.status===0||x.code==='SUCCESS'||['FILE_NOT_EXIST','STORAGE_FILE_NONEXIST'].includes(x.code)||/not exist|not found/i.test(x.errMsg||'')).map(x=>x.fileID));
  if(deleted.size)await runtime.transact(user,s=>{for(const [id,fileId] of pending)if(deleted.has(fileId)&&s.mealPhotoAssets?.[id]?.garbage)delete s.mealPhotoAssets[id];});
}
function checkAccount(s,event,now){
  if(epoch(s)!==event.epoch)fail('账号数据已变化，请重新打开','ACCOUNT_CHANGED');
  if(!g.membership(s.orders,now).active)fail('请先开通或续购指导服务','MEMBERSHIP_REQUIRED');
  if(event.date!==d.localDate(now))fail('仅可保存当天餐照');
}
function current(s,event,now){
  checkAccount(s,event,now);
  return daily.mealsForDate(s.records,event.date).find(x=>x.slot===event.slot);
}
function same(row,event){return row.key===event.mealKey&&row.version===event.baseVersion&&row.text===(event.baseText||'');}
function validate(event){
  if(event.consent!==true||!requestPattern.test(event.requestId||'')||!daily.slots.includes(event.slot)||!['new','append','replace'].includes(event.mode)||
    !Number.isInteger(event.baseVersion)||event.baseVersion<0||typeof event.mealKey!=='string'||typeof event.text!=='string'||!event.text.trim()||
    event.text.length>1000||typeof event.baseText!=='string'||event.baseText.length>1000||event.analysis!=null&&!n.validAnalysis(event.analysis))fail('请确认餐别、内容与照片保存说明');
}
function findRequest(s,requestId){
  return Object.entries(s.mealPhotoAssets||{}).find(([,asset])=>asset.epoch===epoch(s)&&asset.requestId===requestId);
}
function receipt(s,asset){return {key:asset.mealKey,state:b.publicState(s)};}
async function handle(event,runtime,cfg,now=Date.now()){
  const user=runtime.cloud.getWXContext().OPENID;
  if(!user)fail('请从小程序登录','UNAUTHORIZED');
  if(event.owner!==user)fail('账号已变化，请重新打开','ACCOUNT_CHANGED');
  if(!cfg.mealPhotoStorageReady)fail('餐照同步暂未开放','AI_UNAVAILABLE');
  if(event.action==='meal.photo.status'){
    if(!requestPattern.test(event.requestId||'')||!daily.slots.includes(event.slot))fail('保存请求标识无效');
    return runtime.transact(user,s=>{
      checkAccount(s,event,now);
      const [,asset]=findRequest(s,event.requestId)||[];
      if(!asset)return {status:'missing'};
      if(asset.mealKey&&!asset.mealKey.endsWith(`:${event.date}:${event.slot}`))fail('保存请求与当前餐次不一致');
      if(asset.status==='saved')return {status:'saved',...receipt(s,asset)};
      if(asset.garbage||asset.until<=now)return {status:'expired'};
      return {status:asset.lease>now?'pending':'retryable'};
    });
  }
  if(event.action==='meal.photo.get'){
    if(!idPattern.test(event.id||''))fail('照片标识无效');
    const asset=await runtime.transact(user,s=>{
      const asset=s.mealPhotoAssets?.[event.id];
      if(event.epoch!==epoch(s)||!asset||asset.garbage||asset.status!=='saved'||!owns(runtime,user,event.id,asset)||!references(s).has(event.id))fail('照片不可查看','UNAUTHORIZED');
      return asset;
    });
    const result=await runtime.cloud.downloadFile({fileID:asset.fileId});
    if(!Buffer.isBuffer(result.fileContent)||!result.fileContent.length||result.fileContent.length>600*1024)fail('照片暂不可查看','AI_UNAVAILABLE');
    await runtime.transact(user,s=>{if(asset.epoch!==epoch(s)||!references(s).has(event.id))fail('照片不可查看','UNAUTHORIZED');});
    return {base64:result.fileContent.toString('base64'),extension:asset.fileId.endsWith('.png')?'png':'jpg'};
  }
  validate(event);
  event={...event,analysis:event.analysis?n.normalizeAnalysis(event.analysis):null};
  const imageHash=imageData(event.image),extension=event.image.startsWith('data:image/png;')?'png':'jpg';
  const signature=hash(JSON.stringify([imageHash,event.date,event.mealKey,event.baseVersion,event.baseText,event.slot,event.text,event.analysis,event.mode]));
  const token=crypto.randomBytes(12).toString('hex'), started=Date.now();
  const reserved=await runtime.transact(user,s=>{
    const row=current(s,event,now);
    s.mealPhotoAssets ||= {};
    const previous=findRequest(s,event.requestId);
    if(previous){
      const [id,asset]=previous;
      if(asset.signature!==signature)fail('保存内容已变化，请重新确认','VERSION_CONFLICT');
      if(asset.status==='saved')return {cached:true,...receipt(s,asset)};
      if(asset.garbage||asset.until<=now)fail('上传凭据已过期，请重试','EXPIRED');
      if(asset.lease>now)fail('照片正在保存，请稍后重试','PENDING');
    }
    if(!same(row,event)||event.mode==='new'&&row.text)fail('这餐已有更新，请重新确认','VERSION_CONFLICT');
    if(event.mode==='append'&&((row.value?.photoIds?.length||0)>=20||(row.value?.analysisIds?.length||0)>=20||row.text.length+1+event.text.trim().length>1000))fail('这一餐的记录已达上限，请精简后重试');
    if(!previous&&Object.values(s.mealPhotoAssets).filter(a=>a.status==='pending'&&!a.garbage&&a.until>now).length>=8)fail('餐照保存请求较多，请稍后重试','QUOTA_EXCEEDED');
    const id=previous?.[0]||crypto.randomBytes(16).toString('hex'),path=prefix(runtime,user)+id+'.'+extension;
    const asset=s.mealPhotoAssets[id]={requestId:event.requestId,epoch:epoch(s),signature,fileId:manifest.storageFilePrefix+path,mealKey:row.key,status:'pending',token,lease:now+65000,until:now+15*60000};
    return {id,path,fileId:asset.fileId};
  });
  if(reserved.cached)return reserved;
  let phase='upload';
  try{
    const uploaded=await runtime.cloud.uploadFile({cloudPath:reserved.path,fileContent:Buffer.from(event.image.split(',')[1],'base64')});
    if(uploaded.fileID!==reserved.fileId)fail('照片上传未完成，可重试同步','PHOTO_STORAGE_FAILED');
    phase='commit';
    return await runtime.transact(user,s=>{
      const at=now+Date.now()-started,old=current(s,event,at),asset=s.mealPhotoAssets?.[reserved.id];
      if(!asset||asset.token!==token||asset.garbage||asset.lease<=at||!same(old,event))fail('这餐已有更新，请重新确认','VERSION_CONFLICT');
      const append=event.mode==='append'&&!!old.text,v=old.value||{},analysisIds=append?[...(v.analysisIds||[])]:[],photoIds=append?[...(v.photoIds||[])]:[];
      if(event.analysis){
        const id=`analysis:${old.planId}:${event.date}:${reserved.id}`;
        s.records[id]={kind:'mealAnalysis',value:{planId:old.planId,date:event.date,slot:event.slot,analysis:event.analysis,at},version:1,revision:++s.revision};
        analysisIds.push(id);
      }
      photoIds.push(reserved.id);
      const previousIncomplete=v.nutritionIncomplete??!!(old.text&&!v.analysisIds?.length);
      const value={planId:old.planId,date:event.date,slot:event.slot,text:append?old.text+'；'+event.text.trim():event.text.trim(),source:'photo',at,
        analysisIds,photoIds,nutritionIncomplete:!event.analysis||append&&previousIncomplete,previous:old.text,
        previousAnalysisIds:v.analysisIds||[],previousPhotoIds:v.photoIds||[],previousNutritionIncomplete:previousIncomplete};
      s.records[old.key]={kind:'meal',value,version:old.version+1,revision:++s.revision};
      asset.status='saved';asset.mealKey=old.key;delete asset.lease;delete asset.token;
      b.assertCapacity(s);
      return receipt(s,asset);
    });
  }catch(error){
    await runtime.transact(user,s=>{
      const asset=s.mealPhotoAssets?.[reserved.id];
      if(asset?.token===token){asset.lease=0;if(asset.garbage)asset.dueAt=0;}
    }).catch(()=>{});
    if(['ACCOUNT_CHANGED','VERSION_CONFLICT','INVALID','MEMBERSHIP_REQUIRED','PHOTO_STORAGE_FAILED'].includes(error.code))throw error;
    if(phase==='upload')fail('照片上传服务暂时不可用，可重试同步','PHOTO_STORAGE_FAILED');
    fail('餐食记录提交暂时失败，可重试同步','PHOTO_SAVE_FAILED');
  }
}
module.exports={handle,reset,cleanup};
