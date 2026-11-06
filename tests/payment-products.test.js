const {test}=require('node:test'),assert=require('node:assert/strict');
const products=require('../server/payment-products'),guided=require('../server/guided');
test('confirmed product IDs are separated by the deployed payment stage',()=>{
 assert.deepEqual(products.forStage('test',{}),{month:'boji_test_month',year:'boji_test_year',three_year:'boji_test_three_year'});
 assert.deepEqual(products.forStage('prod',{}),{month:'boji_prod_month',year:'boji_prod_year',three_year:'boji_prod_three_year'});
 assert.throws(()=>products.forStage('unknown',{}),/分区/);
 assert.deepEqual(products.forStage('test',{},'ios'),{month:'boji_test_ios_month'});
 assert.deepEqual(products.forStage('prod',{},'ios'),products.forStage('prod',{}));
});
test('configured IDs override public defaults and explicitly empty IDs keep sales closed',()=>{
 assert.equal(products.forStage('test',{PAY_PRODUCT_MONTH:'custom-test'}).month,'custom-test');
 const env={MEMBERSHIP_READY:'true',AI_READY:'true',CLOUDBASE_AI_API_KEY:'test',NUTRITION_READY:'true',NUTRITION_REVIEW_ID:'review'};
 assert.equal(guided.config(env,'test').membershipEnabled,true);
 assert.equal(guided.config({...env,PAY_PRODUCT_YEAR:''},'test').membershipEnabled,false);
 assert.equal(guided.config({...env,AI_READY:'false'},'prod').membershipEnabled,false);
});
