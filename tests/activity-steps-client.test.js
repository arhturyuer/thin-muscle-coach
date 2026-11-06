const {test,beforeEach,afterEach}=require('node:test'),assert=require('node:assert/strict');
let storage,store,service,api,oldWx;
function reset(){for(const key of Object.keys(require.cache))if(key.includes('/miniprogram/'))delete require.cache[key];}
beforeEach(()=>{
 oldWx=global.wx;storage=new Map();reset();global.wx={getStorageSync:k=>storage.get(k),setStorageSync:(k,v)=>storage.set(k,structuredClone(v)),removeStorageSync:k=>storage.delete(k),getAccountInfoSync:()=>({miniProgram:{envVersion:'develop'}}),getSetting:({success})=>success({authSetting:{'scope.werun':true}}),login:({success})=>success({code:'code'}),getWeRunData:({success})=>success({cloudID:'verified-id'})};
 store=require('../miniprogram/core/store');store.identify('user-a');service=require('../miniprogram/services/activity-steps');api=require('../miniprogram/services/api');
});
afterEach(()=>{global.wx=oldWx;reset();});
test('first automatic visit never prompts; explicit connect authorizes and transmits only cloud ID',async()=>{
 let prompts=0,calls=0;wx.getSetting=({success})=>success({authSetting:{}});wx.authorize=({scope,success})=>{assert.equal(scope,'scope.werun');prompts++;success();};
 api.call=async(action,input)=>{calls++;assert.equal(action,'activity.steps.sync');assert.deepEqual(input,{cloudID:'verified-id',consent:true});return {days:{},referenceSteps:null};};
 await service.sync();assert.equal(calls,0);await service.sync({connect:true});assert.equal(prompts,1);assert.equal(calls,1);assert.equal(store.get().stepsConsent,true);
 await service.sync();assert.equal(calls,1);
});
test('denial, revoked permission and offline preserve cached steps, distinct from unknown',async()=>{
 const date=require('../shared/domain').localDate(),row={date,steps:0,syncedAt:Date.now(),observedAt:1,sequence:1};
 assert.equal(service.view(store.get()).display,'未同步');store.save({activitySteps:{[date]:row},stepsConsent:true});assert.equal(service.view(store.get()).display,'0');
 wx.getSetting=({success})=>success({authSetting:{}});await service.sync({force:true});assert.match(store.get().stepsStatus,/未授权/);assert.equal(service.view(store.get()).display,'0');
 wx.authorize=({fail})=>fail({errMsg:'authorize:fail auth deny'});await service.sync({connect:true,force:true});assert.match(store.get().stepsStatus,/未授权/);
 store.save({online:false});await service.sync({connect:true,force:true});assert.match(store.get().stepsStatus,/离线/);assert.equal(service.view(store.get()).display,'0');
});
test('network errors keep cached data and allow explicit retry',async()=>{
 store.save({stepsConsent:true});api.call=async()=>{throw new Error('网络失败');};await service.sync({force:true});assert.equal(store.get().stepsStatus,'网络失败');
 api.call=async()=>({days:{[require('../miniprogram/shared/domain').localDate()]:{steps:0,observedAt:Date.now(),sequence:1}},referenceSteps:4000});await service.sync({force:true});assert.equal(store.get().stepsStatus,'');assert.equal(store.get().stepsReference,4000);
});
test('account switch or deletion while native/API calls are in flight never imports old steps',async()=>{
 store.save({stepsConsent:true});let finish,started;const ready=new Promise(r=>started=r);api.call=()=>{started();return new Promise(r=>finish=r);};
 const task=service.sync({force:true});await ready;store.identify('user-b');finish({days:{old:{steps:9000}},referenceSteps:9000});await task;assert.equal(store.get().activitySteps,undefined);
 store.save({stepsConsent:true});let finishAgain,begin;const readyAgain=new Promise(r=>begin=r);api.call=()=>{begin();return new Promise(r=>finishAgain=r);};const another=service.sync({force:true});await readyAgain;store.clear();finishAgain({days:{old:{steps:9000}},referenceSteps:9000});await another;assert.equal(store.get().activitySteps,undefined);
});
test('meal cache requires the saved target version as well as plan and entitlement versions',()=>{
 store.save({entitlement:{id:'week-test',version:1,plan:{version:'guidance-2',energyTargets:{version:'energy-1'}}},mealPlans:{'week-test:2026-11-04':{baseVersion:1,targetVersion:'old'}}});
 const meal=require('../miniprogram/services/meal-plan');assert.equal(meal.cached(store.get(),'2026-11-04'),null);
 store.save({mealPlans:{'week-test:2026-11-04':{baseVersion:1,targetVersion:'energy-1'}}});assert.ok(meal.cached(store.get(),'2026-11-04'));
});
test('bootstrap merging keeps newer steps and remote deletion clears step consent and history',()=>{
 const repo=require('../miniprogram/services/repository'),date='2026-11-04';
 store.save({activitySteps:{[date]:{date,steps:2000,observedAt:200,sequence:2}},stepsConsent:true,dataEpoch:0});
 repo.accept({records:{},incremental:true,activitySteps:{[date]:{date,steps:1000,observedAt:100,sequence:1}},dataEpoch:0});assert.equal(store.get().activitySteps[date].steps,2000);
 repo.accept({records:{},activitySteps:{},dataEpoch:99});assert.deepEqual(store.get().activitySteps,{});assert.equal(store.get().stepsConsent,false);
});
test('previous refusal exposes native settings recovery without repeating authorize or reading data',async()=>{
 let authorizes=0,reads=0;wx.getSetting=({success})=>success({authSetting:{'scope.werun':false}});wx.authorize=()=>authorizes++;wx.getWeRunData=()=>reads++;
 await service.sync({connect:true,force:true});assert.equal(authorizes,0);assert.equal(reads,0);assert.equal(service.view(store.get()).needsSettings,true);assert.equal(store.get().stepsConsent,false);
 await service.settingsChanged({authSetting:{'scope.werun':false}});assert.equal(reads,0);assert.match(store.get().stepsStatus,/仍未开启/);
});
test('returning from native settings with permission enabled logs in and syncs callback-only WeRun data',async()=>{
 const order=[],date=require('../miniprogram/shared/domain').localDate();
 wx.login=({success})=>{queueMicrotask(()=>{order.push('login');success({code:'native-login'});});};
 wx.getWeRunData=({success})=>{assert.deepEqual(order,['login']);queueMicrotask(()=>{order.push('werun');success({cloudID:'fresh-cloud-id'});});};
 api.call=async(action,input)=>{assert.deepEqual(order,['login','werun']);assert.equal(input.cloudID,'fresh-cloud-id');return {days:{[date]:{date,steps:4567,observedAt:Date.now(),syncedAt:Date.now(),sequence:1}}};};
 await service.settingsChanged({authSetting:{'scope.werun':true}});assert.equal(service.view(store.get()).display,'4567');assert.equal(service.view(store.get()).needsSettings,false);assert.equal(store.get().stepsStatus,'');
});
test('login and data failures keep their own stage and are not mislabeled as permission refusal',async()=>{
 wx.login=({fail})=>fail({errMsg:'login:fail network error',errCode:-100});await service.sync({connect:true,force:true});assert.match(store.get().stepsStatus,/登录失败/);assert.equal(store.get().stepsFailure.phase,'login');assert.equal(store.get().stepsFailure.code,-100);assert.equal(store.get().stepsNeedsSettings,false);
 wx.login=({success})=>success({code:'fresh'});wx.getWeRunData=({fail})=>fail({errMsg:'getWeRunData:fail system error',errCode:123});await service.sync({connect:true,force:true});assert.match(store.get().stepsStatus,/取数失败/);assert.equal(store.get().stepsFailure.phase,'werun');assert.equal(store.get().stepsNeedsSettings,false);
});
test('privacy refusal is separate from scope refusal and cloud credentials are not sent when absent',async()=>{
 let calls=0;api.call=async()=>{calls++;};wx.requirePrivacyAuthorize=({fail})=>fail({errMsg:'requirePrivacyAuthorize:fail auth deny'});
 await service.sync({connect:true,force:true});assert.equal(store.get().stepsFailure.phase,'privacy');assert.match(store.get().stepsStatus,/隐私授权/);assert.equal(store.get().stepsNeedsSettings,undefined);
 delete wx.requirePrivacyAuthorize;wx.getWeRunData=({success})=>success({encryptedData:'must-not-be-uploaded',iv:'private-iv'});
 await service.sync({connect:true,force:true});assert.equal(calls,0);assert.equal(store.get().stepsFailure.code,'MISSING_CLOUD_ID');assert.equal(JSON.stringify(store.get()).includes('must-not-be-uploaded'),false);
});
test('missing today is an unavailable day, not a successful zero-step sync',async()=>{
 api.call=async()=>({days:{},referenceSteps:null});await service.sync({connect:true,force:true});assert.equal(service.view(store.get()).display,'未同步');assert.match(store.get().stepsStatus,/暂未返回今天/);
});
test('an unclassified authorization failure still offers settings recovery',async()=>{
 wx.getSetting=({success})=>success({authSetting:{}});wx.authorize=({fail})=>fail({errMsg:'authorize:fail unexpected error'});
 await service.sync({connect:true,force:true});assert.equal(store.get().stepsNeedsSettings,true);assert.match(store.get().stepsStatus,/权限设置/);assert.equal(store.get().stepsFailure.phase,'authorize');
});
test('undeclared privacy scope is a developer-side blocker, not user refusal or a missing switch',async()=>{
 wx.getSetting=({success})=>success({authSetting:{}});wx.authorize=({fail})=>fail({errMsg:'authorize:fail api scope is not declared in the privacy agreement'});
 await service.sync({connect:true,force:true});assert.equal(store.get().stepsFailure.reason,'privacy_not_declared');assert.equal(store.get().stepsNeedsSettings,false);assert.equal(store.get().stepsPlatformBlocked,true);assert.match(store.get().stepsStatus,/微信公众平台/);
 await service.settingsChanged({authSetting:{}});assert.match(store.get().stepsStatus,/不会出现对应开关/);assert.equal(store.get().stepsNeedsSettings,false);
 let called=0;wx.authorize=()=>called++;await service.sync({force:true});assert.equal(called,0);
});
test('an absent WeRun setting is unrequested, not denied, and declaration repair can be retried',async()=>{
 await service.settingsChanged({authSetting:{}});assert.equal(store.get().stepsNeedsSettings,false);assert.match(store.get().stepsStatus,/尚未发起/);
 store.save({stepsPlatformBlocked:true,stepsConsent:false});wx.getSetting=({success})=>success({authSetting:{'scope.werun':true}});
 api.call=async()=>({days:{[require('../miniprogram/shared/domain').localDate()]:{steps:0,observedAt:1,sequence:1}}});await service.sync({connect:true,force:true});assert.equal(store.get().stepsPlatformBlocked,false);assert.equal(store.get().stepsConsent,true);
});
