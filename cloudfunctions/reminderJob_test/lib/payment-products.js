// Public product IDs confirmed in the WeChat console on 2026-11-02.
const products = {
  test: {month:'boji_test_month',year:'boji_test_year',three_year:'boji_test_three_year'},
  prod: {month:'boji_prod_month',year:'boji_prod_year',three_year:'boji_prod_three_year'}
};
const variables = {month:'PAY_PRODUCT_MONTH',year:'PAY_PRODUCT_YEAR',three_year:'PAY_PRODUCT_THREE_YEAR'};
function forStage(stage, env=process.env, paymentPlatform) {
  if(!Object.prototype.hasOwnProperty.call(products,stage))throw new Error('无效支付分区');
  if(stage==='test'&&paymentPlatform==='ios')return {month:env.PAY_PRODUCT_IOS_MONTH===undefined?'boji_test_ios_month':env.PAY_PRODUCT_IOS_MONTH};
  return Object.fromEntries(Object.entries(products[stage]).map(([sku,id])=>[
    sku,env[variables[sku]]===undefined?id:env[variables[sku]]
  ]));
}
module.exports={forStage};
