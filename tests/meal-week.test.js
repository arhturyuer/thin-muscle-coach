const {test}=require('node:test'),assert=require('node:assert/strict');
const {memoryCloud}=require('./fixtures/cloud-runtime'),week=require('../server/meal-week'),photos=require('../server/meal-photo'),d=require('../shared/domain'),daily=require('../shared/daily'),business=require('../server/business'),manifest=require('../server/stages.json'),n=require('../shared/nutrition');
const cfg={aiEnabled:true,numericTargetsEnabled:true,nutritionReviewed:true,mealPhotoStorageReady:true};
const assessment={schemaVersion:3,consent:true,screening:'clear',age:28,sex:'male',height:175,weight:70,targetWeight:70,pace:'moderate',stepGoal:6000,waist:'',goal:'habit',experience:'beginner',activity:'light',minutes:15,frequency:3,weekdays:[1,3,5],equipment:'none',foodScene:'cook',foodObstacle:'irregular',diet:'none',allergies:''};
const time=date=>Date.parse(date+'T12:00:00+08:00');
const food={name:'米饭',weightGrams:250,energyKcal:320,proteinGrams:8,fatGrams:1,carbGrams:70,portion:'熟重',confidence:'medium'};
const ensure={action:'meal.plan.ensure',requestId:'ensure-week',owner:'same-user',epoch:0};
const consent={action:'meal.plan.consent',owner:'same-user',epoch:0,version:1};
const provider=c=>({days:c.calendar.map(date=>({date,title:'均衡三餐',reason:'根据评测与家常饮食安排。',meals:['breakfast','lunch','dinner'].map(slot=>({slot,title:'主食与豆腐',foods:[food,{...food,name:'豆腐',energyKcal:Math.round(c.targets.energy/3-food.energyKcal),proteinGrams:30,fatGrams:30,carbGrams:5}]}))}))});
async function setup(date='2026-11-05',{paid=true,authorized=true,assessed=true}={}){
  const m=memoryCloud(),runtime=m.scope('test'),now=time(date);
  await runtime.transact('same-user',s=>{
    if(paid)s.orders.push({id:'paid-month',sku:'month',months:1,paidAt:now-d.DAY,status:'paid'});
    if(assessed)s.records.assessment={kind:'assessment',value:assessment,version:1,revision:++s.revision};
    if(authorized)s.mealWeekConsentVersion=1;
  });
  return {m,runtime,date,now};
}

test('weekly meals require payment and separately versioned consent; Sunday and Monday generate different ranges without a legacy entitlement',async()=>{
  const {runtime,now}=await setup('2026-11-08',{paid:false,authorized:false});
  await assert.rejects(week.handle(ensure,runtime,cfg,now,provider),e=>e.code==='MEMBERSHIP_REQUIRED');
  await runtime.transact('same-user',s=>s.orders.push({id:'paid-month',sku:'month',months:1,paidAt:now-1,status:'paid'}));
  assert.equal((await week.handle(ensure,runtime,cfg,now,provider)).status,'consent');
  await week.handle(consent,runtime,cfg,now);
  assert.deepEqual((await week.handle(ensure,runtime,cfg,now,provider)).plan.days.map(x=>x.date),['2026-11-08']);
  const monday=await week.handle(ensure,runtime,cfg,now+d.DAY,provider);
  assert.equal(monday.plan.days[0].date,'2026-11-09');assert.equal(monday.plan.days[6].date,'2026-11-15');
  const historical=await week.handle({action:'meal.plan.get',owner:'same-user',epoch:0,from:'2026-11-02',to:'2026-11-09'},runtime,cfg,now+d.DAY);
  assert.equal(historical.weeks.length,2);
});

test('concurrent weekly ensures share a lease; a later goal update preserves yesterday and actual food',async()=>{
  const {runtime,now,date}=await setup();
  let finish,entered;const started=new Promise(r=>entered=r);
  const pending=week.handle(ensure,runtime,cfg,now,c=>{entered();return new Promise(r=>finish=()=>r(provider(c)));});
  await started;
  assert.equal((await week.handle(ensure,runtime,cfg,now,()=>assert.fail('duplicate generation'))).status,'generating');
  finish();const initial=await pending;
  assert.equal(initial.status,'ready');
  const next='2026-11-06',planId=daily.dietScope(next),key=daily.mealKey(planId,next,'lunch');
  const input={kind:'meal',key,id:'meal-a',baseVersion:0,value:{planId,date:next,slot:'lunch',text:'实际吃了青菜',at:now+d.DAY,source:'text'}};
  await runtime.transact('same-user',s=>{
    assert.equal(business.applyBatch(s,[input],now+d.DAY)[0].status,'ok');
    s.mealNutritionBasis={assessment:{...assessment,stepGoal:6001},assessmentRevision:s.records.assessment.revision};
  });
  const reused=await week.handle(ensure,runtime,cfg,now+d.DAY,()=>assert.fail('unchanged rounded targets must reuse'));
  assert.equal(reused.plan.version,1);
  await runtime.transact('same-user',s=>{s.mealNutritionBasis.assessment={...assessment,targetWeight:68,pace:'gentle'};});
  const updated=await week.handle(ensure,runtime,cfg,now+d.DAY,c=>{
    assert.equal(c.calendar[0],next);assert.match(c.history[0].title,/青菜/);return provider(c);
  });
  assert.equal(updated.plan.version,2);
  assert.deepEqual(updated.plan.days.find(x=>x.date===date),initial.plan.days[0]);
  assert.notEqual(updated.plan.days[1].targets.energyKcal,initial.plan.days[1].targets.energyKcal);
  await runtime.transact('same-user',s=>assert.equal(s.records[key].value.text,input.value.text));
});

