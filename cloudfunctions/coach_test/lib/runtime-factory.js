const b = require('./business'),
  crypto = require('crypto'),
  {
    partition
  } = require('./partition');
const docId = id => crypto.createHash('sha256').update(id).digest('hex');

function createRuntime(cloud, stage) {
  const tables = partition(stage),
    db = cloud.database();
  async function transact(userId, fn) {
    return db.runTransaction(async tx => {
      const ref = tx.collection(tables.accounts).doc(docId(userId));
      let s, existing = true;
      try {
        s = (await ref.get()).data;
      } catch (e) {
        if (!/not exist|not found|does not exist|-502001/i.test(e.message)) throw e;
        s = b.fresh();
        existing = false;
      }
      delete s._id;
      s.userId = userId;
      const before = JSON.stringify(s),
        result = (require('./profile').ensure(s), await fn(s));
      if (!existing || JSON.stringify(s) !== before) await ref.set({
        data: s
      });
      return result;
    });
  }
  async function lookup(orderId) {
    try {
      return (await db.collection(tables.orders).doc(orderId).get()).data;
    } catch (e) {
      if (/not exist|not found|does not exist|-502001/i.test(e.message)) return null;
      throw e;
    }
  }
  const auxiliary = tables.accounts + '_guidance';
  async function auxTransact(userId, key, fn) {
    return db.runTransaction(async tx => {
      const ref=tx.collection(auxiliary).doc(docId(userId+':'+key));
      let value={userId,key};
      try {value=(await ref.get()).data;} catch(e) {if(!/not exist|not found|does not exist|-502001/i.test(e.message)) throw e;}
      const account=(await tx.collection(tables.accounts).doc(docId(userId)).get()).data;
      const before=JSON.stringify(value), result=await fn(value,account);
      if(JSON.stringify(value)!==before){delete value._id;await ref.set({data:value});}
      return result;
    });
  }
  async function auxRead(userId,key,fn) {
    let value;
    try {value=(await db.collection(auxiliary).doc(docId(userId+':'+key)).get()).data;}
    catch(e) {if(!/not exist|not found|does not exist|-502001/i.test(e.message))throw e;}
    return fn(value||{});
  }
  async function archivePlan(userId, entitlement) {
    await auxTransact(userId,'plan:'+entitlement.id,(row,s)=>{
      if(!row.entitlement&&s.entitlement?.id===entitlement.id) row.entitlement=entitlement;
    });
  }
  async function loadPlan(userId,id) {
    try {return (await db.collection(auxiliary).doc(docId(userId+':plan:'+id)).get()).data.entitlement;}
    catch(e) {if(/not exist|not found|does not exist|-502001/i.test(e.message)) return null;throw e;}
  }
  async function clearGuidance(userId) {
    // Deletion is retriable; account deletion invalidates in-flight AI work first.
    let rows;
    do {rows=(await db.collection(auxiliary).where({userId}).limit(100).get()).data;
      for(const row of rows) await db.collection(auxiliary).doc(row._id).remove();
    } while(rows.length===100);
  }
  return {
    cloud,
    db,
    stage,
    tables,
    transact,
    lookup,
    auxTransact, auxRead, archivePlan, loadPlan, clearGuidance,
    docId
  };
}
module.exports = {
  createRuntime
};
