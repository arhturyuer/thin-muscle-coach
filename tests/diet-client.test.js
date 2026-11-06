const {test,beforeEach,afterEach}=require('node:test'),assert=require('node:assert/strict');
const {loadPage}=require('./fixtures/mini-runtime');
let store,api,oldWx,date,week,records,vm,calendar,photoId;
const reset=()=>{for(const key of Object.keys(require.cache))if(key.includes('/miniprogram/'))delete require.cache[key];};
beforeEach(()=>{
  oldWx=global.wx;reset();const data=new Map();
  global.wx={getStorageSync:key=>data.get(key),setStorageSync:(key,value)=>data.set(key,structuredClone(value)),
    removeStorageSync:key=>data.delete(key),getAccountInfoSync:()=>({miniProgram:{envVersion:'develop'}})};
  store=require('../miniprogram/core/store');store.identify('test-member');api=require('../miniprogram/services/api');
  const d=require('../miniprogram/shared/domain'),w=require('../miniprogram/shared/workout'),n=require('../shared/nutrition'),rules=require('../shared/daily');
  date=d.localDate();week=w.week(date);photoId='c'.repeat(32);
  const food={name:'米饭',weightGrams:100,energyKcal:120,carbGrams:27,proteinGrams:2,fatGrams:0.5,portion:'熟重',confidence:'medium'};
  const analysis=n.normalizeAnalysis({foods:[food],consumedFraction:.5}),id='analysis-id',planId=rules.dietScope(date);
  records={
    [rules.mealKey(planId,date,'lunch')]:{kind:'meal',version:1,value:{planId,date,slot:'lunch',text:'实际吃了米饭',analysisIds:[id,id],photoIds:[photoId],source:'photo',at:Date.now()}},
    [id]:{kind:'mealAnalysis',version:1,value:{planId,date,slot:'lunch',analysis}}
  };
  const meal=slot=>({slot,title:'建议餐',foods:[{...food,name:'计划中的糙米'}],totals:food});
  const day={date,title:'均衡搭配',reason:'参考你常吃的食物',targets:{energyKcal:1800,carbGrams:200,proteinGrams:100,fatGrams:60},meals:['breakfast','lunch','dinner'].map(meal)};
  vm={...store.get(),records,date,mealWeeks:{[week.start]:{weekStart:week.start,days:[day]}},config:{mealWeeksSupported:true,mealPhotoStorageReady:true,mealRecognitionEnabled:true},membership:{active:true},mealWeekConsentVersion:1,isMember:true};
  calendar={selected:date,isToday:true,view:{}};
});
afterEach(()=>{global.wx=oldWx;reset();});

test('shared diet view overlays actual food, scales weights once and leaves each missing nutrient independent',()=>{
  const view=require('../miniprogram/services/diet-view').build,first=view(vm,calendar);
  assert.equal(first.remaining,'1740');
  assert.deepEqual(first.macros.map(x=>[x.consumed,x.target]),[['13.5','200 克'],['1','100 克'],['0.3','60 克']]);
  assert.equal(first.macros[0].progress,6.75);
  const row=first.rows.find(x=>x.slot==='lunch');
  assert.deepEqual(row.photos,[photoId]);assert.equal(row.foods[0].name,'米饭');assert.equal(row.foods[0].weight,'50 克');
  assert.deepEqual(row.macros.map(x=>x.value),['13.5 克','1 克','0.3 克']);
  assert.equal(row.foods[0].macros,undefined);
  assert.equal(first.rows[0].foods[0].name,'计划中的糙米');
  assert.deepEqual(first.rows[0].macros.map(x=>x.value),['27 克','2 克','0.5 克']);
  const n=require('../shared/nutrition'),a=records['analysis-id'].value.analysis;
  records['analysis-id'].value.analysis=n.normalizeAnalysis({...a,foods:a.foods.map(x=>({...x,proteinGrams:null}))});
  const second=view(vm,calendar);
  assert.equal(second.remaining,'1740');assert.equal(second.macros.find(x=>x.key==='proteinGrams').consumed,'待确认');
  const id=Object.keys(records).find(key=>key.startsWith('meal:'));
  records[id].value.nutritionIncomplete=true;
  assert.equal(view(vm,calendar).remaining,'待确认');
});

