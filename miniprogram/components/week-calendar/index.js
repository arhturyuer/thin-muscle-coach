Component({
  properties:{calendar:{type:Object,value:{}},slot:{type:Number,value:1}},
  methods:{
    select(e){this.triggerEvent('selectdate',{date:e.currentTarget.dataset.date});},
    change(e){if(e.detail.current!==this.data.slot)this.triggerEvent('weekchange',{current:e.detail.current});}
  }
});
