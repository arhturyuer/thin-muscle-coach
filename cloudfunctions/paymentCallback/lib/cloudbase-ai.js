const https=require('https'),stages=require('./stages.json');
function endpoint(env=process.env){
  const expected='https://'+stages.cloudEnv+'.api.tcloudbasegateway.com/v1/ai/cloudbase';
  const base=env.CLOUDBASE_AI_BASE_URL||expected;
  const url=new URL(base);
  if(url.href.replace(/\/$/,'')!==expected||url.username||url.password||url.port||url.search||url.hash)throw new Error('AI 服务地址与当前云环境不一致');
  return expected+'/chat/completions';
}
function apiKey(env){return env.CLOUDBASE_AI_API_KEY||env.CLOUDBASE_APIKEY;}
function ready(env=process.env){try{return typeof apiKey(env)==='string'&&!!apiKey(env).trim()&&!!endpoint(env);}catch(e){return false;}}
function model(kind,env=process.env){return kind==='planning'?(env.CLOUDBASE_AI_PLAN_MODEL||'deepseek-v4.1-flash'):kind==='vision'?(env.CLOUDBASE_AI_VISION_MODEL||'deepseek-v4.1-flash'):(env.CLOUDBASE_AI_TEXT_MODEL||'hy3');}
function error(kind,httpStatus,providerCode) {
 const e=new Error({auth:'模型认证失败',quota:'模型额度不可用',model:'视觉模型暂不可用',request:'模型请求参数未被接受',provider:'模型服务暂不可用',timeout:'模型服务超时',format:'模型回复格式无效',truncated:'模型回复被截断',network:'模型连接失败'}[kind]||'模型服务暂不可用');
 e.aiDiagnostic={kind,httpStatus:Number.isInteger(httpStatus)?httpStatus:null,providerCode:providerCode||null};return e;
}
function upstreamError(status,raw) {
 let body;try{body=JSON.parse(raw);}catch(e){}
 const upstream=body?.error||body?.Error||body?.Response?.Error||body;
 const code=String(upstream?.code||upstream?.Code||upstream?.type||'');
 const hint=code+' '+String(upstream?.message||upstream?.Message||'');
 const kind=/AI_MODEL_NOT_SUPPORTED|model.*(?:not.*found|disabled|not.*enabled|unavailable)|模型.*(?:未开通|未开启|不存在|不可用)/i.test(hint)?'model':status===402||status===429||/EXCEED_TOKEN_QUOTA_LIMIT|quota|balance|insufficient|resource.*exhaust|资源.*不足|余额|额度/i.test(hint)?'quota':status===401||status===403||/api.?key|unauthorized|authentication/i.test(hint)?'auth':status===404?'model':status===400?'request':'provider';
 const known=['AI_MODEL_NOT_SUPPORTED','AI_MODEL_PARAM_INVALID','AI_MODEL_CONFIG_MISSING','AI_MODEL_NOT_FOUND','EXCEED_TOKEN_QUOTA_LIMIT','EXCEED_AUTHORITY','INVALID_API_KEY','insufficient_quota','insufficient_balance','invalid_api_key','model_not_found','ResourceInsufficient','InvalidParameter','PermissionDenied','ResourceNotFound','ResourceUnavailable'];
 const e=error(kind,status,known.find(x=>code.toLowerCase().includes(x.toLowerCase()))||null);
 e.aiDiagnostic.reasonFlags=Object.entries({credential:/credential|api.?key|token|身份|凭证/i,permission:/permission|authorit|forbidden|denied|权限|授权/i,billing:/billing|resource.?point|package|计费|资源点|套餐/i,quota:/quota|balance|insufficient|余额|额度|不足/i,model:/model|模型/i,disabled:/not.?enabled|disabled|未开通|未开启/i,signature:/signature|签名/i,request:/parameter|request|参数|请求/i}).filter(([,pattern])=>pattern.test(hint)).map(([name])=>name);
 e.aiDiagnostic.responseFormat=body?'json':'other';
 return e;
}
function jsonContent(content) {
 const text=content.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
 try{return JSON.parse(text);}catch(e){}
 // Permit surrounding explanation, but never repair truncated JSON or execute content.
 const start=text.indexOf('{');if(start<0)throw error('format');
 let depth=0,quoted=false,escaped=false;
 for(let i=start;i<text.length;i++){const c=text[i];if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;}else if(c==='"')quoted=true;else if(c==='{')depth++;else if(c==='}'&&--depth===0){try{return JSON.parse(text.slice(start,i+1));}catch(e){throw error('format');}}}
 throw error('format');
}
function diagnostic(e){return e?.aiDiagnostic||{kind:'schema',httpStatus:null,providerCode:null};}
async function askNative(messages,kind,options={}){
 const selectedModel=model(kind),jsonVision=['deepseek-v4.1-flash','hy3','hy4-preview'].includes(selectedModel);
 let result;
 try {
  const cloud=require('wx-server-sdk');
  if(typeof cloud.ai!=='function')throw error('provider');
  result=await cloud.ai().createModel('cloudbase').generateText({model:selectedModel,messages,max_tokens:options.maxTokens||1200,maxSteps:1,...(jsonVision?{thinking:{type:'disabled'},response_format:{type:'json_object'}}:{})},{timeout:options.timeoutMs||45000});
  if(result.error)throw result.error;
 }catch(e){
  if(e.aiDiagnostic)throw e;
  if(/timeout|timed.out|超时/i.test(e.message||''))throw error('timeout');
  throw upstreamError(e.statusCode||e.status||e.response?.status||null,JSON.stringify({code:e.code||e.errCode,message:e.message||''}));
 }
 const raw=result.rawResponses?.[result.rawResponses.length-1];
 if(raw?.choices?.some(x=>x.finish_reason==='length'))throw error('truncated');
 if(typeof result.text!=='string')throw error('format');
 const parsed=jsonContent(result.text);
 Object.defineProperty(parsed,'_cloudbaseUsage',{value:result.usage||{},enumerable:false});
 return parsed;
}
function ask(messages,kind='text',options={}){
 if(process.env.CLOUDBASE_AI_TRANSPORT!=='http')return askNative(messages,kind,options);
 if(!ready())return Promise.reject(error('auth'));
 const selectedModel=model(kind);
 const jsonVision=kind==='vision'&&selectedModel==='deepseek-v4.1-flash';
 const body=JSON.stringify({model:selectedModel,messages,max_tokens:options.maxTokens||1200,stream:false,...(jsonVision?{thinking:{type:'disabled'},response_format:{type:'json_object'}}:{})});
 return new Promise((resolve,reject)=>{
  let timer,done=false;
  const finish=(e,value)=>{if(done)return;done=true;clearTimeout(timer);e?reject(e):resolve(value);};
  const req=https.request(endpoint(),{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+apiKey(process.env),'Content-Length':Buffer.byteLength(body)}},res=>{
   let raw='',size=0;
   res.on('data',chunk=>{size+=Buffer.byteLength(chunk);if(size>100000){finish(error('format',res.statusCode));req.destroy();return;}raw+=chunk;});
   res.on('error',()=>finish(error('network')));res.on('aborted',()=>finish(error('network')));
   res.on('end',()=>{try{
    if(res.statusCode!==200)throw upstreamError(res.statusCode,raw);
    let r;try{r=JSON.parse(raw);}catch(e){throw error('format',200);}
    if(r.error)throw upstreamError(200,raw);
    const choice=r.choices?.[0];
    if(choice?.finish_reason==='length')throw error('truncated',200);
    if(choice?.finish_reason!=='stop'||typeof choice.message?.content!=='string')throw error('format',200);
    finish(null,jsonContent(choice.message.content));
   }catch(e){finish(e);}});
  });
  timer=setTimeout(()=>{finish(error('timeout'));req.destroy();},options.timeoutMs||25000);
  req.on('error',()=>finish(error('network')));req.end(body);
 });
}
module.exports={ask,endpoint,ready,model,diagnostic,jsonContent};
