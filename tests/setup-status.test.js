const {test}=require('node:test'),assert=require('node:assert/strict');
const {status}=require('../server/setup-status');
const {memoryCloud,loadEntry}=require('./fixtures/cloud-runtime');
test('setup diagnostics list missing names without exposing supplied credentials',()=>{
 const result=status({APP_ID:'wx-private',APP_SECRET:'secret-never-output',PAY_OFFER_ID:'offer-private',PAY_APP_KEY:'key-private'},'test');
 assert.deepEqual(result.payment,[]);assert.deepEqual(result.blocking,[]);assert.equal(result.testCheckout,true);
 const text=JSON.stringify(result);for(const value of ['wx-private','secret-never-output','offer-private','key-private'])assert.equal(text.includes(value),false);
 assert.ok(result.content.includes('EXERCISE_MEDIA.squat'));assert.ok(result.ai.includes('CLOUDBASE_APIKEY或CLOUDBASE_AI_API_KEY'));
 assert.throws(()=>status({},'prod'),/测试分区/);
});
test('setup endpoint is restricted to the immutable test function stage',async()=>{
 const memory=memoryCloud();
 const testApi=loadEntry('coach_test',memory.scope('test'));
 const prodApi=loadEntry('coach_prod',memory.scope('prod'));
 const result=await testApi({action:'setup.status'});assert.equal(result.code,0);assert.ok(result.data.payment.includes('PAY_APP_KEY'));
 assert.notEqual((await prodApi({action:'setup.status',stage:'test'})).code,0);
});
