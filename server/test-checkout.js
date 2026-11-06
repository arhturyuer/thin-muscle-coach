const crypto=require('crypto');
function enabled(stage,env=process.env){return stage==='test'&&env.TEST_CHECKOUT_READY!=='false';}
function signingSecret(env=process.env,stage='prod'){
 if(env.ENTITLEMENT_SECRET)return env.ENTITLEMENT_SECRET;
 // A separate domain-derived test key; never return this or the payment key to clients.
 if(enabled(stage,env)&&env.PAY_APP_KEY)return crypto.createHmac('sha256',env.PAY_APP_KEY).update('boji:test:entitlement:v1').digest('hex');
 return '';
}
module.exports={enabled,signingSecret};
