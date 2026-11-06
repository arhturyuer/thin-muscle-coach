// Test-only diagnostics. Never return environment values or signed payment data.
function status(env,stage) {
  if(stage!=='test')throw new Error('配置自检仅限测试分区');
  const missing=keys=>keys.filter(key=>typeof env[key]!=='string'||!env[key].trim());
  const flag=key=>env[key]==='true'?[]:[key+'=true'];
  const testCheckout=require('./test-checkout').enabled(stage,env);
  const payment=testCheckout?missing(['APP_ID','APP_SECRET','PAY_OFFER_ID','PAY_APP_KEY']):[...missing(['APP_ID','APP_SECRET','PAY_OFFER_ID','PAY_APP_KEY','ENTITLEMENT_SECRET','MESSAGE_TOKEN','MESSAGE_AES_KEY']),...flag('PAYMENT_READY')];
  const content=[...missing(['CONTENT_REVIEW_ID','MEDIA_LICENSE_ID']),...flag('CONTENT_PUBLISHED')];
  let media;try{media=JSON.parse(env.EXERCISE_MEDIA||'{}');}catch(e){media={};}
  for(const {id}of require('./domain').exercises)if(!media||typeof media[id]!=='string'||!/^cloud:\/\//.test(media[id]))content.push('EXERCISE_MEDIA.'+id);
  const keyMissing=!(env.CLOUDBASE_AI_API_KEY||env.CLOUDBASE_APIKEY)?['CLOUDBASE_APIKEY或CLOUDBASE_AI_API_KEY']:[];
  const ai=[...keyMissing,...flag('AI_READY')];
  const nutrition=require('./guided').config(env,stage).numericTargetsEnabled?[]:[...missing(['NUTRITION_REVIEW_ID']),...flag('NUTRITION_READY')];
  const membership=testCheckout?[]:flag('MEMBERSHIP_READY');
  const products=require('./payment-products').forStage(stage,env);
  for(const[sku,key]of Object.entries({month:'PAY_PRODUCT_MONTH',year:'PAY_PRODUCT_YEAR',three_year:'PAY_PRODUCT_THREE_YEAR'}))if(!products[sku])membership.push(key);
  const mealRecognition=[...keyMissing,...flag('MEAL_RECOGNITION_READY')];
  if(!require('./cloudbase-ai').ready({...env,CLOUDBASE_AI_API_KEY:'configured'})){ai.push('CLOUDBASE_AI_BASE_URL与项目环境一致');mealRecognition.push('CLOUDBASE_AI_BASE_URL与项目环境一致');}
  return {testCheckout,payment,content,ai,mealRecognition,nutrition,membership,blocking:[...payment,...membership]};
}
module.exports={status};
