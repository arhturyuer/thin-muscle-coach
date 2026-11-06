const store = require('../core/store');
const domain = require('../shared/domain');

function id() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function write(kind, key, value) {
  if (!domain.validRecord(kind, value)) throw new Error('记录格式不正确');
  const s = store.get(),
    old = s.records[key];
  const operation = {
    id: id(),
    kind,
    key,
    value,
    baseVersion: old ? old.version : 0
  };
  const pending = s.queue.find(o => o.key === key);
  if (pending) operation.baseVersion = pending.baseVersion;
  store.save({
    records: {
      ...s.records,
      [key]: {
        kind,
        value,
        version: operation.baseVersion,
        pending: true
      }
    },
    queue: [...s.queue.filter(o => o.key !== key), operation]
  });
  require('./syncService').schedule();
  return operation;
}

function accept(remote) {
  const s = store.get();
  if (remote.profile && s.profile && remote.profile.version < s.profile.version) remote = {...remote,profile:s.profile};
  if(remote.activitySteps){
    const reset=remote.dataEpoch!=null&&remote.dataEpoch!==(s.dataEpoch||0);
    const days=reset?{}:{...(s.activitySteps||{})};
    for(const [date,row] of Object.entries(remote.activitySteps)){const old=days[date];if(!old||row.observedAt>old.observedAt||row.observedAt===old.observedAt&&row.sequence>=old.sequence)days[date]=row;}
    remote={...remote,activitySteps:days,...(reset?{stepsConsent:false,stepsNeedsSettings:false,stepsPlatformBlocked:false,stepsFailure:null,stepsStatus:'',stepsReference:null,stepsEpoch:(s.stepsEpoch||0)+1}:{})};
  }
  const records = remote.incremental ? {
    ...s.records,
    ...remote.records
  } : {
    ...remote.records
  };
  if(remote.dataEpoch!=null&&remote.dataEpoch!==(s.dataEpoch||0)){
    require('./meal-photo').clearLocal(s);
    remote={...remote,workoutWeeks:{},workoutStates:{},legacyWorkoutPlans:{},workoutAttempt:null,mealWeeks:{},mealWeekStates:{},legacyMealDays:{},mealPhotos:{},mealPlans:{},mealPhotoDraft:null,mealPlanConsent:false,mealPlanPending:null};
  }
  s.queue.forEach(o => {
    records[o.key] = {
      kind: o.kind,
      value: o.value,
      version: o.baseVersion,
      pending: true
    };
  });
  store.save({
    ...remote,
    records,
    queue: s.queue
  });
}

function resolve(index, useLocal) {
  const s = store.get(),
    c = s.conflicts[index];
  if (!c) return;
  const records = {
    ...s.records
  };
  if (c.remote) records[c.operation.key] = c.remote;
  else delete records[c.operation.key];
  store.save({
    records,
    conflicts: s.conflicts.filter((_, i) => i !== index)
  });
  if (useLocal) write(c.operation.kind, c.operation.key, c.operation.value);
}

function retryRejectedEvents() {
  const conflicts = store.get().conflicts;
  for (let i = conflicts.length - 1; i >= 0; i--) {
    const c = conflicts[i];
    if (c.invalid && c.message === '记录格式不正确' && c.operation.kind === 'event' && domain.validRecord('event', c.operation.value)) resolve(i, true);
  }
}
module.exports = {
  write,
  retryRejectedEvents,
  accept,
  resolve,
  id
};
