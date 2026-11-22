'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Slots = require('../settings/slots');
const calc = require('../lib/calculator');
const { normalizePlan, defaultSchedule, PlanRepository } = require('../lib/repository');
const { mockHomey } = require('./helpers');

const at = (plan, day, hour, minute) => calc.evaluatePlan(plan, { mode: 0, season: plan.type === 'heating' ? 'heating' : 'cooling', local: { day, hour, minute } }).action;

test('plages → programme : consigne dans la plage, valeur hors plages autour', () => {
  const p = normalizePlan({
    name: 'x', type: 'heating', base: { targetTemperature: 17 },
    slots: [{ days: [1, 2, 3, 4, 5], start: '06:00', end: '08:00', value: { targetTemperature: 20 } }],
  });
  assert.deepStrictEqual(at(p, 1, 5, 59), { kind: 'temperature', value: 17 });
  assert.deepStrictEqual(at(p, 1, 6, 0), { kind: 'temperature', value: 20 });
  assert.deepStrictEqual(at(p, 1, 8, 0), { kind: 'temperature', value: 17 });
  assert.deepStrictEqual(at(p, 6, 7, 0), { kind: 'temperature', value: 17 }); // samedi
  assert.strictEqual(p.schedule.length, 10); // 5 jours × (début + fin)
});

test('plage de nuit qui déborde sur le lendemain, et plages jointives fusionnées', () => {
  const p = normalizePlan({
    name: 'x', type: 'cooling', base: { off: true },
    slots: [
      { days: [0], start: '22:00', end: '02:00', value: { targetTemperature: 25 } },
      { days: [3], start: '10:00', end: '12:00', value: { targetTemperature: 26 } },
      { days: [3], start: '12:00', end: '14:00', value: { targetTemperature: 26 } },
    ],
  });
  assert.deepStrictEqual(at(p, 0, 23, 0), { kind: 'temperature', value: 25 });
  assert.deepStrictEqual(at(p, 1, 1, 59), { kind: 'temperature', value: 25 }); // lundi après minuit
  assert.deepStrictEqual(at(p, 1, 2, 0), { kind: 'off' });
  assert.strictEqual(p.schedule.filter((sp) => sp.day === 3).length, 2); // 10:00 et 14:00 seulement
});

test('chevauchement : la plage la plus basse dans la liste gagne et est signalée', () => {
  const slots = [
    { days: [1], start: '08:00', end: '18:00', value: { targetTemperature: 19 } },
    { days: [1], start: '12:00', end: '14:00', value: { targetTemperature: 22 } },
  ];
  const p = normalizePlan({ name: 'x', type: 'heating', base: { targetTemperature: 16 }, slots });
  assert.deepStrictEqual(at(p, 1, 13, 0), { kind: 'temperature', value: 22 });
  assert.deepStrictEqual(at(p, 1, 15, 0), { kind: 'temperature', value: 19 });
  assert.deepStrictEqual(Slots.overlaps(slots), [0, 1]);
  const runs = Slots.dayRuns('heating', slots, { targetTemperature: 16 }).filter((r) => r.day === 1);
  assert.deepStrictEqual(runs.map((r) => [r.start, r.end, r.slot]), [[480, 720, 0], [720, 840, 1], [840, 1080, 0]]);
});

test('ancien programme → plages : conversion sans perte', () => {
  for (const type of ['heating', 'cooling', 'fan']) {
    const schedule = normalizePlan({ name: 'x', type, schedule: defaultSchedule(type) }).schedule;
    const { base, slots } = Slots.fromSchedule(type, schedule);
    const back = normalizePlan({ name: 'x', type, base, slots });
    for (let d = 0; d < 7; d++) {
      for (let h = 0; h < 24; h++) {
        for (const m of [0, 29, 59]) {
          const a = calc.evaluatePlan(normalizePlan({ name: 'x', type, schedule }), { mode: 0, season: type === 'heating' ? 'heating' : 'cooling', local: { day: d, hour: h, minute: m } }).action;
          assert.deepStrictEqual(at(back, d, h, m), a, `${type} ${d} ${h}:${m}`);
        }
      }
    }
  }
  const h = Slots.fromSchedule('heating', defaultSchedule('heating'));
  assert.deepStrictEqual(h.base, { targetTemperature: 17 });
  assert.deepStrictEqual(h.slots[0], { days: [1, 2, 3, 4, 5], start: '06:00', end: '08:00', value: { targetTemperature: 20 } });
  h.slots[0].value.targetTemperature = 21; // chaque plage a sa propre valeur (modifiable séparément)
  assert.strictEqual(h.slots[1].value.targetTemperature, 20);
});

test('nouveau programme : créé en plages', () => {
  const repo = new PlanRepository(mockHomey());
  const p = repo.createDefault('cooling', 'Clim');
  assert.strictEqual(p.slots.length, 1);
  assert.deepStrictEqual(p.base, { off: true });
  assert.strictEqual(p.enabled, false);
  assert.deepStrictEqual(at({ ...p, enabled: true }, 2, 15, 0), { kind: 'temperature', value: 26 });
});

test('valeurs invalides ignorées', () => {
  const p = normalizePlan({
    name: 'x', type: 'fan', base: { fanSpeed: 3 },
    slots: [{ days: [9, 1], start: '25:00', end: '10:00', value: { fanSpeed: 0.5 } }, { days: [1, 1], start: '9:00', end: '10:00', value: { fanSpeed: 0.5 } }],
  });
  assert.strictEqual(p.slots.length, 1);
  assert.deepStrictEqual(p.slots[0].days, [1]);
  assert.strictEqual(p.slots[0].start, '09:00');
  assert.deepStrictEqual(p.base, { fanSpeed: 1 });
});
