const transport=e=>['TRANSPORT_ERROR','TEST_TRANSPORT_ERROR'].includes(e?.code);
function observe(promise,ms){
 let timer;
 return Promise.race([promise,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),ms);})]).finally(()=>clearTimeout(timer));
}
const outcome=promise=>promise.then(value=>({value}),error=>({error}));
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function pendingError(){const e=new Error('暂未取回识别结果，可点“重试这张照片”继续查询');e.code='PHOTO_RECOVERY_PENDING';return e;}
function expiredError(){const e=new Error('上次识别已超时，可点“重试这张照片”重新识别');e.code='PHOTO_RECOGNITION_EXPIRED';return e;}
// Recover with small authenticated queries. Only if repeated queries confirm the
// upload never arrived may we resend once, using the same id and image bytes.
async function run({submit,status,isCurrent,resume=false,canReuseExpired=true,onRecover=()=>{}},timing={}){
 const {initialMs=8000,pollMs=2000,queryMs=5000,maxPolls=25,totalMs=70000}=timing;
 const deadline=Date.now()+totalMs;
 let original,resends=0,missing=0;
 isCurrent();
 if(resume){
  onRecover();
  const saved=await observe(outcome(status()),queryMs);isCurrent();
  if(!saved||saved.error){if(saved?.error&&!transport(saved.error))throw saved.error;throw pendingError();}
  if(saved.value.status==='completed')return saved.value.result;
  if(saved.value.status==='failed'||saved.value.status==='expired'&&canReuseExpired)original=outcome(submit());
  else if(saved.value.status==='expired')throw expiredError();
  else if(saved.value.status==='missing')missing=1;
 }else original=outcome(submit());
 if(original){
  const first=await observe(original,initialMs);isCurrent();
  if(first&&!first.error)return first.value;
  if(first?.error&&!transport(first.error)&&first.error.code!=='PENDING')throw first.error;
 }
 if(!resume)onRecover();
 for(let i=0;i<maxPolls&&Date.now()<deadline;i++){
  isCurrent();
  // A late successful response can arrive while a status request is unavailable.
  const late=original?await observe(original,pollMs):null;
  if(!original||late?.error)await wait(pollMs);
  isCurrent();
  if(late&&!late.error)return late.value;
  if(late?.error&&!transport(late.error)&&late.error.code!=='PENDING')throw late.error;
  const checked=await observe(outcome(status()),Math.min(queryMs,Math.max(1,deadline-Date.now())));isCurrent();
  if(!checked)continue;
  if(checked.error){if(transport(checked.error))continue;throw checked.error;}
  const r=checked.value;
  if(r.status==='completed')return r.result;
  if(r.status==='failed'){const e=new Error(r.message||'图片分析暂未完成，可重试这张照片，未扣识别次数');e.code='AI_UNAVAILABLE';throw e;}
  if(r.status==='expired')throw expiredError();
  if(r.status==='missing')missing++;else missing=0;
  if(missing>=2&&resends===0){
   // The server atomically leases this exact request ID: even a delayed first
   // upload cannot start a second model invocation or consume a second quota.
   resends++;missing=0;original=outcome(submit());onRecover();
  }
 }
 throw pendingError();
}
module.exports={run};
