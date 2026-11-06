const store=require('../core/store'),release=require('../core/release'),api=require('./api'),repo=require('./repository'),d=require('../shared/domain'),rules=require('../shared/daily');
const image=require('./meal-image');
const cache=new Map(),pending=new Map();
const identity=s=>[release.stage(),s.owner,s.dataEpoch||0,s.stepsEpoch||0].join(':');
const unlink=src=>{if(src&&wx.getFileSystemManager)wx.getFileSystemManager().unlink?.({filePath:src,fail:()=>{}});};
const remove=src=>{
  if(src&&src.startsWith(wx.env?.USER_DATA_PATH+'/meal-save-'))unlink(src);
  else if(src&&wx.removeSavedFile)wx.removeSavedFile({filePath:src,fail:()=>{}});
};
function clearLocal(s){
  for(const path of new Set([...Object.values(s.mealPhotos||{}).flat(),s.mealPhotoDraft?.src,s.mealPhotoDraft?.attempt?.file]))remove(path);
  for(const [key,path] of cache)if(key.startsWith(identity(s)+':')){unlink(path);cache.delete(key);}
}
function clearViewFiles(){
  const dir=wx.env?.USER_DATA_PATH,fs=wx.getFileSystemManager?.();
  if(dir&&fs?.readdir)fs.readdir({dirPath:dir,success:r=>{for(const name of r.files)if(/^meal-view-[-a-z0-9]+\.(jpg|png)$/.test(name))unlink(dir+'/'+name);}});
}
function canCapture(s,date){return date===d.localDate()&&s.config?.mealWeeksSupported&&s.config.mealPhotoStorageReady&&s.config.mealRecognitionEnabled&&s.membership?.active&&(!s.membership.expiresAt||s.membership.expiresAt>Date.now())&&s.owner!=='guest';}
const transport=error=>['TRANSPORT_ERROR','TEST_TRANSPORT_ERROR'].includes(error?.code);
const unconfirmed=()=>new Error('暂未确认保存结果，可点重试同步');
const offline=()=>new Error('当前离线，联网后可重试');
function withDeadline(request,ms,error){
  let timer;
  return Promise.race([
    request,
    new Promise((_,reject)=>{timer=setTimeout(()=>reject(error),ms);})
  ]).finally(()=>clearTimeout(timer));
}
async function waitForSave(ticket,check){
  for(let query=0;query<3;query++){
    let result;
    try{result=await withDeadline(api.call('meal.photo.status',ticket),2500,unconfirmed());}
    catch(error){if(transport(error))throw store.get().online===false?offline():unconfirmed();throw error;}
    check();
    if(result.status!=='pending')return result;
    if(query<2)await new Promise(resolve=>setTimeout(resolve,800));
  }
  throw unconfirmed();
}
async function save(draft,consent,update){
  const s=store.get(), owner=identity(s);
  const check=()=>{if(owner!==identity(store.get())||draft.owner!==owner||draft.date!==d.localDate())throw new Error('账号或日期已变化，请重新记录');};
  check();if(s.online===false)throw offline();
  let attempt=draft.attempt,data;
  if(!attempt){
    const sync=require('./syncService');await sync.flush();check();
    const current=store.get();
    if(current.queue.some(x=>x.kind==='meal'&&x.value.date===draft.date&&x.value.slot===draft.slot)||current.conflicts.some(x=>x.operation.kind==='meal'&&x.operation.value.date===draft.date&&x.operation.value.slot===draft.slot))
      throw new Error('该餐记录还未同步，请先同步或处理冲突');
    const old=rules.mealsForDate(current.records,draft.date).find(x=>x.slot===draft.slot);
    let mode='new';
    if(old.text){
      let choice;
      try{choice=await wx.showActionSheet({itemList:['补充到这一餐','替换这一餐']});}
      catch(error){if(/cancel/i.test(error.errMsg||error.message||''))return null;throw error;}
      mode=choice.tapIndex===0?'append':'replace';
    }
    check();if(!await consent())return null;
    check();
    const prepared=await image.prepare(draft.src,[[1024,55],[800,45],[640,35]]);
    check();
    const requestId=repo.id(),file=await image.copyForSave(prepared.path,requestId);
    attempt={requestId,file,mode,mealKey:old.key,baseVersion:old.version,baseText:old.text};
    try{check();update({...draft,attempt});}catch(e){remove(file);throw e;}
    data=prepared.data;
  }
  const ticket={date:draft.date,slot:draft.slot,owner:s.owner,epoch:s.dataEpoch||0,requestId:attempt.requestId};
  const finish=result=>{check();repo.accept(result.state);remove(attempt.file);remove(draft.src);return result;};
  try{
    if(draft.attempt){
      const result=await waitForSave(ticket,check);
      if(result.status==='saved')return finish(result);
      if(result.status==='expired')throw Object.assign(new Error('保存凭据已过期，请重新保存'),{code:'EXPIRED'});
      if(!['missing','retryable'].includes(result.status))throw unconfirmed();
      data=await image.read(attempt.file);
    }
    check();
    if(store.get().online===false)throw offline();
    let result;
    try{
      const request=api.call('meal.photo.save',{...ticket,text:draft.text,analysis:draft.analysis||null,
        consent:true,mode:attempt.mode,mealKey:attempt.mealKey,baseVersion:attempt.baseVersion,baseText:attempt.baseText,
        image:image.imageUrl(data)});
      result=await withDeadline(request,12000,Object.assign(unconfirmed(),{code:'PHOTO_SAVE_TIMEOUT'}));
    }catch(error){
      if(!transport(error)&&!['PENDING','PHOTO_SAVE_TIMEOUT'].includes(error.code))throw error;
      check();
      if(store.get().online===false)throw offline();
      result=await waitForSave(ticket,check);
      if(result.status!=='saved')throw unconfirmed();
    }
    return finish(result);
  }catch(error){
    check();
    if(['VERSION_CONFLICT','EXPIRED','INVALID','PHOTO_FILE_UNREADABLE'].includes(error.code)){
      remove(attempt.file);update({...draft,attempt:null});
      if(error.code==='VERSION_CONFLICT')await require('./syncService').bootstrap(true);
      if(error.code==='PHOTO_FILE_UNREADABLE')throw new Error('本机照片副本已失效，请重新保存这份草稿');
    }
    throw error;
  }
}
function pathFor(id){
  const owner=identity(store.get()), key=owner+':'+id;
  if(cache.has(key))return Promise.resolve(cache.get(key));
  if(pending.has(key))return pending.get(key);
  if(!store.get().online||!wx.env?.USER_DATA_PATH)return Promise.resolve('');
  const request=(async()=>{
    const s=store.get();
    const r=await api.call('meal.photo.get',{id,owner:s.owner,epoch:s.dataEpoch||0});
    if(owner!==identity(store.get()))return '';
    const file=wx.env.USER_DATA_PATH+'/meal-view-'+repo.id()+'.'+(r.extension==='png'?'png':'jpg');
    await new Promise((resolve,reject)=>wx.getFileSystemManager().writeFile({filePath:file,data:r.base64,encoding:'base64',success:resolve,fail:reject}));
    if(owner!==identity(store.get())){unlink(file);return '';}
    cache.set(key,file);
    while(cache.size>24){const [old,src]=cache.entries().next().value;cache.delete(old);unlink(src);}
    return file;
  })().finally(()=>pending.delete(key));
  pending.set(key,request);return request;
}
module.exports={identity,remove,clearLocal,clearViewFiles,canCapture,save,pathFor};
