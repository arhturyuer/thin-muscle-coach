const daily=require('../../services/daily'),rules=require('../../shared/daily'),store=require('../../core/store'),repo=require('../../services/repository'),d=require('../../shared/domain');
module.exports={
  ...require('../../services/meal-capture').methods,
  onPhotoSaved(result){this._savedMealPhoto=result;},
  clearSaveNotice(){clearTimeout(this._saveNoticeTimer);this._saveNoticeTimer=null;this.setData({lastSaved:null,saveNoticeProgress:0});},
  showSaveNotice(key,label){
    clearTimeout(this._saveNoticeTimer);
    const expiresAt=Date.now()+2000;
    this.setData({lastSaved:{key,label},saveNoticeProgress:100});
    const tick=()=>{
      const remaining=expiresAt-Date.now();
      if(remaining<=0){this.clearSaveNotice();return;}
      this.setData({saveNoticeProgress:remaining/20});
      this._saveNoticeTimer=setTimeout(tick,Math.min(50,remaining));
    };
    this._saveNoticeTimer=setTimeout(tick,50);
  },
  retryDayOperation(){return this.run(async()=>{this.guardToday();const result=await daily.retry();if(result?.proposal)this.setData({dayProposal:result.proposal});else this.setData({dayProposal:null,reply:'上次操作已确认，当前安排已更新。'});});},
  async ensureNutritionPlan(force=false){
    if(this.data.mealPlanLoading)return;
    const s=store.get(),e=s.entitlement;if(!e||!this.data.calendar?.isToday||!this.data.dashboard?.executable)return;
    this.setData({mealPlanLoading:true,mealPlanError:''});
    try{await require('../../services/meal-plan').load(force);}catch(error){this.setData({mealPlanError:error.message});}finally{this.setData({mealPlanLoading:false});}
  },
  generateNutritionPlan(){return this.ensureNutritionPlan(false);},
  regenerateNutritionPlan(){return this.ensureNutritionPlan(true);},
  guardToday(){if(!this.data.calendar.isToday)throw new Error('请回到今天记录或调整');daily.current();},
  openComposer(){return this.run(async()=>{this.guardToday();this._openedAt=Date.now();this.setData({composerOpen:true,panelDate:d.localDate(),panelPlan:store.get().entitlement.id});});},
  closeComposer(){this.setData({composerOpen:false,keyboardHeight:0});},
  composerInput(e){this.setData({composerText:e.detail.value});},
  composerKeyboard(e){this.setData({keyboardHeight:e.detail.height||0});},
  selectMeal(e){this.setData({selectedMeal:e.currentTarget.dataset.slot});this.render();},
  toggleMeals(){this.setData({showAllMeals:!this.data.showAllMeals});},
  dismissReview(){const key=store.get().entitlement.id;store.save({dismissedReview:key});this.render();},
  openReview(){wx.switchTab({url:'/pages/progress/index'});},
  queueRecords(items,ticket){if(this._recordQueue?.length&&!this._recordQueue[0].ticket.requestId.startsWith(ticket.requestId+'-'))throw new Error('请先完成或取消上一条未保存的记录');items.forEach((item,i)=>require('../../services/analytics').track('meal_record_started',ticket.requestId+'-'+i));this._recordQueue=items.map((item,i)=>({...item,ticket:{...ticket,requestId:ticket.requestId+'-'+i}}));store.save({dailyRecordQueue:this._recordQueue});return this.advanceRecords();},
  advanceRecords(mode){
    const queue=this._recordQueue||[];
    while(queue.length){
      const item=queue[0];
      if(store.get().dailyWrites?.[item.ticket.requestId]){queue.shift();store.save({dailyRecordQueue:queue});continue;}
      if(!item.slot){this.setData({composerOpen:true,recordPrompt:{...item,needsSlot:true}});return;}
      const result=daily.saveMeal(item,mode||'new',item.ticket);
      if(result.conflict){this.setData({composerOpen:true,recordPrompt:{...item,needsSlot:false,old:result.old.text}});return;}
      this.showSaveNotice(result.key||rules.mealKey(item.ticket.planId,item.ticket.date,item.slot),rules.labels[item.slot]);
      queue.shift();store.save({dailyRecordQueue:queue});mode=null;
    }
    this.setData({recordPrompt:null});wx.showToast({title:'记录已保存',icon:'none'});
  },
  assignSlot(e){return this.run(async()=>{this.guardToday();if(!this._recordQueue?.length)return;this._recordQueue[0].slot=e.currentTarget.dataset.slot;store.save({dailyRecordQueue:this._recordQueue});this.advanceRecords();});},
  resolveRecord(e){return this.run(async()=>{this.guardToday();this.advanceRecords(e.currentTarget.dataset.mode);});},
  cancelRecord(){this._recordQueue=[];store.save({dailyRecordQueue:[]});this.setData({recordPrompt:null});},
  recordRecipe(){return this.run(async()=>{this.guardToday();const meal=this.data.focusMeal;if(!meal.suggestion)throw new Error('暂无可记录的食谱，请填写实际吃的内容');this.queueRecords([{slot:meal.slot,text:meal.suggestion,source:'recipe'}],{requestId:repo.id(),planId:store.get().entitlement.id,date:d.localDate()});});},
  editActivity(e){return this.run(async()=>{this.guardToday();const row=store.get().records[e.currentTarget.dataset.key];if(!row||row.kind!=='meal')return;this.setData({composerOpen:true,editingKey:e.currentTarget.dataset.key,editingSlot:row.value.slot,editingVersion:row.version,editingOriginal:row.value.text,composerText:row.value.text,panelDate:d.localDate(),panelPlan:store.get().entitlement.id});});},
  saveEdit(){return this.run(async()=>{this.guardToday();const key=this.data.editingKey,row=store.get().records[key];if(!row||row.version!==this.data.editingVersion||row.value.text!==this.data.editingOriginal)throw new Error('记录已有变化，请收起后重新编辑，避免覆盖其他设备的记录');daily.saveMeal({slot:row.value.slot,text:this.data.composerText,source:'edit'},'replace',{date:this.data.panelDate,planId:this.data.panelPlan});require('../../services/analytics').track('meal_edited');this.setData({editingKey:null,composerText:'',composerOpen:false});});},
  undoActivity(e){return this.run(async()=>{
    if(!this.data.calendar.isToday)throw new Error('请回到今天调整记录');
    const key=e.currentTarget.dataset.key,row=store.get().records[key];
    if(row?.kind==='meal'){
      daily.undoMeal(key);
      if(row.value.photoIds?.length||row.value.previousPhotoIds?.length)await require('../../services/syncService').flush();
    }else if(row?.kind==='dayOverride'){this.guardToday();await daily.undoOverride(row);}
    this.clearSaveNotice();
  });},
  quickInput(e){const type=e.currentTarget.dataset.type;this.setData({composerOpen:true,composerText:type==='time'?'今天只有十五分钟':type==='tired'?'今天很累':'',panelDate:d.localDate(),panelPlan:store.get().entitlement?.id});if(type==='record'){this.setData({reply:'写下实际吃了什么，例如：午饭吃了牛肉面。'});return;}this.sendDaily();},
  sendDaily(){return this.run(async()=>{
    this.guardToday();if(this.data.recordPrompt)throw new Error('请先完成或取消当前记录');
    const text=(this.data.composerText||'').trim();if(!text)return;
    if(this.data.panelDate&&this.data.panelDate!==d.localDate()||this.data.panelPlan&&this.data.panelPlan!==store.get().entitlement.id)throw new Error('日期或计划已变化，请关闭后重新记录');
    let ticket=store.get().dailyInputPending;
    if(ticket&&ticket.text!==text)throw new Error('上一条尚未处理完，请先重试或放弃');
    if(!ticket){ticket={text,startedAt:this._openedAt||Date.now(),requestId:repo.id(),date:d.localDate(),planId:store.get().entitlement.id};store.save({dailyInputPending:ticket});}
    const result=rules.interpret(text);this.setData({reply:'',composerOpen:true});
    require('../../services/analytics').track('daily_input',ticket.requestId);
    if(result.records.length||result.questions.length)this.queueRecords([...result.records,...result.questions],ticket);
    daily.feedback(result.feedback);
    if(result.preference)this.setData({preferenceDraft:result.preference});
    if(result.adjustment)await this.makeAdjustment(result.adjustment);
    if(!result.handled){const sent=await this.askDaily(text);if(sent===false){store.save({dailyInputPending:null});return;}}
    this.setData({composerText:'',editingKey:null});store.save({dailyInputPending:null});
  });},
  abandonDaily(){store.save({dailyInputPending:null});this.setData({composerText:'',reply:''});},
  async makeAdjustment(input){
    if(input.target==='meal'){this.setData({pendingAdjustment:input,composerOpen:true});return;}
    const proposal=await daily.propose(input);this.setData({dayProposal:proposal,pendingAdjustment:null,composerOpen:true});
  },
  chooseAdjustmentSlot(e){return this.run(async()=>{this.guardToday();await this.makeAdjustment({...this.data.pendingAdjustment,target:e.currentTarget.dataset.slot});});},
  adjustWorkout(){this.openComposer();this.setData({reply:'告诉我今天可用的时间，或选择“时间不够”“今天很累”。'});},
  changeMeal(){return this.run(async()=>{this.guardToday();await this.makeAdjustment({target:this.data.focusMeal.slot,mode:'swap',variant:this.data.swapVariant||0});this.setData({swapVariant:this.data.swapVariant?0:1});});},
  anotherProposal(){return this.run(async()=>{this.guardToday();const p=this.data.dayProposal;if(!p)return;await this.makeAdjustment(p.target==='workout'?{target:'workout',mode:p.task.rest?'rest':'light'}:{target:p.target,mode:'swap',variant:this.data.swapVariant||0});this.setData({swapVariant:this.data.swapVariant?0:1});});},
  adoptProposal(){return this.run(async()=>{this.guardToday();const p=this.data.dayProposal;if(!p)return;if(p.target==='workout'&&store.get().session){this.setData({reply:'请先结束或中断正在进行的训练，保存已完成部分后再采用。'});return;}await daily.adopt(p);this.setData({dayProposal:null,reply:'已采用，仅用于今天。'});});},
  dismissProposal(){this.setData({dayProposal:null,pendingAdjustment:null,preferenceDraft:null});},
  confirmPreference(){return this.run(async()=>{this.guardToday();daily.preference(this.data.preferenceDraft);this.setData({preferenceDraft:null,reply:'偏好已保存，后续调整会保留这一限制；周安排仍通过周回顾确认。'});});},
  async askDaily(text){
    const s=store.get();if(!s.online)throw new Error('当前离线，可继续手动记录；联网后再向教练提问');
    if(!s.config.aiEnabled)throw new Error('AI 指导暂未开放，可直接记录饮食或使用快捷调整');
    await require('../../core/feedback').requirePrivacy();
    const consent=await wx.showModal({title:'使用 AI 指导',content:'同意将本次问题、必要的身体摘要、计划和近期记录发送给 腾讯云 CloudBase AI？对话按账号保存，可删除。',confirmText:'同意发送'});if(!consent.confirm)return false;
    let pending=store.get().aiPending;
    if(pending&&pending.message!==text)throw new Error('上一条指导尚未返回，请在完整对话中查询或重试');
    if(!pending){pending={requestId:repo.id(),date:d.localDate(),message:text};store.save({aiPending:pending});}
    const r=await require('../../services/api').call('ai.ask',pending);
    this.setData({reply:r.request.reply});store.save({aiPending:null});
  },
  resumeTraining(){wx.navigateTo({url:'/pages/workout/index'});}
};
