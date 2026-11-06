/* Structured model estimates, never a measurement or a food catalogue. */
const fields=['weightGrams','energyKcal','proteinGrams','fatGrams','carbGrams'];
const round=x=>Math.round(x*10)/10;
function value(x,key){if(x==null)return null;if(typeof x!=='number'||!Number.isFinite(x)||x<0||x>(key==='energyKcal'?20000:10000))throw new Error('营养估算数值无效');return round(x);}
function sum(foods){return Object.fromEntries(fields.map(key=>[key,foods.length&&foods.every(x=>x[key]!=null)?round(foods.reduce((n,x)=>n+x[key],0)):null]));}
function normalizeFood(food,{allowUnknownEstimates=false}={}){
 if(!food||typeof food.name!=='string'||!food.name.trim()||food.name.length>40||typeof food.portion!=='string'||food.portion.length>60||!['low','medium','high'].includes(food.confidence))throw new Error('食物分析无效');
 const metrics=fields.map(key=>{
  let input=food[key];
  if(allowUnknownEstimates&&typeof input==='string'&&/^\d+(?:\.\d+)?$/.test(input.trim()))input=Number(input);
  try{return [key,value(input,key)];}
  catch(error){if(!allowUnknownEstimates)throw error;return [key,null];}
 });
 const result={name:food.name.trim(),portion:food.portion.trim(),confidence:food.confidence,...Object.fromEntries(metrics)};
 if(result.weightGrams!=null&&result.proteinGrams!=null&&result.fatGrams!=null&&result.carbGrams!=null&&result.proteinGrams+result.fatGrams+result.carbGrams>result.weightGrams*1.1+2){
  if(!allowUnknownEstimates)throw new Error('营养素超过食物重量');
  result.weightGrams=null;
 }
 if(result.energyKcal!=null&&[result.proteinGrams,result.fatGrams,result.carbGrams].every(x=>x!=null)){
  const energy=4*(result.proteinGrams+result.carbGrams)+9*result.fatGrams;
  if(Math.abs(energy-result.energyKcal)>Math.max(60,energy*.3)){
   if(!allowUnknownEstimates)throw new Error('热量与营养素估算不一致');
   result.energyKcal=null;
  }
 }
 return result;
}
function normalizeAnalysis(input,options){
 if(!input||!Array.isArray(input.foods)||input.foods.length>12)throw new Error('食物分析无效');
 const foods=input.foods.map(food=>normalizeFood(food,options)),fraction=input.consumedFraction??1;
 if(typeof fraction!=='number'||!Number.isFinite(fraction)||fraction<=0||fraction>1)throw new Error('请确认实际吃下的比例');
 const title=input.title||foods.map(x=>x.name).join('、').slice(0,80);
 if(typeof title!=='string'||title.length>80)throw new Error('餐食名称过长');
 const totals=sum(foods),consumed=Object.fromEntries(fields.map(k=>[k,totals[k]==null?null:round(totals[k]*fraction)]));
 return {schemaVersion:2,title,foods,totals,consumedFraction:fraction,consumed,estimate:true};
}
function validAnalysis(input){try{const normalized=normalizeAnalysis(input);return input.estimate===true&&fields.every(k=>input.totals?.[k]===normalized.totals[k]&&input.consumed?.[k]===normalized.consumed[k]);}catch(e){return false;}}
function display(input){return Object.fromEntries(fields.map(k=>[k,input?.[k]==null?'待确认':String(round(input[k]))]));}
function mealText(meal){return meal.title+'：'+meal.foods.map(x=>x.name+' '+x.weightGrams+'克'+(x.portion?'（'+x.portion+'）':'')).join('、');}
module.exports={fields,round,sum,normalizeFood,normalizeAnalysis,validAnalysis,display,mealText};
