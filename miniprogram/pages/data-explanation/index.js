const page=require('../../core/page'),d=require('../../shared/domain');
page({
  data:{date:'',expanded:{basal:false,diet:false,activity:false,training:false}},
  onLoad(options={}){this.setData({date:d.validDate(options.date)?options.date:d.localDate()});},
  render(){this.setData({explanation:require('../../services/energy-explanation').view(this.data.vm,this.data.date||this.data.vm.date)});},
  toggle(e){const key=e.currentTarget.dataset.section;if(['basal','diet','activity','training'].includes(key))this.setData({['expanded.'+key]:!this.data.expanded[key]});}
});
