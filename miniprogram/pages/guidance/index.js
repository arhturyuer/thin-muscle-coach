const page=require('../../core/page'),api=require('../../services/api'),repo=require('../../services/repository'),store=require('../../core/store'),d=require('../../shared/domain');
page({data:{message:'',messages:[],remaining:30,pending:null,nextOffset:null,date:d.localDate()},
 onLoad(){const pending=store.get().aiPending||null;this.setData({pending,message:pending?pending.message:''});this.history();},
 history(){this.run(async()=>{const r=await api.call('ai.history',{date:this.data.date,offset:0});const q=await api.call('ai.quota',{});this.setData({messages:r.messages,nextOffset:r.nextOffset,remaining:q.remaining});});},
 earlier(){this.run(async()=>{const r=await api.call('ai.history',{date:this.data.date,offset:this.data.nextOffset});this.setData({messages:[...this.data.messages,...r.messages],nextOffset:r.nextOffset});});},
 previous(){const date=d.localDate(Date.parse(this.data.date+'T12:00:00+08:00')-d.DAY);this.setData({date,messages:[]});this.history();},
 input(e){this.setData({message:e.detail.value});},
 send(){this.run(async()=>{const text=this.data.message.trim();if(!text)throw new Error('先写下今天的问题');let pending=this.data.pending;
  if(pending&&pending.message!==text)throw new Error('先查询或重试上一条指导，避免重复请求。');
  if(!store.get().config.aiEnabled)throw new Error('AI 指导暂未开放，仍可执行现有计划');
  await require('../../core/feedback').requirePrivacy();
  const consent=await wx.showModal({title:'使用 AI 指导',content:'同意将本次问题、必要的身体摘要、当前计划及近期执行记录发送给 腾讯云 CloudBase AI？回复和对话按账号保存，可通过删除个人数据清除。',confirmText:'同意发送'});if(!consent.confirm)return;
  if(!pending)pending={requestId:repo.id(),date:d.localDate(),message:text};this.setData({pending});store.save({aiPending:pending});
  const r=await api.call('ai.ask',pending);await this.apply(r);
 });},
 query(){this.run(async()=>{const p=this.data.pending;if(!p)return;const r=await api.call('ai.result',p);if(r.request&&r.request.status==='completed')await this.apply(r);else wx.showToast({title:'尚未完成，可稍后重试',icon:'none'});});},
 abandon(){this.setData({pending:null,message:''});store.save({aiPending:null});},
 async apply(r){this.setData({messages:[...(this.data.date===r.date?this.data.messages:[]).filter(x=>x.id!==r.request.id),r.request],remaining:r.remaining,message:'',pending:null,date:r.date});store.save({aiPending:null});if(r.date!==d.localDate()){const quota=await api.call('ai.quota');this.setData({remaining:quota.remaining});}}
});
