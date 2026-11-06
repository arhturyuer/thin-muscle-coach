const n=require('../shared/nutrition'),rules=require('../shared/daily');
const macros=[['carbGrams','碳水化合物'],['proteinGrams','蛋白质'],['fatGrams','脂肪']];
const finite=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0;
const grams=x=>finite(x)?n.round(x)+' 克':'待确认';
const progress=(done,target)=>finite(done)&&finite(target)&&target>0?Math.min(100,done/target*100):0;

function mealNutrition(records,{planId,date,slot,value}){
  const ids=[...new Set(value?.analysisIds||[])];
  let incomplete=!ids.length||value?.nutritionIncomplete===true;
  const analyses=[];
  for(const id of ids){
    const saved=records[id],entry=saved?.value;
    if(saved?.kind!=='mealAnalysis'||entry?.date!==date||entry.planId!==planId||entry.slot!==slot||!entry.analysis?.consumed){incomplete=true;continue;}
    analyses.push({id,analysis:entry.analysis});
  }
  const consumed=analyses.map(x=>x.analysis.consumed);
  return {analyses,incomplete,totals:incomplete?null:n.sum(consumed),
    knownEnergy:consumed.reduce((sum,x)=>sum+(finite(x.energyKcal)?x.energyKcal:0),0)};
}

function dailyNutrition(rows,target){
  const logged=rows.filter(row=>row.recorded);
  const totals=logged.length?n.sum(logged.map(row=>row.nutrition.totals||{})):
    {energyKcal:0,carbGrams:0,proteinGrams:0,fatGrams:0};
  // Pending entries can't reduce the amount already confirmed.
  const knownEnergy=n.round(logged.reduce((sum,row)=>sum+row.nutrition.knownEnergy,0));
  const completed=rules.slots.slice(0,3).every(slot=>logged.some(row=>row.slot===slot))||
    finite(target)&&target>0&&knownEnergy*10>=target*9;
  return {totals,completed};
}

const mealMacros=totals=>macros.map(([key,label])=>({key,label,value:grams(totals?.[key])}));
const dailyMacros=(totals,targets)=>macros.map(([key,label])=>({key,label,
  consumed:finite(totals[key])&&finite(targets?.[key])?String(n.round(totals[key])):grams(totals[key]),
  target:grams(targets?.[key]),progress:progress(totals[key],targets?.[key])}));

function fromNutrition(nutrition){
  return nutrition&&(nutrition.numericEnabled||nutrition.reviewed)?{energyKcal:nutrition.energy,carbGrams:nutrition.carbohydrate,proteinGrams:nutrition.protein,fatGrams:nutrition.fat}:null;
}

module.exports={finite,grams,progress,mealNutrition,dailyNutrition,mealMacros,dailyMacros,fromNutrition};
