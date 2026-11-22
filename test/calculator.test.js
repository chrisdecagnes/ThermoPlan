'use strict';

const test = require('node:test');
const assert = require('node:assert');
const calc = require('../lib/calculator');
const { localParts, isInRange } = require('../lib/time');
const { normalizePlan } = require('../lib/repository');

const plan = (schedule, extra = {}) => normalizePlan({ name: 't', enabled: true, schedule, ...extra });

test('point de consigne actif dans la journée', () => {
  const p = plan([
    { day: 1, hour: 6, minute: 0, targetTemperature: 20 },
    { day: 1, hour: 22, minute: 0, targetTemperature: 17 },
  ]);
  assert.strictEqual(calc.getActiveSetPoint(p, { day: 1, hour: 7, minute: 0 }).targetTemperature, 20);
  assert.strictEqual(calc.getActiveSetPoint(p, { day: 1, hour: 22, minute: 0 }).targetTemperature, 17);
  assert.strictEqual(calc.getActiveSetPoint(p, { day: 1, hour: 21, minute: 59 }).targetTemperature, 20);
});

test('avant le premier point : dernier point de la semaine précédente', () => {
  const p = plan([
    { day: 1, hour: 6, minute: 0, targetTemperature: 20 },
    { day: 0, hour: 23, minute: 0, targetTemperature: 16 },
  ]);
  assert.strictEqual(calc.getActiveSetPoint(p, { day: 1, hour: 5, minute: 0 }).targetTemperature, 16);
  // mardi : lundi 6h reste actif
  assert.strictEqual(calc.getActiveSetPoint(p, { day: 2, hour: 12, minute: 0 }).targetTemperature, 20);
});

test('prochain point de consigne avec bouclage sur la semaine', () => {
  const p = plan([{ day: 1, hour: 6, minute: 0, targetTemperature: 20 }]);
  const n = calc.getNextSetPoint(p, { day: 1, hour: 7, minute: 0 });
  assert.strictEqual(n.inMinutes, 7 * 1440 - 60);
  const n2 = calc.getNextSetPoint(p, { day: 0, hour: 23, minute: 0 });
  assert.strictEqual(n2.inMinutes, 7 * 60);
});

test('fuseau horaire : 23h30 UTC = lundi 00h30 à Paris (hiver)', () => {
  const l = localParts(new Date('2026-01-04T23:30:00Z'), 'Europe/Paris'); // dimanche UTC
  assert.deepStrictEqual([l.day, l.hour, l.minute], [1, 0, 30]);
});

test('intervalle de dates été, y compris à cheval sur le nouvel an', () => {
  assert.ok(isInRange(7, 14, '06-01', '09-15'));
  assert.ok(!isInRange(9, 16, '06-01', '09-15'));
  assert.ok(isInRange(1, 10, '12-01', '02-28'));
});

test('saison effective', () => {
  assert.strictEqual(calc.getEffectiveSeason('auto', { month: 7, date: 1 }, '06-01', '09-15'), 'cooling');
  assert.strictEqual(calc.getEffectiveSeason('auto', { month: 11, date: 16 }, '06-01', '09-15'), 'heating');
  assert.strictEqual(calc.getEffectiveSeason('off', { month: 7, date: 1 }, '06-01', '09-15'), 'off');
});

test('saison « extérieure » : valeur de la sonde, sinon repli sur les dates', () => {
  assert.strictEqual(calc.getEffectiveSeason('outdoor', { month: 11, date: 16 }, '06-01', '09-15', 'off'), 'off');
  assert.strictEqual(calc.getEffectiveSeason('outdoor', { month: 11, date: 16 }, '06-01', '09-15', 'cooling'), 'cooling');
  assert.strictEqual(calc.getEffectiveSeason('outdoor', { month: 7, date: 1 }, '06-01', '09-15', null), 'cooling');
  assert.strictEqual(calc.getEffectiveSeason('outdoor', { month: 11, date: 16 }, '06-01', '09-15', null), 'heating');
  // la valeur de la sonde est ignorée hors du mode « outdoor »
  assert.strictEqual(calc.getEffectiveSeason('auto', { month: 11, date: 16 }, '06-01', '09-15', 'cooling'), 'heating');
});

