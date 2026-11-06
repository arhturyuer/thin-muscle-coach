Component({
 properties:{value:{type:null,value:''},min:Number,max:Number,reference:Number,unit:String,integer:Boolean,optional:Boolean,disabled:Boolean,label:String},
 data:{ticks:[],scrollLeft:0,halfWidth:150},
 observers:{'min,max,reference':function(){this.configure();},value:function(value){if(!this.interacting)this.position(value);}},
 lifetimes:{
  attached(){this.configure();},
  ready(){this.createSelectorQuery().select('.ruler-track').boundingClientRect(rect=>{if(rect)this.setData({halfWidth:rect.width/2});}).exec();},
  detached(){clearTimeout(this.scrollTimer);}
 },
 methods:{
  configure(){const {min,max}=this.data;const ticks=[];for(let n=min;n<=max;n++)ticks.push({value:n,major:n%10===0,label:n%10===0?String(n):''});this.setData({ticks});this.position(this.data.value);},
  position(value){const n=value===''?this.data.reference:Number(value);if(Number.isFinite(n))this.setData({scrollLeft:(Math.max(this.data.min,Math.min(this.data.max,n))-this.data.min)*10});},
  input(e){if(this.data.disabled)return;this.triggerEvent('change',{value:e.detail.value});},
  keyboard(e){this.triggerEvent('keyboardheightchange',e.detail);},
  clear(){if(!this.data.disabled)this.triggerEvent('change',{value:''});},
  touch(){if(this.data.disabled)return;clearTimeout(this.scrollTimer);this.touching=true;this.interacting=true;this.lastTickValue=Number(this.data.value===''?this.data.reference:this.data.value);},
  end(){this.touching=false;this.scheduleEnd();},
  scheduleEnd(){clearTimeout(this.scrollTimer);this.scrollTimer=setTimeout(()=>{this.interacting=false;this.position(this.data.value);},180);},
  tick(value){
   if(value===this.lastTickValue)return;
   this.lastTickValue=value;
   const now=Date.now();
   if(this.lastVibrationAt!=null&&now-this.lastVibrationAt<60)return;
   if(typeof wx==='undefined'||typeof wx.vibrateShort!=='function')return;
   this.lastVibrationAt=now;
   // Haptics are optional: unsupported devices must still scroll normally.
   try{wx.vibrateShort({type:'light',fail(){}});}catch(e){}
  },
  scroll(e){
   if(!this.interacting||this.data.disabled)return;
   const raw=this.data.min+e.detail.scrollLeft/10;
   const value=Math.max(this.data.min,Math.min(this.data.max,Number(raw.toFixed(this.data.integer?0:1))));
   this.tick(value);
   this.triggerEvent('change',{value:String(value)});if(!this.touching)this.scheduleEnd();
  }
 }
});