test('meal totals combine confirmed portions and progress caps at the daily target',()=>{
  const view=require('../miniprogram/services/diet-view').build,n=require('../shared/nutrition');
  const original=records['analysis-id'],food=original.value.analysis.foods[0];
  const highCarb={...food,name:'意面',energyKcal:800,carbGrams:200,weightGrams:350};
  records.second={...original,value:{...original.value,analysis:n.normalizeAnalysis({foods:[highCarb,food]})}};
  Object.values(records).find(r=>r.kind==='meal').value.analysisIds.push('second');
  const diet=view(vm,calendar),lunch=diet.rows.find(x=>x.slot==='lunch');
  assert.equal(lunch.foods.length,3);
  assert.equal(lunch.macros[0].value,'240.5 克');
  assert.deepEqual([diet.macros[0].consumed,diet.macros[0].progress],['240.5',100]);
});

test('diet stamp requires all three logged meals or at least 90% of the selected date target',()=>{
  const view=require('../miniprogram/services/diet-view').build,rules=require('../shared/daily'),n=require('../shared/nutrition');
  const {value}=records['analysis-id'],food=value.analysis.foods[0];
  const log=(slot,entryDate=date)=>{
    const planId=rules.dietScope(entryDate),key=rules.mealKey(planId,entryDate,slot);
    records[key]={kind:'meal',value:{planId,date:entryDate,slot,text:'手动记录'}};
    return key;
  };
  log('breakfast');log('snack');log('dinner',require('../shared/workout').shift(date,-1));
  assert.equal(view(vm,calendar).completed,false);
  const setEnergy=energyKcal=>{value.analysis=n.normalizeAnalysis({foods:[{...food,energyKcal,carbGrams:null}]});};
  setEnergy(1619.9);
  assert.equal(view(vm,calendar).completed,false);
  setEnergy(1620);
  assert.equal(view(vm,calendar).completed,true);
  setEnergy(120);
  assert.equal(view(vm,calendar).completed,false);
  const dinner=log('dinner');
  assert.equal(view({...vm,mealWeeks:{}},calendar).completed,true);
  records[dinner].value.text='';
  assert.equal(view(vm,calendar).completed,false);
});

test('today opens the detail at the selected date; detail changes date and blocks capture outside today',()=>{
  let route;wx.navigateTo=({url})=>{route=url;};
  require('../miniprogram/services/analytics').track=()=>{};
  const today=loadPage('today'),detail=loadPage('nutrition'),next=require('../shared/workout').shift(date,1);
  today.setData({calendar:{selected:next}});today.openNutrition();
  assert.equal(route,'/pages/nutrition/index?date='+next);
  detail.loadMealWeek=()=>Promise.resolve();detail.onLoad({date});detail.setData({vm});detail.render();
  assert.equal(detail.data.diet.remaining,'1740');assert.equal(detail.data.diet.canCapture,true);
  detail.selectDate({detail:{date:next}});
  assert.equal(detail.data.calendar.selected,next);assert.equal(detail.data.diet.canCapture,false);
});

test('offline skips weekly ensure and retry preserves the last saved plan',async()=>{
  store.save({...vm,online:false});
  const meals=require('../miniprogram/services/meal-week');
  let calls=0;
  api.call=async(action,input)=>{calls++;assert.equal(action,'meal.plan.ensure');assert.equal(input.owner,'test-member');return {status:'failed',message:'暂时失败'};};
  await meals.ensure();assert.equal(calls,0);
  store.save({online:true});await meals.ensure();await meals.ensure();assert.equal(calls,1);
  assert.equal(meals.view(store.get(),date).day.title,'均衡搭配');
  await meals.ensure({retry:true});assert.equal(calls,2);
});

test('a failed upload keeps the same confirmation draft and does not change the meal',async()=>{
  const photo=require('../miniprogram/services/meal-photo'),saved=[];
  store.save({...vm,online:true,records:{}});
  wx.getImageInfo=async()=>({width:600,height:900});
  wx.compressImage=async()=>({tempFilePath:'/local-picture'});
  wx.env={USER_DATA_PATH:'/data'};
  wx.removeSavedFile=({filePath})=>saved.push(filePath);
  wx.getFileSystemManager=()=>({readFile:({success})=>success({data:'/9j/AQ=='}),
    copyFile:({srcPath,success})=>{assert.equal(srcPath,'/local-picture');success();},
    unlink:({filePath})=>saved.push(filePath)});
  const body={src:'/local-picture',owner:photo.identity(store.get()),date,slot:'lunch',text:'实际吃的饭'};
  let draft=body,calls=[],confirmations=0;
  const confirm=async()=>{confirmations++;return true;};
  api.call=async(action,data)=>{
    if(action==='meal.photo.status')return {status:'retryable'};
    assert.equal(action,'meal.photo.save');calls.push(data);
    if(calls.length===1)throw Object.assign(new Error('照片上传失败'),{code:'PHOTO_STORAGE_FAILED'});
    const scope=require('../shared/daily').dietScope(date);
    return {key:data.mealKey,state:{dataEpoch:0,records:{[data.mealKey]:{kind:'meal',value:{planId:scope,slot:'lunch',date,text:body.text,source:'photo'}}}}};
  };
  await assert.rejects(photo.save(draft,confirm,value=>{draft=value;}),/照片上传失败/);
  assert.deepEqual(store.get().records,{});assert.ok(draft.attempt);
  await photo.save(draft,confirm,value=>{draft=value;});
  assert.equal(confirmations,1);assert.deepEqual(calls[0],calls[1]);
  assert.equal(store.get().records[calls[0].mealKey].value.text,body.text);
  assert.deepEqual(saved,['/data/meal-save-'+calls[0].requestId,'/local-picture']);
});