test('chauffage hors saison : exception « Hors saison » appliquée', () => {
  const p = plan([{ day: 1, hour: 6, minute: 0, targetTemperature: 20 }], { overrides: { OutOfSeason: { targetTemperature: 12 } } });
  const e = calc.evaluatePlan(p, { mode: 0, season: 'cooling', local: { day: 1, hour: 8, minute: 0 } });
  assert.deepStrictEqual(e.action, { kind: 'temperature', value: 12 });
});

test('climatisation : arrêt hors saison, consigne en été, exception vacances', () => {
  const p = plan([
    { day: 1, hour: 12, minute: 0, targetTemperature: 25 },
    { day: 1, hour: 23, minute: 0, off: true },
  ], { type: 'cooling', overrides: { Holiday: { off: true } } });
  const local = { day: 1, hour: 13, minute: 0 };
  assert.deepStrictEqual(calc.evaluatePlan(p, { mode: 0, season: 'heating', local }).action, { kind: 'off' });
  assert.deepStrictEqual(calc.evaluatePlan(p, { mode: 0, season: 'cooling', local }).action, { kind: 'temperature', value: 25 });
  assert.deepStrictEqual(calc.evaluatePlan(p, { mode: 0, season: 'cooling', local: { day: 1, hour: 23, minute: 30 } }).action, { kind: 'off' });
  assert.deepStrictEqual(calc.evaluatePlan(p, { mode: 4, season: 'cooling', local }).action, { kind: 'off' });
});

test('ventilation : vitesse et arrêt', () => {
  const p = plan([
    { day: 1, hour: 13, minute: 0, fanSpeed: 0.6 },
    { day: 1, hour: 22, minute: 0, fanSpeed: 0 },
  ], { type: 'fan' });
  assert.deepStrictEqual(calc.evaluatePlan(p, { mode: 0, season: 'cooling', local: { day: 1, hour: 14, minute: 0 } }).action, { kind: 'fan', speed: 0.6 });
  assert.deepStrictEqual(calc.evaluatePlan(p, { mode: 0, season: 'cooling', local: { day: 1, hour: 22, minute: 1 } }).action, { kind: 'fan', speed: 0 });
});

test('plan « toute l’année » actif en hiver', () => {
  const p = plan([{ day: 1, hour: 0, minute: 0, fanSpeed: 0.3 }], { type: 'fan', season: 'always' });
  assert.strictEqual(calc.evaluatePlan(p, { mode: 0, season: 'heating', local: { day: 1, hour: 1, minute: 0 } }).source, 'schedule');
});

test('thermostat manuel : rien n’est appliqué', () => {
  const p = plan([{ day: 1, hour: 0, minute: 0, targetTemperature: 20 }], { thermostatMode: 6 });
  assert.strictEqual(calc.evaluatePlan(p, { mode: 0, season: 'heating', local: { day: 1, hour: 1, minute: 0 } }).action, null);
});

test('conflits : max chauffage, min clim, température > arrêt', () => {
  const T = (v, planType = 'heating') => ({ action: { kind: 'temperature', value: v }, planType });
  assert.strictEqual(calc.resolveConflict([T(18), T(21)]).action.value, 21);
  assert.strictEqual(calc.resolveConflict([T(18), T(21)], { heating: 'min' }).action.value, 18);
  assert.strictEqual(calc.resolveConflict([T(24, 'cooling'), T(27, 'cooling')]).action.value, 24);
  assert.strictEqual(calc.resolveConflict([{ action: { kind: 'off' }, planType: 'cooling' }, T(26, 'cooling')]).action.value, 26);
});

test('import d’un plan de l’application d’origine (exceptions numérotées)', () => {
  const p = normalizePlan({
    id: 'x', name: 'Salon', enabled: true, schedule: [{ day: 1, hour: 6, minute: 0, targetTemperature: '20.5' }],
    overrides: { 4: { targetTemperature: 15 } }, zones: ['z1'],
  });
  assert.strictEqual(p.type, 'heating');
  assert.strictEqual(p.schedule[0].targetTemperature, 20.5);
  assert.deepStrictEqual(p.overrides.Holiday, { targetTemperature: 15 });
});
