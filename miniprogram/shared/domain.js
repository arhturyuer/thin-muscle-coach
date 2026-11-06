/* Pure domain functions shared by client and cloud. No platform calls. */
const guidance = require('./guidance');
const VERSION = 'starter-1';
const DAY = 86400000;
const exercises = [{
    id: 'squat',
    name: '椅子深蹲',
    cue: '髋部向后，缓慢坐向稳固椅面，再站起。保持自然呼吸。',
    alternative: '缩小下蹲幅度',
    reps: 8
  },
  {
    id: 'push',
    name: '墙面俯卧撑',
    cue: '双手扶墙，身体保持一条线，缓慢屈肘靠近墙面。',
    alternative: '站得更靠近墙面',
    reps: 8
  },
  {
    id: 'bridge',
    name: '臀桥',
    cue: '仰卧屈膝，脚掌着地，平稳抬起和放下髋部。',
    alternative: '减小抬起幅度',
    reps: 10
  },
  {
    id: 'bird',
    name: '鸟狗式',
    cue: '四点支撑，交替伸展对侧手脚，避免转动躯干。',
    alternative: '只伸出一条腿',
    reps: 6
  },
  {
    id: 'row',
    name: '弹力带划船',
    cue: '确认弹力带完整并固定可靠，屈肘向后拉，缓慢还原。',
    alternative: '使用更轻阻力',
    reps: 8
  }
];

function localDate(now = Date.now()) {
  return new Date(now + 8 * 3600000).toISOString().slice(0, 10);
}

function dayIndex(start, now = Date.now()) {
  return Math.floor((Date.parse(localDate(now)) - Date.parse(start)) / DAY);
}

function validateAssessment(a) {
  if (a && [2,3].includes(a.schemaVersion)) return guidance.validate(a);
  if (!a || !a.consent) return '请先阅读并同意数据使用说明';
  if (!Number.isInteger(Number(a.age)) || Number(a.age) < 18 || Number(a.age) > 100) return '首版仅面向 18–100 岁成年人';
  if (!['none', 'band'].includes(a.equipment) || ![15, 30].includes(Number(a.minutes))) return '请选择训练条件';
  if (!['beginner', 'occasional'].includes(a.experience) || !['habit', 'strength', 'posture'].includes(a.goal)) return '请选择运动经验和目标';
  if (!['clear', 'guidance'].includes(a.screening)) return '请完成运动适用性确认';
  return '';
}

function makePlan(a, media = {}, options = {}) {
  if (a && [2,3].includes(a.schemaVersion)) return guidance.makePlan(a, exercises, media, options);
  const error = validateAssessment(a);
  if (error) throw new Error(error);
  if (a.screening !== 'clear') return null;
  const moves = exercises.filter(e => e.id !== 'row' || a.equipment === 'band');
  return {
    version: VERSION,
    contentStatus: 'draft',
    assessment: {
      ...a
    },
    minutes: Number(a.minutes),
    equipment: a.equipment,
    title: `居家${a.equipment==='band'?'弹力带':'自重'} · ${a.minutes} 分钟`,
    reason: '从基础动作与恢复日开始，按你可用的时间和器械安排。',
    days: Array.from({
      length: 7
    }, (_, i) => ({
      index: i,
      title: ['全身启动', '轻松恢复', '基础力量', '轻松恢复', '全身巩固', '轻松恢复', '回顾与练习'][i],
      rest: [1, 3, 5].includes(i),
      exercises: [1, 3, 5].includes(i) ? [] : moves.map(e => ({
        ...e,
        sets: Number(a.minutes) === 30 ? 3 : 2,
        media: media[e.id] || ''
      })),
      nutrition: ['三餐规律，记录一餐感受', '在一餐中搭配蛋白质食物', '为一餐添加蔬菜', '留意饥饱，放慢进食', '提前安排下一餐', '回顾本周饮食节奏', '选一个愿意继续的饮食习惯'][i]
    }))
  };
}

function currentDay(entitlement, now = Date.now()) {
  return entitlement && entitlement.startDate ? dayIndex(entitlement.startDate, now) : -1;
}

function active(entitlement, now = Date.now()) {
  return !!entitlement && (!entitlement.memberPlan || now < entitlement.expiresAt) && entitlement.status === 'active' && currentDay(entitlement, now) >= 0 && currentDay(entitlement, now) < 7;
}

function report(state) {
  const workout=require('./workout'),week=workout.week(localDate()),currentWorkout=state.workoutWeeks?.[week.start];
  const sessions = workout.sessions(state.records).filter(r => r.value.status === 'completed' && (currentWorkout||r.kind==='workoutRecord' ? r.value.date>=week.start && r.value.date<=localDate() : r.value.planId === (state.entitlement || {}).id));
  const days = new Set(sessions.map(r => r.value.date));
  const logs = Object.values(state.records || {}).filter(r => r.kind === 'daily' && r.value.planId === (state.entitlement || {}).id);
  return {
    sessions: sessions.length,
    trainingDays: days.size,
    plannedTrainingDays: currentWorkout ? currentWorkout.days.filter(x=>!x.rest).length : state.entitlement?.plan?.assessment?.frequency||4,
    weekStart: currentWorkout?.weekStart||state.entitlement?.startDate||null,
    nutritionDays: new Set(logs.filter(r => r.value.nutrition).map(r => r.value.date)).size,
    completion: Math.min(100,Math.round(days.size / Math.max(1, (currentWorkout?.days || state.entitlement?.plan?.days || []).filter(x=>!x.rest).length || 4) * 100)),
    measurements: Object.values(state.records || {}).filter(r => r.kind === 'measurement').map(r => r.value).sort((a, b) => a.date.localeCompare(b.date))
  };
}

