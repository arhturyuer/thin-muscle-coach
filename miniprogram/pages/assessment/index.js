const page=require('../../core/page'),store=require('../../core/store'),coach=require('../../services/coach'),analytics=require('../../services/analytics');
const originalFields=[
 [{key:'screening',title:'目前是否适合一般饮食与运动指导？',options:[['clear','已成年，无疼痛、近期受伤、孕哺期、相关疾病或医嘱限制'],['guidance','存在相关情况，或不确定']]}],
 [{key:'sex',title:'生理性别（用于估算营养需求）',options:[['female','女性'],['male','男性']]},{key:'age',title:'年龄',type:'number',unit:'岁'},{key:'height',title:'身高',type:'digit',unit:'厘米'},{key:'weight',title:'体重',type:'digit',unit:'千克'},{key:'waist',title:'腰围（选填）',type:'digit',unit:'厘米'}],
 [{key:'goal',title:'当前最想从哪里开始？',options:[['fat_loss','减脂，逐步显出线条'],['muscle','增肌，积累力量'],['habit','先把生活练规律']]},{key:'experience',title:'训练经验',options:[['beginner','刚开始训练'],['occasional','偶尔训练，想更规律']]},{key:'activity',title:'平时的活动量',options:[['sedentary','大部分时间坐着'],['light','有走动和通勤'],['active','日常活动较多']]}],
 [{key:'minutes',title:'每次能留出多久？',options:[['15','15 分钟'],['30','30 分钟']]},{key:'frequency',title:'一周能练几天？',options:[['2','2 天'],['3','3 天'],['4','4 天']]},{key:'equipment',title:'手边有什么器械？',options:[['none','无器械，自重训练'],['band','有弹力带']]}],
 [{key:'foodScene',title:'平时主要怎么吃？',options:[['takeout','外卖为主'],['canteen','食堂为主'],['cook','自己做饭']]},{key:'foodObstacle',title:'最希望先解决什么？',options:[['irregular','吃饭不规律'],['protein','不知道怎么搭配蛋白质食物'],['snacking','经常随手吃零食']]},{key:'diet',title:'饮食偏好',options:[['none','无特别偏好'],['vegetarian','素食']]},{key:'allergies',title:'过敏与饮食禁忌，没有请留空',type:'text',unit:''}]
];
const fields = [originalFields[0], originalFields[1].slice(0,2), originalFields[1].slice(2,4), [originalFields[1][4],originalFields[2][2]], [...originalFields[2].slice(0,2),{key:'targetWeight',title:'目标体重',type:'digit',unit:'千克'},{key:'pace',title:'接近目标的速度',options:[['gentle','温和'],['moderate','适中'],['fast','极速（受强度限制）']]}], [...originalFields[3],{key:'stepGoal',title:'每日步数目标（可修改建议值）',type:'number',unit:'步'}], [], originalFields[4].slice(0,2), originalFields[4].slice(2)];
const titles=['先确认适用范围','了解身体起点','记录身高体重','补充身体信息','找到你的方向','留出训练时间','安排训练日期','了解饮食习惯','补充饮食偏好'];
const numeric = {age:{min:18,max:100,reference:28,unit:'岁',integer:true},height:{min:100,max:230,reference:170,unit:'厘米'},weight:{min:30,max:250,reference:65,unit:'千克'},waist:{min:30,max:250,reference:80,unit:'厘米'}};
numeric.targetWeight={...numeric.weight};numeric.stepGoal={min:1000,max:20000,reference:6000,unit:'步',integer:true};
const FLOW_VERSION=4;
page({
 data:{step:1,totalSteps:9,keyboardHeight:0,form:{schemaVersion:3,targetWeight:'',pace:'moderate',stepGoal:6000,screening:'',consent:false,sex:'',age:'',height:'',weight:'',waist:'',goal:'',experience:'',activity:'',minutes:15,frequency:3,equipment:'none',weekdays:[],foodScene:'',foodObstacle:'',diet:'none',allergies:''},error:'',days:['周日','周一','周二','周三','周四','周五','周六']},
 onLoad(options = {}){
  const s=store.get();
  const a=s.records.assessment?.value||s.entitlement?.plan?.assessment||s.orders?.filter(x=>x.status==='paid'&&!x.redacted&&x.plan?.assessment).sort((a,b)=>b.paidAt-a.paidAt)[0]?.plan.assessment;
  const g=require('../../shared/guidance');
  if(options.mealConsent==='1'&&a&&!g.validate(a)&&g.suitable(a)){this.setData({mealConsentOnly:true});return;}
  const previous = options.restart === '1' ? s.records.assessment?.value || s.entitlement?.plan?.assessment || s.preview?.assessment || s.draft : null;
  if(previous){
   this.setData({form:{...this.data.form,...previous,schemaVersion:3,consent:false,mealWeekConsentVersion:undefined},step:1});
  }else if([2,3].includes(s.draft.schemaVersion)&&s.draft.consent){
   const oldStep=Math.max(1,Math.min(5,Number(s.assessmentStep)||1));
   let step=s.assessmentFlowVersion>=2?Math.max(1,Math.min(9,Number(s.assessmentStep)||1)):[1,2,5,6,8][oldStep-1];
   if(s.draft.schemaVersion===2&&step>5)step=5;
   this.setData({form:{...this.data.form,...s.draft,schemaVersion:3},step:s.config.mealWeeksSupported&&s.draft.mealWeekConsentVersion!==1?1:step});
  }
  this._stepsEdited=!!(previous || s.draft).stepGoal;this.update();analytics.track('assessment_started');
 },
 acceptMealConsent(){return this.run(async()=>{await require('../../services/meal-week').consent();wx.navigateBack();});},
 update(){const i=this.data.step-1;this.setData({title:titles[i],fields:fields[i].map(f=>({...f,numeric:f.key==='stepGoal'?null:numeric[f.key]||null,options:(f.options||[]).map(([value,label])=>({value,label}))})),percent:Math.round(i/9*100),selectedDays:this.data.days.map((label,i)=>({label,value:String(i),checked:this.data.form.weekdays.map(Number).includes(i)}))});},
 persist(){if(this.data.form.consent)store.save({draft:this.data.form,assessmentStep:this.data.step,assessmentFlowVersion:FLOW_VERSION});},
 change(e){if(this.data.busy)return;const key=e.currentTarget.dataset.key;let value=e.detail.value;if(['minutes','frequency'].includes(key))value=+value;const patch={...this.data.form,[key]:value};if(key==='activity'&&!this._stepsEdited)patch.stepGoal=require('../../shared/guidance').energyPolicy.steps[value];if(key==='stepGoal')this._stepsEdited=true;this.setData({form:patch,error:''});this.persist();},
 keyboard(e){this.setData({keyboardHeight:Math.max(0,e.detail.height||0)});},
 weekdays(e){if(this.data.busy)return;this.setData({form:{...this.data.form,weekdays:e.detail.value.map(Number)},error:''});this.persist();this.update();},
 back(){if(this.data.busy||this.data.step<=1)return;if(wx.hideKeyboard)wx.hideKeyboard();this.setData({step:this.data.step-1,error:'',keyboardHeight:0});this.persist();this.update();},
 next(e){return this.run(async()=>{
  const submitted=e&&e.detail&&e.detail.value||{};
  const values={};fields[this.data.step-1].forEach(f=>{if(Object.prototype.hasOwnProperty.call(submitted,f.key))values[f.key]=submitted[f.key];});
  this.setData({form:{...this.data.form,...values},error:''});
  const step=this.data.step;
  const check=message=>{this.setData({error:message});throw new Error(message);};
  const a=this.data.form;
  if(fields[step-1].some(f=>!['waist','allergies'].includes(f.key)&&a[f.key]===''))check('请完成当前问题');
  if(step===1){
   if(a.screening!=='clear')check('当前情况建议先获得专业指导，暂不分配通用方案，也不会进入付款。');
   await require('../../core/feedback').requirePrivacy().catch(e=>check(e.message));
   this.setData({form:{...a,consent:true,...(store.get().config.mealWeeksSupported?{mealWeekConsentVersion:1}:{})}});
  }else if(!a.consent)check('请先阅读信息使用说明并点击继续');
  for(const f of fields[step-1]){
   const rule=numeric[f.key],value=a[f.key];
   if(!rule||(f.key==='waist'&&value===''))continue;
   if(!/^\d+(\.\d)?$/.test(String(value))||!Number.isFinite(+value)||+value<rule.min||+value>rule.max||(rule.integer&&!Number.isInteger(+value)))check('请检查'+f.title+'，范围为 '+rule.min+'–'+rule.max+' '+rule.unit);
  }
  if(step===5){const bmi=+a.targetWeight/Math.pow(+a.height/100,2);if(bmi<18.5||bmi>=30)check('目标体重需在 BMI 18.5–30（不含30）的自动方案范围内');}
  if(step===7&&a.weekdays.length!==+a.frequency)check('请选择 '+a.frequency+' 个可训练日');
  this.persist();
  analytics.track('assessment_step','step'+step+'-'+Date.now());
  if(wx.hideKeyboard)wx.hideKeyboard();
  this.setData({keyboardHeight:0});
  if(step<9){this.setData({step:step+1});this.persist();this.update();return;}
  const error=require('../../shared/guidance').validate(this.data.form);if(error)check(error);
  const plan=await coach.assess(this.data.form);if(!plan)check('当前身体基础建议先获得专业指导，暂不提供自动饮食与训练方案。');
  wx.navigateTo({url:require('../../core/store').get().membership?.active?'/pages/exercise-detail/index?date='+require('../../shared/domain').localDate():'/pages/preview/index'});
 });}
});
