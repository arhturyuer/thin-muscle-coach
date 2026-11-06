const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm'),{EventEmitter}=require('events');
const ai=require('../server/cloudbase-ai'),stages=require('../server/stages.json');
const base='https://'+stages.cloudEnv+'.api.tcloudbasegateway.com/v1/ai/cloudbase';
test('CloudBase AI only accepts the current environment domestic gateway',()=>{
 assert.equal(ai.endpoint({}),base+'/chat/completions');assert.equal(ai.endpoint({CLOUDBASE_AI_BASE_URL:base+'/'}),base+'/chat/completions');
 for(const u of [base.replace('https:','http:'),base.replace(stages.cloudEnv,'another-env'),base+'?secret=x',base+'#test',base.replace('.com/','.com.evil.example/'),base.replace('https://','https://user:password@'),'https://dashscope.aliyuncs.com/compatible-mode/v1'])assert.throws(()=>ai.endpoint({CLOUDBASE_AI_BASE_URL:u}));
 assert.equal(ai.ready({DEEPSEEK_API_KEY:'old',DASHSCOPE_API_KEY:'old'}),false);assert.equal(ai.ready({CLOUDBASE_AI_API_KEY:'key'}),true);assert.equal(ai.ready({CLOUDBASE_APIKEY:'injected'}),true);
});
function load(response,overrides={}){
 let request;const env={CLOUDBASE_AI_TRANSPORT:'http',CLOUDBASE_AI_API_KEY:'server-only-secret',CLOUDBASE_AI_TEXT_MODEL:'enabled-text',CLOUDBASE_AI_VISION_MODEL:'enabled-vision',...overrides};
 const https={request(url,options,callback){const req=new EventEmitter();req.destroy=()=>{};req.end=body=>{request={url,options,body:JSON.parse(body)};queueMicrotask(()=>{const res=new EventEmitter();res.statusCode=response.status||200;callback(res);res.emit('data',Buffer.from(JSON.stringify(response.body)));res.emit('end');});};return req;}};
 const context={module:{exports:{}},require:name=>name==='https'?https:stages,process:{env},URL,Buffer,setTimeout,clearTimeout};vm.runInNewContext(fs.readFileSync(require.resolve('../server/cloudbase-ai'),'utf8'),context);
 return {api:context.module.exports,getRequest:()=>request};
}
test('CloudBase adapter sends Bearer auth and routes text and image to separate configured models',async()=>{
 const {api,getRequest}=load({body:{choices:[{finish_reason:'stop',message:{content:'```json\n{"foods":[]}\n```'}}]}});
 const messages=[{role:'user',content:[{type:'text',text:'识别食物'},{type:'image_url',image_url:{url:'data:image/jpeg;base64,/9j/'}}]}];
 assert.equal(JSON.stringify(await api.ask(messages,'vision')),'{"foods":[]}');let r=getRequest();assert.equal(r.url,base+'/chat/completions');assert.equal(r.body.model,'enabled-vision');assert.deepEqual(r.body.messages,messages);assert.equal(r.options.headers.Authorization,'Bearer server-only-secret');assert.equal(r.body.stream,false);
 assert.equal('enable_thinking' in r.body,false);assert.equal('thinking' in r.body,false);assert.equal('response_format' in r.body,false);
 await api.ask([{role:'user',content:'hello'}]);assert.equal(getRequest().body.model,'enabled-text');
});
test('CloudBase adapter rejects provider errors, truncated and non-JSON responses without reflecting secrets',async()=>{
 for(const response of [{status:401,body:{error:{message:'server-only-secret'}}},{body:{choices:[{finish_reason:'length',message:{content:'{}'}}]}},{body:{choices:[{finish_reason:'stop',message:{content:'invalid json'}}]}}]){
 const {api}=load(response);await assert.rejects(api.ask([]),error=>!error.message.includes('server-only-secret'));
 }
});
test('model access denied is diagnosed separately from an invalid API key without echoing response content',async()=>{
 const {api}=load({status:403,body:{code:'AI_MODEL_NOT_SUPPORTED',message:'模型未开启，请检查套餐 server-only-secret'}});
 await assert.rejects(api.ask([],'vision'),e=>{assert.equal(e.aiDiagnostic.kind,'model');assert.equal(e.aiDiagnostic.httpStatus,403);assert.equal(e.aiDiagnostic.providerCode,'AI_MODEL_NOT_SUPPORTED');assert.equal(JSON.stringify(e.aiDiagnostic).includes('server-only-secret'),false);return true;});
});
test('upstream requests declare exact byte length and JSON explanations are parsed without repairing truncated output',async()=>{
 const {api,getRequest}=load({body:{choices:[{finish_reason:'stop',message:{content:'识别结果如下：\n```json\n{"foods":[],"note":"包含 { 字符"}\n```'}}]}});
 const result=await api.ask([{role:'user',content:'照片分析'}],'vision');assert.equal(result.foods.length,0);assert.equal(getRequest().options.headers['Content-Length'],Buffer.byteLength(JSON.stringify(getRequest().body)));
 assert.throws(()=>ai.jsonContent('说明 {"foods":['));
});

test('photo recognition defaults to the image-capable Growth Plan model and uses non-thinking JSON output',async()=>{
 assert.equal(ai.model('vision',{}),'deepseek-v4.1-flash');
 const {api,getRequest}=load({body:{choices:[{finish_reason:'stop',message:{content:'{"foods":[]}'}}]}},{CLOUDBASE_AI_VISION_MODEL:''});
 await api.ask([{role:'user',content:'请输出 JSON'}],'vision');
 const body=getRequest().body;assert.equal(body.model,'deepseek-v4.1-flash');assert.equal(body.thinking.type,'disabled');assert.equal(body.response_format.type,'json_object');
});

test('native vision calls preserve the CloudBase cloud-function identity and validate complete SDK output',async()=>{
 let group,params,opts;
 const sdk={ai:()=>({createModel:g=>{group=g;return {generateText:async(p,o)=>{params=p;opts=o;return {text:'{"foods":[]}',usage:{total_tokens:123},rawResponses:[{choices:[{finish_reason:'stop'}]}]};}};}})};
 const context={module:{exports:{}},require:name=>name==='wx-server-sdk'?sdk:name==='https'?{request(){throw new Error('must not use external HTTP');}}:stages,process:{env:{}},URL,Buffer,setTimeout,clearTimeout};
 vm.runInNewContext(fs.readFileSync(require.resolve('../server/cloudbase-ai'),'utf8'),context);
 const result=await context.module.exports.ask([{role:'user',content:[{type:'image_url',image_url:{url:'data:image/jpeg;base64,/9j/'}}]}],'vision',{maxTokens:2600,timeoutMs:45000});
 assert.equal(group,'cloudbase');assert.equal(params.model,'deepseek-v4.1-flash');assert.equal(params.thinking.type,'disabled');assert.equal(opts.timeout,45000);assert.equal(result._cloudbaseUsage.total_tokens,123);assert.equal(JSON.stringify(result),'{"foods":[]}');
 await context.module.exports.ask([{role:'user',content:'只输出 JSON'}],'text');assert.equal(params.model,'hy3');assert.equal(params.thinking.type,'disabled');
 await context.module.exports.ask([{role:'user',content:'三餐输出 JSON'}],'planning');assert.equal(params.model,'deepseek-v4.1-flash');
});