function initialState() {
  return {
    profile: require('./account').defaultProfile(),
    records: {},
    orders: [],
    entitlement: null,
    reminder: {
      enabled: false,
      time: '20:00'
    },
    revision: 0
  };
}

function validDate(value) {
  const t = Date.parse(value + 'T00:00:00+08:00');
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(t) && localDate(t) === value;
}

function validRecord(kind, v) {
  if (!v || typeof v !== 'object' || JSON.stringify(v).length > 20000) return false;
  if (kind === 'workoutRecord') return require('./workout').validRecord(v);
  if (kind === 'event' && v.durationMs != null && (!Number.isFinite(v.durationMs) || v.durationMs < 0 || v.durationMs > DAY)) return false;
  if (kind === 'event') return ['home_viewed', 'assessment_step', 'plan_viewed', 'sku_selected', 'purchase_clicked', 'payment_cancelled', 'payment_failed', 'first_task_started', 'review_submitted', 'assessment_started', 'assessment_completed', 'purchase_started', 'purchase_paid', 'workout_started', 'workout_completed', 'workout_interrupted', 'nutrition_saved', 'report_viewed', 'reminder_enabled', 'reminder_disabled', 'daily_input', 'meal_record_started', 'meal_recorded', 'meal_edited', 'meal_undone', 'photo_corrected', 'adjustment_proposed', 'adjustment_adopted', 'adjustment_undone', 'daily_detail_opened'].includes(v.name) && Number.isFinite(v.at) && validDate(v.date) && Object.keys(v).every(k => ['name', 'at', 'date', 'durationMs'].includes(k));
  if (kind === 'meal') return ['photoIds','previousPhotoIds'].every(k=>v[k]===undefined||Array.isArray(v[k])&&v[k].length<=20&&v[k].every(id=>typeof id==='string'&&/^[a-f0-9]{32}$/.test(id))) && ['nutritionIncomplete','previousNutritionIncomplete'].every(k=>v[k]===undefined||typeof v[k]==='boolean') && typeof v.planId === 'string' && validDate(v.date) && require('./daily').slots.includes(v.slot) && typeof v.text === 'string' && v.text.length <= 1000 && ['text','recipe','photo','edit','undo'].includes(v.source) && ['analysisIds','previousAnalysisIds'].every(k=>v[k]==null||Array.isArray(v[k])&&v[k].length<=20&&v[k].every(id=>typeof id==='string'&&/^analysis:[-a-zA-Z0-9:]{1,140}$/.test(id))) && Number.isFinite(v.at) && (v.previous == null || typeof v.previous === 'string' && v.previous.length <= 1000);
  if (kind === 'mealAnalysis') return typeof v.planId === 'string' && validDate(v.date) && require('./daily').slots.includes(v.slot) && Number.isFinite(v.at) && require('./nutrition').validAnalysis(v.analysis);
  if (kind === 'dailyFeedback') return typeof v.planId === 'string' && validDate(v.date) && Number.isFinite(v.at) && ['fatigue','hunger'].every(k=>v[k] == null || ['low','okay','high'].includes(v[k]));
  if (kind === 'preference') return typeof v.text === 'string' && v.text.length <= 1000 && typeof v.active === 'boolean' && Number.isFinite(v.at) && validDate(v.date);
  if (kind === 'assessment') return (v.mealWeekConsentVersion===undefined||v.mealWeekConsentVersion===1)&&!validateAssessment(v);
  if (kind === 'daily') return validDate(v.date) && typeof v.nutrition === 'boolean' && (v.recovery === undefined || typeof v.recovery === 'boolean') && ['breakfast', 'lunch', 'dinner'].every(k => typeof v[k] === 'string' && v[k].length <= 1000);
  if (kind === 'measurement') return validDate(v.date) && ['weight', 'waist'].every(k => v[k] == null || (typeof v[k] === 'number' && v[k] > 0 && v[k] < 500)) && (v.weight != null || v.waist != null);
  if (kind === 'session') return typeof v.planId === 'string' && Number.isInteger(v.day) && v.day >= 0 && v.day < 100000 && ['completed', 'interrupted'].includes(v.status) && Number.isInteger(v.completedSets) && v.completedSets >= 0 && v.completedSets <= 100 && typeof v.discomfort === 'boolean' && ['easy', 'okay', 'hard', 'unknown'].includes(v.difficulty) && Number.isFinite(v.seconds) && v.seconds >= 0 && v.seconds <= DAY / 1000 && validDate(v.date);
  return false;
}
module.exports = {
  VERSION,
  DAY,
  exercises,
  localDate,
  dayIndex,
  validateAssessment,
  makePlan,
  currentDay,
  active,
  report,
  initialState,
  validDate,
  validRecord
};