test('the result page saves once on a double tap and recovers a committed meal after a lost response',async()=>{
  const photo=require('../miniprogram/services/meal-photo');
  store.save({...vm,online:true,records:{}});
  const draft={weekly:true,requestId:'recognition-1',src:'/local-picture',owner:photo.identity(store.get()),date,slot:'lunch',text:'苹果'};
  store.save({mealPhotoDraft:draft});
  wx.getImageInfo=async()=>({width:600,height:900});
  wx.compressImage=async()=>({tempFilePath:'/local-picture'});
  wx.env={USER_DATA_PATH:'/data'};
  wx.getFileSystemManager=()=>({readFile:({success})=>success({data:'/9j/AQ=='}),copyFile:({success})=>success()});
  wx.showModal=async({confirmText})=>{
    if([...confirmText].length>4)throw {errMsg:'showModal:fail invalid confirmText'};
    assert.equal(confirmText,'确认保存');
    return {confirm:true};
  };
  wx.navigateBack=()=>{};
  const page=loadPage('meal-result'),calls=[],events=[];
  require('../miniprogram/services/analytics').track=()=>{};
  page.setData({draft});page._opener={emit:(...args)=>events.push(args)};
  api.call=async(action,data)=>{
    calls.push({action,id:data.requestId});
    if(action==='meal.photo.save')throw Object.assign(new Error('连接失败'),{code:'TEST_TRANSPORT_ERROR'});
    const key=require('../shared/daily').mealKey(require('../shared/daily').dietScope(date),date,'lunch');
    return {status:'saved',key,state:{dataEpoch:0,records:{[key]:{kind:'meal',value:{text:'苹果'}}}}};
  };
  await Promise.all([page.savePhoto(),page.savePhoto()]);
  assert.deepEqual(calls.map(x=>x.action),['meal.photo.save','meal.photo.status']);
  assert.equal(calls[0].id,calls[1].id);
  assert.equal(store.get().mealPhotoDraft,null);
  assert.equal(events.length,1);
});

test('a local read failure leaves the photo draft editable and makes no upload request',async()=>{
  const photo=require('../miniprogram/services/meal-photo');
  store.save({...vm,online:true,records:{}});
  const draft={weekly:true,requestId:'recognition-2',src:'/local-picture',owner:photo.identity(store.get()),date,slot:'lunch',text:'苹果'};
  store.save({mealPhotoDraft:draft});
  wx.getImageInfo=async()=>({width:600,height:900});
  wx.compressImage=async()=>({tempFilePath:'/local-picture'});
  wx.getFileSystemManager=()=>({readFile:({fail})=>fail({errMsg:'readFile:fail'})});
  wx.showModal=async()=>({confirm:true});
  api.call=async()=>assert.fail('local error must not send a cloud request');
  const page=loadPage('meal-result');page.setData({draft});
  await page.savePhoto();
  assert.match(page.data.saveError,/无法读取本机照片/);
  assert.equal(page.canEdit(),true);
  assert.deepEqual(store.get().mealPhotoDraft,draft);
});

test('portrait recognition compresses the long edge and lowers quality only when the payload is too large',async()=>{
  const data='/9j/AQ==',calls=[];
  wx.getImageInfo=async()=>({width:3000,height:4000});
  wx.compressImage=async options=>{calls.push(options);return {tempFilePath:'/compressed-'+calls.length};};
  wx.getFileSystemManager=()=>({readFile:({filePath,success})=>success({data:filePath.endsWith('-1')?'/9j/'+ 'A'.repeat(819200):data})});
  assert.equal(await require('../miniprogram/services/meal-ai').compressedImage('/portrait'),'data:image/jpeg;base64,'+data);
  assert.deepEqual(calls,[{src:'/portrait',compressedHeight:1280,quality:75},{src:'/portrait',compressedHeight:1080,quality:60}]);
});
