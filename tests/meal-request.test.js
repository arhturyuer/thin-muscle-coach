const {test}=require('node:test'),assert=require('node:assert/strict');
const {run}=require('../miniprogram/services/meal-request');
const timing={initialMs:2,pollMs:1,queryMs:2,maxPolls:5,totalMs:100};
const lost=()=>Object.assign(new Error('lost'),{code:'TRANSPORT_ERROR'});
const current=()=>{};
test('a lost complex-photo response recovers the same result without a second model submission',async()=>{
 let submissions=0,queries=0;const result={foods:[{name:'米饭'},{name:'青菜'},{name:'汤'}]};
 assert.deepEqual(await run({isCurrent:current,submit:async()=>{submissions++;throw lost();},status:async()=>++queries<3?{status:'pending'}:{status:'completed',result}},timing),result);
 assert.equal(submissions,1);assert.equal(queries,3);
});
test('a slow response can finish while the small status calls lose their connection',async()=>{
 const result={foods:[]};let resolve,queries=0;
 assert.deepEqual(await run({isCurrent:current,submit:()=>new Promise(r=>{resolve=r;}),status:async()=>{queries++;resolve(result);throw lost();}},timing),result);
 assert.equal(queries,1);
});
test('retry first restores a completed result or waits for the original in-flight task',async()=>{
 for(const initial of ['completed','pending']){
  let submissions=0,queries=0;
  const result=await run({isCurrent:current,resume:true,submit:async()=>{submissions++;},status:async()=>({status:++queries===1?initial:'completed',result:{foods:[]}})},timing);
  assert.deepEqual(result,{foods:[]});assert.equal(submissions,0);
 }
});
test('retry waits for a second missing result before submitting and can recover during that wait',async()=>{
 const result={foods:[{name:'苹果'}]};let queries=0;
 assert.equal(await run({isCurrent:current,resume:true,submit:async()=>assert.fail('do not resubmit'),
  status:async()=>++queries===1?{status:'missing'}:{status:'completed',result}},timing),result);
 assert.equal(queries,2);
});
test('explicit retry can resubmit a failed request; unavailable status never blindly resends the photo',async()=>{
 let submissions=0;
 await run({isCurrent:current,resume:true,submit:async()=>{submissions++;return {foods:[]};},status:async()=>({status:'failed'})},timing);
 assert.equal(submissions,1);
 await assert.rejects(run({isCurrent:current,resume:true,submit:async()=>{submissions++;},status:async()=>{throw lost();}},timing),e=>e.code==='PHOTO_RECOVERY_PENDING');
 assert.equal(submissions,1);
});
test('quota and authentication errors stop immediately and never trigger transport retries',async()=>{
 for(const code of ['QUOTA_EXCEEDED','MEMBERSHIP_REQUIRED','AI_UNAVAILABLE']){
  let queries=0;
  await assert.rejects(run({isCurrent:current,submit:async()=>{throw Object.assign(new Error(code),{code});},status:async()=>{queries++;}},timing),e=>e.code===code);
  assert.equal(queries,0);
 }
});
test('network recovery is bounded and an account/date/plan change rejects the old result',async()=>{
 let submissions=0;
 await assert.rejects(run({isCurrent:current,submit:async()=>{submissions++;throw lost();},status:async()=>({status:'missing'})},timing),e=>e.code==='PHOTO_RECOVERY_PENDING');
 assert.equal(submissions,2);
 let changed=false;
 await assert.rejects(run({isCurrent:()=>{if(changed)throw new Error('account changed');},submit:async()=>{throw lost();},status:async()=>{changed=true;return {status:'completed',result:{foods:[]}};}},timing),/account changed/);
});
test('a lost upload resends once only after repeated missing status, then resumes the same task',async()=>{
 let submissions=0,queries=0;
 const result={foods:[{name:'米饭'}]};
 assert.deepEqual(await run({isCurrent:current,submit:async()=>{submissions++;throw lost();},status:async()=>({status:++queries<=2?'missing':queries===3?'pending':'completed',result})},timing),result);
 assert.equal(submissions,2);assert.equal(queries,4);
});
