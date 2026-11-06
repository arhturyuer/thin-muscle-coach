const page = require('../../core/page');
const workout = require('../../services/workout');
const {maxSets} = require('../../shared/workout');
const d = require('../../shared/domain');

page({
  data: {date:'',rows:[],maxSets,discomfort:false,loaded:false,error:''},
  onLoad(options={}) {
    this.setData({
      date:d.validDate(options.date)?options.date:d.localDate(),
      moveId:/^move-\d+$/.test(options.moveId||'')?options.moveId:''
    });
  },
  onShow() {
    return this.run(async()=>{
      try {
        await workout.load(this.data.date);
      } catch(error) {
        this.setData({error:error.message});
      }
      this.refresh();
    });
  },
  render() {
    const {vm,date,loaded}=this.data;
    const info=workout.view(vm,date||vm.date);
    this.setData({info});
    if(info.day&&!loaded){
      this._expectedRecord={owner:vm.owner,epoch:vm.dataEpoch,at:info.record?.at};
      this._previousDifficulty=info.record?.difficulty;
      this.setData({
        rows:workout.recordRows(info.day,info.record),
        recordDay:info.day,
        loaded:true,
        discomfort:info.record?.discomfort||false
      });
    }
    if(this._ready)this.focusMove();
  },
  focusMove() {
    if(this._focusedMove||!this.data.rows.some(row=>row.id===this.data.moveId))return;
    this._focusedMove=true;
    const scroll=()=>wx.pageScrollTo&&wx.pageScrollTo({selector:'#record-'+this.data.moveId,offsetTop:-16,duration:0});
    if(wx.nextTick)wx.nextTick(scroll);else scroll();
  },
  onReady(){this._ready=true;this.focusMove();},
  addSet(e) {
    const {index}=e.currentTarget.dataset;
    const sets=this.data.rows[index].setDetails;
    if(sets.length>=maxSets)return;
    const move=this.data.recordDay.exercises[index];
    this.setData({['rows['+index+'].setDetails']:[...sets,workout.plannedSet(move,sets.length)]});
  },
  removeSet(e) {
    const {index}=e.currentTarget.dataset;
    const sets=this.data.rows[index].setDetails;
    if(sets.length)this.setData({['rows['+index+'].setDetails']:sets.slice(0,-1)});
  },
  setInput(e) {
    const {index,setIndex,field}=e.currentTarget.dataset;
    this.setData({['rows['+index+'].setDetails['+setIndex+'].'+field]:e.detail.value});
  },
  checkSet(e) {
    const {index,setIndex}=e.currentTarget.dataset;
    this.setData({['rows['+index+'].setDetails['+setIndex+'].completed']:e.detail.value.length>0});
  },
  difficulty(e) {
    const {index}=e.currentTarget.dataset;
    this.setData({['rows['+index+'].difficulty']:e.detail.value});
  },
  discomfort(e){this.setData({discomfort:e.detail.value});},
  save() {
    if(!this.data.loaded||!this.data.info.canRecord||this.data.info.day.rest)return;
    return this.run(async()=>{
      await workout.save(this.data.date,this.data.rows,{
        difficulty:this._previousDifficulty,
        discomfort:this.data.discomfort,
        expectedVersion:this.data.recordDay.planVersion,
        expectedRecord:this._expectedRecord
      });
      wx.showToast({title:'已保存',icon:'success'});
      wx.navigateBack();
    });
  }
});
