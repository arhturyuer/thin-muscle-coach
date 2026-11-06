const {
  test
} = require('node:test'), assert = require('node:assert/strict'), d = require('../shared/domain'), b = require('../server/business');
const assessment = {
  age: 28,
  goal: 'habit',
  experience: 'beginner',
  minutes: 15,
  equipment: 'none',
  screening: 'clear',
  consent: true
};

function paid() {
  const s = b.fresh();
  s.orders.push({
    id: 'order123456',
    status: 'pending',
    amount: 990,
    plan: d.makePlan(assessment)
  });
  b.fulfill(s, 'order123456', 'wx123');
  return s;
}
const now = Date.parse('2026-10-30T12:00:00+08:00');

function started() {
  const s = paid();
  b.activate(s, now, 'test-secret');
  return s;
}

function sessionOp(s, overrides = {}) {
  return {
    id: 'operation123',
    key: 'session:' + s.entitlement.id + ':0',
    kind: 'session',
    baseVersion: 0,
    value: {
      planId: s.entitlement.id,
      date: '2026-10-30',
      day: 0,
      status: 'completed',
      completedSets: 8,
      seconds: 900,
      difficulty: 'okay',
      discomfort: false,
      ...overrides
    }
  };
}
test('all four template variants have four training and three recovery days', () => {
  for (const equipment of ['none', 'band'])
    for (const minutes of [15, 30]) {
      const p = d.makePlan({
        ...assessment,
        equipment,
        minutes
      });
      assert.equal(p.days.length, 7);
      assert.equal(p.days.filter(x => !x.rest).length, 4);
      assert.equal(p.days[0].exercises.length, equipment === 'band' ? 5 : 4);
      assert.equal(p.days[0].exercises[0].sets, minutes === 30 ? 3 : 2);
    }
});
test('screening rejects personalized template and minors cannot enroll', () => {
  assert.equal(d.makePlan({
    ...assessment,
    screening: 'guidance'
  }), null);
  assert.throws(() => d.makePlan({
    ...assessment,
    age: 17
  }));
  assert.throws(() => d.makePlan({
    ...assessment,
    consent: false
  }));
});
test('Shanghai day boundary independent of host timezone', () => {
  assert.equal(d.localDate(Date.parse('2026-10-30T15:59:59Z')), '2026-10-30');
  assert.equal(d.localDate(Date.parse('2026-10-30T16:00:00Z')), '2026-10-31');
});
test('payment is idempotent and activates only at first training', () => {
  const s = paid();
  assert.equal(s.entitlement.status, 'pending');
  assert.equal(s.entitlement.startDate, undefined);
  b.fulfill(s, 'order123456', 'wx123');
  assert.equal(s.orders.length, 1);
  const e = b.activate(s, now, 'test-secret');
  assert.equal(e.startDate, '2026-10-30');
  const credential = e.credential;
  b.activate(s, now + 3600000, 'test-secret');
  assert.equal(e.credential, credential);
  assert.equal(e.expiresAt, Date.parse('2026-11-06T00:00:00+08:00'));
});
test('challenge expires at start of eighth local day', () => {
  const s = started();
  assert.equal(d.active(s.entitlement, Date.parse('2026-11-05T23:59:59+08:00')), true);
  assert.equal(d.active(s.entitlement, Date.parse('2026-11-06T00:00:00+08:00')), false);
  assert.throws(() => b.activate(s, now + 7 * d.DAY, 'test-secret'));
});
test('refund revokes access and a late payment notification cannot regrant', () => {
  const s = started();
  b.refund(s, 'order123456', 'refund1');
  assert.equal(s.entitlement.status, 'revoked');
  b.fulfill(s, 'order123456', 'wx123');
  assert.equal(s.entitlement.status, 'revoked');
  assert.throws(() => b.activate(s, now, 'secret'));
});
test('unpaid, wrong plan, future date and out-of-range records rejected', () => {
  const s = started(),
    op = sessionOp(s);
  for (const value of [{
      ...op.value,
      planId: 'someone-else'
    }, {
      ...op.value,
      date: '2026-11-10'
    }, {
      ...op.value,
      date: '2026-10-31'
    }, {
      ...op.value,
      completedSets: 99
    }]) assert.equal(b.applyBatch(s, [{
    ...op,
    value
  }], now)[0].status, 'invalid');
  const unpaid = b.fresh();
  assert.equal(b.applyBatch(unpaid, [op], now)[0].status, 'invalid');
});
test('same operation and repeated completion count once', () => {
  const s = started(),
    op = sessionOp(s);
  const first = b.applyBatch(s, [op], now);
  assert.equal(first[0].status, 'ok');
  assert.deepEqual(b.applyBatch(s, [op], now), first);
  assert.equal(d.report(s).sessions, 1);
  assert.equal(b.applyBatch(s, [{
    ...op,
    id: 'another123'
  }], now)[0].status, 'conflict');
  assert.equal(d.report(s).sessions, 1);
});
test('completed session cannot be overwritten with interruption', () => {
  const s = started(),
    op = sessionOp(s);
  b.applyBatch(s, [op], now);
  assert.equal(b.applyBatch(s, [{
    ...op,
    id: 'interrupted123',
    baseVersion: 1,
    value: {
      ...op.value,
      status: 'interrupted'
    }
  }], now)[0].status, 'conflict');
});
test('old offline completion accepted inside its paid period after expiry', () => {
  const s = started();
  s.entitlement.status = 'expired';
  assert.equal(b.applyBatch(s, [sessionOp(s)], now + 9 * d.DAY)[0].status, 'ok');
});
test('record kind cannot overwrite a different kind', () => {
  const s = started();
  b.applyBatch(s, [{
    id: 'assessment123',
    key: 'assessment',
    kind: 'assessment',
    baseVersion: 0,
    value: assessment
  }], now);
  const op = sessionOp(s);
  assert.equal(b.applyBatch(s, [{
    ...op,
    key: 'assessment',
    baseVersion: 1
  }], now)[0].status, 'invalid');
});
test('report omits missing measurements and counts actual completions', () => {
  const s = started();
  assert.deepEqual(d.report(s).measurements, []);
  assert.equal(d.report(s).completion, 0);
  b.applyBatch(s, [sessionOp(s)], now);
  assert.equal(d.report(s).completion, 25);
});
test('invalid numeric and oversized meal records rejected', () => {
  assert.equal(d.validRecord('measurement', {
    date: '2026-10-30',
    weight: NaN,
    waist: null
  }), false);
  assert.equal(d.validRecord('measurement', {
    date: '2026-10-30',
    weight: null,
    waist: null
  }), false);
  assert.equal(d.validRecord('daily', {
    date: '2026-10-30',
    nutrition: true,
    breakfast: 'x'.repeat(1001),
    lunch: '',
    dinner: ''
  }), false);
});
test('reminders default off, respect scheduled window and deduplicate', () => {
  const s = started();
  assert.equal(b.reminderDue(s, now), null);
  s.reminder = {
    enabled: true,
    time: '20:00'
  };
  const due = Date.parse('2026-10-30T20:05:00+08:00');
  assert.equal(b.reminderDue(s, due).date, '2026-10-30');
  assert.equal(b.reminderDue(s, Date.parse('2026-10-30T21:01:00+08:00')), null);
  s.notification['2026-10-30'] = {
    status: 'sending'
  };
  assert.equal(b.reminderDue(s, due), null);
});
test('all tasks completed suppress ordinary reminder, seventh-day report still eligible', () => {
  const s = started();
  s.reminder = {
    enabled: true,
    time: '20:00'
  };
  b.applyBatch(s, [sessionOp(s)], now);
  s.records.daily = {
    kind: 'daily',
    value: {
      date: '2026-10-30',
      nutrition: true,
      planId: s.entitlement.id
    }
  };
  assert.equal(b.reminderDue(s, Date.parse('2026-10-30T20:05:00+08:00')), null);
  assert.equal(b.reminderDue(s, Date.parse('2026-11-05T20:05:00+08:00')).report, true);
});
test('exhausted authorizations do not repeatedly attempt sending', () => {
  const s = started();
  s.reminder = {
    enabled: true,
    time: '20:00',
    authorization: 'exhausted'
  };
  assert.equal(b.reminderDue(s, Date.parse('2026-10-30T20:05:00+08:00')), null);
});
test('public state never leaks operation ledger or internal notifications', () => {
  const s = started();
  s.processed.secret = 'secret';
  assert.equal(b.publicState(s).processed, undefined);
  assert.equal(b.publicState(s).notification, undefined);
});
test('an older paid challenge can sync offline history after a new challenge is purchased', () => {
  const s = started();
  const op = sessionOp(s);
  s.entitlement.status = 'expired';
  s.orders.push({
    id: 'second123456',
    status: 'pending',
    amount: 990,
    plan: d.makePlan(assessment)
  });
  b.fulfill(s, 'second123456', 'wx2');
  assert.equal(b.applyBatch(s, [op], now + 8 * d.DAY)[0].status, 'ok');
});
test('production payment and content flags require actual credentials and reviewed media', () => {
  assert.equal(b.config({
    PAYMENT_READY: 'true'
  }).paymentsEnabled, false);
  assert.equal(b.config({
    CONTENT_PUBLISHED: 'true'
  }).contentPublished, false);
});
test('impossible calendar dates and incomplete completions are rejected', () => {
  assert.equal(d.validRecord('measurement', {
    date: '2026-02-30',
    weight: 70
  }), false);
  const s = started();
  assert.equal(b.applyBatch(s, [sessionOp(s, {
    completedSets: 0
  })], now)[0].status, 'invalid');
});
test('incremental bootstrap returns only changed records, reset forces full replacement', () => {
  const s = started();
  b.applyBatch(s, [sessionOp(s)], now);
  const cursor = s.revision;
  assert.deepEqual(b.publicState(s, cursor).records, {});
  assert.equal(b.publicState(s, cursor).incremental, true);
  b.applyBatch(s, [{
    id: 'measure123',
    key: 'measurement:2026-10-30',
    kind: 'measurement',
    baseVersion: 0,
    value: {
      date: '2026-10-30',
      weight: 70
    }
  }], now);
  assert.deepEqual(Object.keys(b.publicState(s, cursor).records), ['measurement:2026-10-30']);
  s.resetRevision = s.revision;
  assert.equal(b.publicState(s, cursor).incremental, false);
});

test('analytics keys with underscores sync idempotently but cannot escape the event namespace', () => {
  const s = b.fresh(),
    event = {
      id: 'eventop123',
      key: 'event:assessment_started:abc123',
      kind: 'event',
      baseVersion: 0,
      value: {
        name: 'assessment_started',
        at: Date.now(),
        date: d.localDate()
      }
    };
  assert.equal(b.applyBatch(s, [event])[0].status, 'ok');
  assert.equal(b.applyBatch(s, [event])[0].status, 'ok');
  assert.equal(Object.keys(s.records).length, 1);
  assert.equal(b.applyBatch(s, [{
    ...event,
    id: 'eventop456',
    key: '__proto__'
  }])[0].status, 'invalid');
  assert.equal(b.applyBatch(s, [{
    ...event,
    id: 'eventop789',
    key: 'event:assessment_completed:abc123'
  }])[0].status, 'invalid');
});