test('bad model data cannot replace a saved week, and fresh reassessment allows retry',async()=>{
  const {runtime,now}=await setup();
  const good=(await week.handle(ensure,runtime,cfg,now,provider)).plan;
  await runtime.transact('same-user',s=>{s.records.assessment={kind:'assessment',value:{...assessment,allergies:'虾'},version:2,revision:++s.revision};});
  const invalid=await week.handle(ensure,runtime,cfg,now,c=>{
    const result=provider(c);result.days[0].meals[0].foods[0]={...food,name:'虾'};return result;
  });
  assert.equal(invalid.status,'failed');assert.deepEqual(invalid.plan,good);
  const retry=await week.handle(ensure,runtime,cfg,now,provider);assert.equal(retry.plan.version,2);
});

test('an assessment saved after payment authorizes automatic generation; in-flight old results are discarded',async()=>{
  const {runtime,now}=await setup('2026-11-05',{authorized:false,assessed:false});
  await runtime.transact('same-user',s=>{
    const op={kind:'assessment',key:'assessment',id:'assessment-op',baseVersion:0,value:{...assessment,mealWeekConsentVersion:1}};
    assert.equal(business.applyBatch(s,[op],now)[0].status,'ok');
    assert.equal(business.publicState(s).mealWeekConsentVersion,1);
  });
  const stale=await week.handle(ensure,runtime,cfg,now,async c=>{
    await runtime.transact('same-user',s=>{s.records.assessment.version++;s.records.assessment.value={...assessment,foodScene:'canteen'};});
    return provider(c);
  });
  assert.equal(stale.plan,null);
  assert.equal((await week.handle(ensure,runtime,cfg,now,provider)).status,'ready');
});

const jpeg=Buffer.from([0xff,0xd8,0xff,0x01]);
function mockStorage(runtime){
  const objects=new Map();let uploads=0,failNext=false;
  runtime.cloud.uploadFile=async ({cloudPath,fileContent})=>{
    uploads++;
    if(failNext){failNext=false;throw new Error('network');}
    const fileID=manifest.storageFilePrefix+cloudPath;objects.set(fileID,fileContent);return {fileID};
  };
  runtime.cloud.downloadFile=async({fileID})=>({fileContent:objects.get(fileID)});
  runtime.cloud.deleteFile=async({fileList})=>({fileList:fileList.map(fileID=>{objects.delete(fileID);return {fileID,status:0};})});
  return {objects,uploads:()=>uploads,fail:()=>{failNext=true;}};
}
function capture(date,patch={}){
  const slot='lunch',planId=daily.dietScope(date);
  return {action:'meal.photo.save',requestId:'photo-save-1',owner:'same-user',epoch:0,date,slot,mealKey:daily.mealKey(planId,date,slot),baseVersion:0,baseText:'',text:'实际吃了半碗米饭',mode:'new',consent:true,
    analysis:n.normalizeAnalysis({foods:[food],consumedFraction:.5}),image:'data:image/jpeg;base64,'+jpeg.toString('base64'),...patch};
}
test('restaurant photo retries are atomic, scoped to caller and readable from a second client without a file URL',async()=>{
  const {m,runtime,date,now}=await setup(),storage=mockStorage(runtime),event=capture(date);
  const status={action:'meal.photo.status',requestId:event.requestId,date,slot:event.slot,owner:event.owner,epoch:event.epoch};
  assert.deepEqual(await photos.handle(status,runtime,cfg,now),{status:'missing'});
  storage.fail();
  await assert.rejects(photos.handle(event,runtime,cfg,now),e=>e.code==='PHOTO_STORAGE_FAILED');
  assert.deepEqual(await photos.handle(status,runtime,cfg,now),{status:'retryable'});
  assert.equal(await runtime.transact('same-user',s=>s.records[event.mealKey]),undefined);
  const first=await photos.handle(event,runtime,cfg,now);
  const duplicate=await photos.handle(event,runtime,cfg,now);
  const receipt=await photos.handle(status,runtime,cfg,now);
  assert.equal(receipt.status,'saved');assert.equal(receipt.key,first.key);
  assert.equal(Object.values(receipt.state.records).filter(x=>x.kind==='meal').length,1);
  assert.equal(first.key,duplicate.key);assert.equal(storage.uploads(),2);
  const actual=first.state.records[first.key],id=actual.value.photoIds[0];
  assert.equal(first.state.records[actual.value.analysisIds[0]].value.analysis.consumed.energyKcal,160);
  assert.equal(JSON.stringify(first).includes('cloud://'),false);
  assert.deepEqual(await photos.handle({action:'meal.photo.get',id,owner:'same-user',epoch:0},runtime,cfg,now),{base64:jpeg.toString('base64'),extension:'jpg'});
  m.setContext({OPENID:'different-user'});
  await assert.rejects(photos.handle({action:'meal.photo.get',id,owner:'different-user',epoch:0},runtime,cfg,now),e=>e.code==='UNAUTHORIZED');
  await assert.rejects(photos.handle(event,runtime,cfg,now),e=>e.code==='ACCOUNT_CHANGED');
  await assert.rejects(photos.handle(status,runtime,cfg,now),e=>e.code==='ACCOUNT_CHANGED');
  m.setContext({OPENID:'same-user'});
  await assert.rejects(photos.handle({...status,slot:'dinner'},runtime,cfg,now),e=>e.code==='INVALID');
  await assert.rejects(photos.handle({...event,requestId:'photo-other'},runtime,cfg,now),e=>e.code==='VERSION_CONFLICT');
});

