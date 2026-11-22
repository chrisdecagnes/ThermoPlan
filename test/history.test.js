'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { HistoryRecorder, setpointOf, SETTING } = require('../lib/history');
const { mockHomey } = require('./helpers');

const T0 = Date.UTC(2026, 10, 19, 8, 0);
const MIN = 60000;

test('historique : un point toutes les 10 min, 24 h conservées, sauvegarde', () => {
  const homey = mockHomey();
  const h = new HistoryRecorder({ homey });
  assert.strictEqual(h.record(T0, 5.24, [{ id: 'a', temperature: 19.46, setpoint: 20 }]), true);
  assert.strictEqual(h.record(T0 + 3 * MIN, 5, [{ id: 'a', temperature: 19.5, setpoint: 20 }]), false);
  assert.strictEqual(h.record(T0 + 10 * MIN, 5, [{ id: 'a', temperature: 19.6, setpoint: null }]), true);
  assert.deepStrictEqual(h.points[0], { t: T0, o: 5.2, p: { a: [19.5, 20] } });
  assert.deepStrictEqual(h.points[1].p.a, [19.6, null]);
  for (let i = 2; i < 200; i++) h.record(T0 + i * 10 * MIN, 4, [{ id: 'a', temperature: 19, setpoint: 19 }]);
  const now = T0 + 199 * 10 * MIN;
  const pts = h.get(now);
  assert.ok(pts.length <= 145 && pts.length >= 144, `points : ${pts.length}`);
  assert.ok(pts[0].t >= now - 24 * 3600000);
  // relu depuis les réglages
  const h2 = new HistoryRecorder({ homey });
  assert.strictEqual(h2.points.length, homey._store[SETTING].points.length);
  assert.strictEqual(h2.due(now + MIN), false);
});

test('historique : filtre par programme, oubli des programmes supprimés, valeurs vides ignorées', () => {
  const h = new HistoryRecorder({ homey: mockHomey() });
  h.record(T0, null, [{ id: 'a', temperature: 20, setpoint: 21 }, { id: 'b', temperature: null, setpoint: null }]);
  assert.deepStrictEqual(Object.keys(h.points[0].p), ['a']);
  assert.deepStrictEqual(h.get(T0 + MIN, 'a')[0].p, { a: [20, 21] });
  assert.deepStrictEqual(h.get(T0 + MIN, 'zz')[0].p, {});
  h.prune(['b']);
  assert.deepStrictEqual(h.points[0].p, {});
});

test('historique : consigne affichable', () => {
  const base = { enabled: true, inSeason: true, source: 'schedule', action: { kind: 'temperature', value: 20 } };
  assert.strictEqual(setpointOf(base), 20);
  assert.strictEqual(setpointOf({ ...base, enabled: false }), null);
  assert.strictEqual(setpointOf({ ...base, inSeason: false }), null);
  assert.strictEqual(setpointOf({ ...base, source: 'away' }), null);
  assert.strictEqual(setpointOf({ ...base, action: { kind: 'off' } }), null);
  assert.strictEqual(setpointOf({ ...base, action: { kind: 'fan', speed: 0.5 } }), null);
});

test('widget : route getHistory déléguée à l’app (filtre programme)', async () => {
  const widgetApi = require('../widgets/thermoplan/api');
  const calls = [];
  const homey = { app: { apiHistory: (id) => { calls.push(id); return { step: 600000, points: [] }; } } };
  const r = await widgetApi.getHistory({ homey, query: { plan: 'p1' } });
  await widgetApi.getHistory({ homey, query: {} });
  assert.deepEqual(r, { step: 600000, points: [] });
  assert.deepEqual(calls, ['p1', null]);
});
