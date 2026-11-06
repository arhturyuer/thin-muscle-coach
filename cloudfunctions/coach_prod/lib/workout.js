/* Natural-week workouts and manual records, shared by client and server. */
const DAY = 86400000;
const shift = (date, days) => new Date(Date.parse(date + 'T00:00:00Z') + days * DAY).toISOString().slice(0, 10);
function week(date) {
  const start = shift(date, -((new Date(date + 'T00:00:00Z').getUTCDay() + 6) % 7));
  return {start, end: shift(start, 6)};
}
function validDate(date) {
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0,10) === date;
}
const integer = (n, max) => Number.isInteger(n) && n >= 0 && n <= max;
const difficulties = ['unknown','easy','okay','hard'];
const maxSets = 20;

function summarizeSets(setDetails, timed) {
  const checked = setDetails.filter(set => set.completed);
  return {
    sets: checked.length,
    reps: timed ? null : checked.length ? Math.min(...checked.map(set => set.reps)) : 0,
    seconds: checked.reduce((total, set) => total + set.seconds, 0)
  };
}

function validExercise(move) {
  if (!move || typeof move.id !== 'string' || !/^move-\d+$/.test(move.id) ||
      !integer(move.sets,maxSets) || (move.reps !== null && !integer(move.reps,200)) || !integer(move.seconds,7200)) return false;
  if (move.setDetails === undefined && move.difficulty === undefined) return true;
  const timed = move.reps === null;
  if (!difficulties.includes(move.difficulty) || !Array.isArray(move.setDetails) || move.setDetails.length > maxSets ||
      !move.setDetails.every(set => set && typeof set.completed === 'boolean' &&
        (set.weightKg === null || Number.isFinite(set.weightKg) && set.weightKg >= 0 && set.weightKg <= 1000) &&
        (timed ? set.reps === null : integer(set.reps,200)) && integer(set.seconds,7200) &&
        (!set.completed || set.seconds > 0 && (timed || set.reps > 0)))) return false;
  const totals = summarizeSets(move.setDetails, timed);
  return move.sets === totals.sets && move.reps === totals.reps && move.seconds === totals.seconds;
}

function validRecord(v) {
  return !!v && validDate(v.date) && v.planId === 'workout-' + week(v.date).start && integer(v.planVersion,100000) && v.planVersion > 0 &&
    ['completed','partial','recovery'].includes(v.status) && difficulties.includes(v.difficulty) &&
    typeof v.discomfort === 'boolean' && Number.isFinite(v.at) && integer(v.completedSets,200) && integer(v.seconds,86400) &&
    Array.isArray(v.exercises) && v.exercises.length <= 12 && v.exercises.every(validExercise) &&
    new Set(v.exercises.map(x=>x.id)).size === v.exercises.length &&
    v.completedSets === v.exercises.reduce((n,x)=>n+x.sets,0) && v.seconds === v.exercises.reduce((n,x)=>n+x.seconds,0);
}
function matches(v, day) {
  if (!validRecord(v) || !day || day.date !== v.date || day.planVersion !== v.planVersion) return false;
  if (day.rest) return v.status==='recovery' && !v.exercises.length && !v.seconds && !v.completedSets;
  if (v.status==='recovery' || v.exercises.length !== day.exercises.length) return false;
  return day.exercises.every(move=>{
    const actual=v.exercises.find(x=>x.id===move.id);
    return actual && (move.mode==='time' ? actual.reps===null : actual.reps!==null) &&
      (actual.sets>0 ? actual.seconds>0 && (move.mode==='time'||actual.reps>0) : actual.seconds===0 && (actual.reps===null||actual.reps===0));
  }) && v.exercises.some(x=>x.sets>0) && (v.status!=='completed' || !v.discomfort && day.exercises.every(move=>{
    const actual=v.exercises.find(x=>x.id===move.id);
    return actual.sets>=move.sets && (move.mode==='time' ? actual.seconds>=move.seconds : actual.reps>=move.reps);
  }));
}
function untrainedRecovery(record) {
  return record?.status==='recovery' && !record.discomfort && record.completedSets===0 && record.seconds===0;
}
function replacesRecovery(day, record) {
  return untrainedRecovery(record) && !!day && !day.rest && day.planVersion>record.planVersion;
}
// A manual record replaces the legacy session for the same date in statistics.
function sessions(records) {
  const rows=Object.entries(records||{}).map(([key,r])=>({key,...r}));
  const manual=rows.filter(r=>r.kind==='workoutRecord');
  const dates=new Set(manual.map(r=>r.value.date));
  return [...rows.filter(r=>r.kind==='session'&&!dates.has(r.value.date)),...manual.filter(r=>r.value.status!=='recovery').map(r=>({...r,value:{...r.value,manual:true,status:r.value.status==='partial'?'interrupted':r.value.status}}))];
}
function prescription(move) {
  return move.mode==='time' ? `${move.sets} 组 · 共 ${move.seconds} 秒` : `${move.sets} 组 × ${move.reps} 次 · 共 ${move.seconds} 秒`;
}
module.exports={shift,week,validDate,validRecord,matches,untrainedRecovery,replacesRecovery,sessions,prescription,summarizeSets,maxSets};