test('status polling leaves an active photo upload alone and rejects concurrent saves',async()=>{
  const {runtime,date,now}=await setup(),event=capture(date);
  const status={action:'meal.photo.status',requestId:event.requestId,date,slot:event.slot,owner:event.owner,epoch:0};
  let started,finish,uploads=0;
  const ready=new Promise(resolve=>{started=resolve;});
  runtime.cloud.uploadFile=({cloudPath})=>new Promise(resolve=>{
    uploads++;finish=()=>resolve({fileID:manifest.storageFilePrefix+cloudPath});started();
  });
  const save=photos.handle(event,runtime,cfg,now);
  await ready;
  assert.deepEqual(await photos.handle(status,runtime,cfg,now),{status:'pending'});
  await assert.rejects(photos.handle(event,runtime,cfg,now),error=>error.code==='PENDING');
  finish();await save;
  assert.equal((await photos.handle(status,runtime,cfg,now)).status,'saved');
  assert.equal(uploads,1);
});

test('replacement and undo switch private references; no arbitrary photo can be attached through batch sync',async()=>{
  const {runtime,date,now}=await setup(),storage=mockStorage(runtime),event=capture(date);
  const first=await photos.handle(event,runtime,cfg,now),a=first.state.records[first.key].value.photoIds[0];
  const result=await photos.handle({...event,requestId:'photo-save-2',baseText:event.text,baseVersion:1,mode:'replace',text:'新的餐食'},runtime,cfg,now);
  const row=result.state.records[first.key], [b]=row.value.photoIds;
  await assert.rejects(photos.handle({action:'meal.photo.get',id:a,owner:'same-user',epoch:0},runtime,cfg,now),e=>e.code==='UNAUTHORIZED');
  await photos.cleanup(runtime,'same-user',now);assert.equal(storage.objects.size,2);
  const undo={id:'undo-photo',kind:'meal',key:first.key,baseVersion:2,value:{...row.value,text:event.text,previous:row.value.text,source:'undo',photoIds:[a],previousPhotoIds:[b],analysisIds:row.value.previousAnalysisIds,previousAnalysisIds:row.value.analysisIds}};
  await runtime.transact('same-user',s=>{
    assert.equal(business.applyBatch(s,[{...undo,id:'forge-photo',value:{...undo.value,photoIds:['f'.repeat(32)]}}],now)[0].status,'invalid');
    assert.equal(business.applyBatch(s,[undo],now)[0].status,'ok');
  });
  await photos.handle({action:'meal.photo.get',id:a,owner:'same-user',epoch:0},runtime,cfg,now);
  await assert.rejects(photos.handle({action:'meal.photo.get',id:b,owner:'same-user',epoch:0},runtime,cfg,now),e=>e.code==='UNAUTHORIZED');
  await runtime.transact('same-user',s=>{photos.reset(s);s.records={};s.deletedAt=now+1;});
  await photos.cleanup(runtime,'same-user',now+1);
  assert.equal(storage.objects.size,0);
});
