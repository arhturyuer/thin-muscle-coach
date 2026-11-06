const {test}=require('node:test');
const assert=require('node:assert/strict');
function ruler(patch={}){
 let definition;
 global.Component=value=>{definition=value;};
 const file=require.resolve('../miniprogram/components/number-ruler/index');delete require.cache[file];require(file);delete global.Component;
 const events=[];
 const instance={...definition.methods,data:{...structuredClone(definition.data),min:30,max:250,reference:65,value:'',integer:false,...patch},setData(p){Object.assign(this.data,p);},triggerEvent(name,detail){events.push({name,...detail});}};
 return {instance,events,definition};
}
test('ruler starts at a reference without filling the answer, and typed values reposition it',()=>{
 const {instance:r,events,definition}=ruler();r.configure();assert.equal(r.data.scrollLeft,350);assert.deepEqual(events,[]);
 r.input({detail:{value:'70.5'}});assert.deepEqual(events.pop(),{name:'change',value:'70.5'});
 definition.observers.value.call(r,'70.5');assert.equal(r.data.scrollLeft,405);
 r.input({detail:{value:''}});assert.equal(events.pop().value,'');
 r.input({detail:{value:'1..'}});assert.equal(events.pop().value,'1..');
});
test('ruler ignores programmatic scrolling, emits decimal drag values and clamps bounds',()=>{
 const {instance:r,events}=ruler();r.scroll({detail:{scrollLeft:405}});assert.deepEqual(events,[]);
 r.touch();r.scroll({detail:{scrollLeft:405}});assert.equal(events.pop().value,'70.5');
 r.scroll({detail:{scrollLeft:-10}});assert.equal(events.pop().value,'30');
 r.scroll({detail:{scrollLeft:9999}});assert.equal(events.pop().value,'250');
 // A finger held still must not end interaction before it moves again.
 assert.equal(r.interacting,true);assert.equal(r.scrollTimer,undefined);
});
test('age drag rounds to integers, optional values clear and disabled input is inert',()=>{
 const {instance:r,events}=ruler({integer:true,min:18,max:100});r.touch();r.scroll({detail:{scrollLeft:105}});assert.equal(events.pop().value,'29');
 r.clear();assert.equal(events.pop().value,'');r.data.disabled=true;r.input({detail:{value:'30'}});r.clear();r.scroll({detail:{scrollLeft:80}});assert.deepEqual(events,[]);
});
