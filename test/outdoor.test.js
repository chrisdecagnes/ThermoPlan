'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  outdoorSeason, addSample, averageOver, HOUR,
} = require('../lib/outdoor');
const { PlanRepository } = require('../lib/repository');
const { DeviceManager } = require('../lib/devices');
const { Controller } = require('../lib/controller');
const { mockHomey, mockApi, makeDevice } = require('./helpers');

test('saison extérieure : seuils et mi-saison', () => {
  assert.strictEqual(outdoorSeason(25, null, 22, 15), 'cooling');
  assert.strictEqual(outdoorSeason(22, null, 22, 15), 'cooling');
  assert.strictEqual(outdoorSeason(10, null, 22, 15), 'heating');
  assert.strictEqual(outdoorSeason(18, null, 22, 15), 'off');
  assert.strictEqual(outdoorSeason(null, 'heating', 22, 15), null);
  assert.strictEqual(outdoorSeason(18, null, 15, 22), null); // seuils inversés
});

test('saison extérieure : hystérésis de 1 °C', () => {
  // en été, on y reste tant que la moyenne dépasse 21 °C
  assert.strictEqual(outdoorSeason(21.5, 'cooling', 22, 15), 'cooling');
  assert.strictEqual(outdoorSeason(21, 'cooling', 22, 15), 'off');
  // en hiver, on y reste tant que la moyenne reste sous 16 °C
  assert.strictEqual(outdoorSeason(15.5, 'heating', 22, 15), 'heating');
  assert.strictEqual(outdoorSeason(16, 'heating', 22, 15), 'off');
  // depuis la mi-saison il faut atteindre le seuil
  assert.strictEqual(outdoorSeason(21.5, 'off', 22, 15), 'off');
});

test('moyennes horaires et moyenne glissante', () => {
  const t0 = Date.UTC(2026, 10, 17, 0, 0);
  let b = [];
  // 10 °C pendant l'heure 0 (deux mesures), 20 °C pendant l'heure 1 (une mesure)
  b = addSample(b, t0, 9);
  b = addSample(b, t0 + 60000, 11);
  b = addSample(b, t0 + HOUR, 20);
  assert.strictEqual(b.length, 2);
  assert.strictEqual(averageOver(b, t0 + HOUR, 24), 15); // chaque heure a le même poids
  assert.strictEqual(averageOver(b, t0 + HOUR, 1), 20);
  assert.strictEqual(averageOver(b, t0 + 30 * HOUR, 24), null); // trop ancien
  // les tranches de plus de 72 h sont supprimées
  b = addSample(b, t0 + 80 * HOUR, 5);
  assert.strictEqual(b.length, 1);
});

async function setupOutdoor(settings) {
  const sensor = makeDevice('ext', { class: 'sensor', capabilities: ['measure_temperature'], obj: { measure_temperature: { value: 28 } } });
  const ac = makeDevice('ac', {
    class: 'airconditioning',
    capabilities: ['onoff', 'target_temperature'],
    obj: { onoff: { value: false }, target_temperature: { value: 20 } },
  });
  const all = (v) => [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, hour: 0, minute: 0, ...v }));
  const homey = mockHomey({
    plans: JSON.stringify([{ id: 'c', name: 'Clim', enabled: true, type: 'cooling', devices: ['ac'], schedule: all({ targetTemperature: 25 }) }]),
    season: 'outdoor',
    ...settings,
  });
  const api = mockApi([sensor, ac]);
  const repository = new PlanRepository(homey);
  repository.init();
  const dm = new DeviceManager(homey, api);
  await dm.init();
  const controller = new Controller({ homey, repository, devices: dm });
  return {
    homey, api, controller, sensor, dm,
  };
}

test('contrôleur : la sonde extérieure fait passer en été puis en mi-saison', async () => {
  const {
    homey, api, controller, sensor, dm,
  } = await setupOutdoor({ outdoor_sensor: 'ext', outdoor_hours: 1 });
  assert.ok(dm.listSensors().some((s) => s.id === 'ext'));
  // novembre : les dates donneraient l'hiver, mais il fait 28 °C dehors
  const t0 = new Date('2026-11-17T10:00:00Z');
  controller.lastSeason = 'heating';
  await controller.runOnce(t0);
  assert.strictEqual(controller.context(t0).season, 'cooling');
  assert.deepStrictEqual(api.writes, [['ac', 'onoff', true], ['ac', 'target_temperature', 25]]);
  assert.strictEqual(homey._store.outdoor_season, 'cooling');
  assert.ok(homey._notifications.some((n) => n.includes('Été')));

  // une heure plus tard il fait 18 °C : mi-saison, la clim s'éteint
  api.writes.length = 0;
  sensor.capabilitiesObj.measure_temperature.value = 18;
  const t1 = new Date(t0.getTime() + HOUR);
  await controller.runOnce(t1);
  assert.strictEqual(controller.context(t1).season, 'off');
  assert.strictEqual(controller.outdoor.status(t1).average, 18);
  assert.strictEqual(controller.outdoor.status(t1).value, 18);
  assert.deepStrictEqual(api.writes, [['ac', 'onoff', false]]);
});

test('contrôleur : sans sonde, le mode extérieur suit les dates', async () => {
  const { controller } = await setupOutdoor({});
  const t = new Date('2026-11-17T10:00:00Z');
  await controller.runOnce(t);
  assert.strictEqual(controller.context(t).season, 'heating');
  assert.strictEqual(controller.state().outdoor.average, null);
});

test('changement de sonde : l’historique repart de zéro', async () => {
  const { homey, controller } = await setupOutdoor({ outdoor_sensor: 'ext' });
  const t = new Date('2026-11-17T10:00:00Z');
  await controller.runOnce(t);
  assert.strictEqual(homey._store.outdoor_history.sensor, 'ext');
  homey.settings.set('outdoor_sensor', 'autre');
  await controller.runOnce(new Date(t.getTime() + 60000));
  assert.strictEqual(controller.outdoor.average(t), null);
  assert.strictEqual(controller.outdoor.history.sensor, 'autre');
});

test('déclencheur : la moyenne extérieure (arrondie à 0,5 °C) a changé', async () => {
  const { controller, sensor } = await setupOutdoor({ outdoor_sensor: 'ext', outdoor_hours: 1 });
  const events = [];
  controller.on('outdoor_average', (v, prev) => events.push([v, prev]));
  const t0 = new Date('2026-11-17T10:00:00Z');
  await controller.runOnce(t0);
  assert.deepStrictEqual(events, []); // première mesure : pas de déclenchement
  sensor.capabilitiesObj.measure_temperature.value = 28.1; // arrondi identique (28)
  await controller.runOnce(new Date(t0.getTime() + HOUR));
  assert.deepStrictEqual(events, []);
  sensor.capabilitiesObj.measure_temperature.value = 18;
  await controller.runOnce(new Date(t0.getTime() + 2 * HOUR));
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0][0], 18);
});
