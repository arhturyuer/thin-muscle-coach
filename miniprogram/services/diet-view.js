const n=require('../shared/nutrition'),rules=require('../shared/daily'),week=require('./meal-week');
const {finite,grams,progress,mealNutrition,dailyNutrition,mealMacros,dailyMacros,fromNutrition}=require('./diet-nutrients');
const kcal=x=>finite(x)?n.round(x)+' 千卡':'待确认';
function foodView(food,id){
  return {id,name:food.name,weight:grams(food.weightGrams),energy:kcal(food.energyKcal)};
}
function build(vm,calendar){
  const date=calendar.selected,records=vm.records||{},weekly=week.view(vm,date);
  const legacy=vm.legacyMealDays?.[date]||Object.values(vm.mealPlans||{}).filter(x=>x.date===date).sort((a,b)=>b.generatedAt-a.generatedAt)[0];
  const day=weekly.day||legacy||null;
  const base=calendar.view.plan?.nutrition;
  const targets=weekly.targets||day?.targets||fromNutrition(base);
  const rows=rules.mealsForDate(records,date).filter(row=>row.slot!=='snack'||row.text).map((row,i)=>{
    const plan=day?.meals?.find(x=>x.slot===row.slot);
    if(!row.text)return {slot:row.slot,label:row.label,recorded:false,energy:plan?kcal(plan.totals?.energyKcal):'',
      macros:plan?mealMacros(plan.totals):[],
      foods:plan?.foods.map((food,j)=>foodView(food,'planned-'+j))||[],text:!plan?base?.meals?.[i]||'':'',photos:[]};
    const {analyses,incomplete,...nutrition}=mealNutrition(records,row);
    const foods=analyses.flatMap(({id,analysis})=>analysis.foods.map((food,j)=>foodView({...food,
      weightGrams:finite(food.weightGrams)?food.weightGrams*analysis.consumedFraction:null,
      energyKcal:finite(food.energyKcal)?food.energyKcal*analysis.consumedFraction:null},id+'-'+j)));
    return {slot:row.slot,key:row.key,label:row.label,recorded:true,canUndo:!!row.value,energy:kcal(nutrition.totals?.energyKcal),foods,
      nutrition,macros:mealMacros(nutrition.totals),text:incomplete||!foods.length?row.text:'',photos:[...new Set(row.value?.photoIds||[])].reverse()};
  });
  const target=targets?.energyKcal;
  const {totals,completed}=dailyNutrition(rows,target),energy=totals.energyKcal;
  const remaining=finite(target)&&finite(energy)?Math.max(0,target-energy):null;
  const isToday=date===vm.date, entitled=!!vm.membership?.active&&(!vm.membership.expiresAt||vm.membership.expiresAt>Date.now()), canRetry=isToday&&entitled&&vm.online&&['failed','empty'].includes(weekly.status)&&vm.mealWeekConsentVersion===1;
  return {...weekly,rows,target:finite(target)?String(Math.round(target)):'待补充评测',consumed:finite(energy)?String(Math.round(energy)):'待确认',
    label:'还需要吃',note:finite(energy)?'按已确认记录估算，不计入建议食谱':'部分餐食热量待确认',title:day?.title||'',reason:day?.reason||'',hasPlan:!!day,remaining:remaining===null?'待确认':String(Math.round(remaining)),numeric:remaining!==null,
    progress:progress(energy,target),macros:dailyMacros(totals,targets),completed:date<=vm.date&&completed,
    canCapture:require('./meal-photo').canCapture(vm,date),canRecord:isToday&&entitled,canRetry,canConsent:isToday&&entitled&&vm.mealWeekConsentVersion!==1,
    captureUnavailable:isToday&&entitled&&!vm.config.mealPhotoStorageReady,
    hint:!isToday&&!day?'这一天暂无已保存的食谱':!vm.online?'当前离线，已保存食谱仍可查看':weekly.status==='generating'?'正在生成本周食谱…':
      weekly.status==='failed'?weekly.message:!entitled&&!day?'开通指导服务后可生成个性化食谱':vm.mealWeekConsentVersion!==1&&!day?'同意新版评测说明后，将自动生成本周食谱。':
      weekly.status==='unavailable'?weekly.message:!day?'本周食谱尚未生成。':''};
}

const methods={
  retryMealWeek(){return this.run(async()=>{await require('./syncService').flush();await week.ensure({retry:true});});},
  openMealConsent(){wx.navigateTo({url:'/pages/assessment/index?mealConsent=1'});},
  loadMealWeek(date){return week.load(date).then(()=>this.setData({mealLoadError:''})).catch(()=>this.setData({mealLoadError:'暂未取回食谱，已保存的安排仍可查看。'}));},
  refreshDietPhotos(diet,date){
    const owner=require('./meal-photo').identity(this.data.vm);
    const ids=diet.rows.flatMap(row=>row.photos.slice(0,1)),key=[owner,date,this.data.vm.online,ids.join(',')].join('|');
    if(this._mealPhotoKey===key)return;
    const previous=this._mealPhotoOwner===owner?this.data.dietPhotos||{}:{};
    this._mealPhotoKey=key;this._mealPhotoOwner=owner;
    this.setData({dietPhotos:Object.fromEntries(ids.filter(id=>previous[id]).map(id=>[id,previous[id]]))});
    if(!ids.length)return;
    (async()=>{
      for(const id of ids){
        if(this._mealPhotoKey!==key)return;
        try{
          const path=await require('./meal-photo').pathFor(id);
          if(path&&this._mealPhotoKey===key)this.setData({['dietPhotos.'+id]:path});
        }catch{/* The record remains readable; tapping the photo retries it. */}
      }
    })();
  },
  previewDietPhoto(e){return this.run(async()=>{
    const id=e.currentTarget.dataset.id,row=this.data.diet.rows.find(r=>r.photos.includes(id));
    if(!row)return;
    const paths=await Promise.all(row.photos.slice(0,12).map(id=>require('./meal-photo').pathFor(id).catch(()=>'')));
    const current=paths[row.photos.indexOf(id)];
    if(!current)throw new Error('暂未取回照片，请联网后重试');
    wx.previewImage({current,urls:paths.filter(Boolean)});
  });}
};
module.exports={build,methods};
