'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { PlanRepository } = require('../lib/repository');
const { DeviceManager } = require('../lib/devices');
const { Controller } = require('../lib/controller');
const { mockHomey, mockApi, makeDevice } = require('./helpers');

async function setup(plans, devices, settings = {}) {
  const homey = mockHomey({ plans: JSON.stringify(plans), ...settings });
  const api = mockApi(devices);
  const repository = new PlanRepository(homey);
  repository.init();
  const dm = new DeviceManager(homey, api);
  await dm.init();
  const controller = new Controller({ homey, repository, devices: dm });
  return {
    homey, api, repository, dm, controller,
  };
}

const allDays = (hour, minute, v) => [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, hour, minute, ...v }));

test('chauffage appliqué une seule fois tant que la consigne ne change pas', async () => {
  const trv = makeDevice('trv', { capabilities: ['target_temperature', 'measure_temperature'], obj: { target_temperature: { value: 15, min: 5, max: 30, step: 0.5 } } });
  const { api, controller } = await setup([
    { id: 'h', name: 'Chauffage', enabled: true, type: 'heating', zones: ['z1'], schedule: allDays(0, 0, { targetTemperature: 20.3 }) },
  ], [trv], { season: 'heating' });
  await controller.tick();
  assert.deepStrictEqual(api.writes, [['trv', 'target_temperature', 20.5]]);
  await controller.tick();
  assert.strictEqual(api.writes.length, 1);
});

test('climatisation : marche + mode froid + consigne ; arrêt hors saison', async () => {
  const ac = makeDevice('ac', {
    class: 'airconditioning',
    capabilities: ['onoff', 'target_temperature', 'thermostat_mode', 'measure_temperature'],
    obj: { onoff: { value: false }, thermostat_mode: { value: 'heat', values: [{ id: 'auto' }, { id: 'heat' }, { id: 'cool' }, { id: 'off' }] }, target_temperature: { value: 20 } },
  });
  const { api, controller } = await setup([
    { id: 'c', name: 'Clim', enabled: true, type: 'cooling', devices: ['ac'], schedule: allDays(0, 0, { targetTemperature: 25 }) },
  ], [ac], { season: 'cooling' });
  await controller.tick();
  assert.deepStrictEqual(api.writes, [['ac', 'onoff', true], ['ac', 'thermostat_mode', 'cool'], ['ac', 'target_temperature', 25]]);

  api.writes.length = 0;
  await controller.setSeason('heating');
  assert.deepStrictEqual(api.writes, [['ac', 'onoff', false]]);
});

test('ventilateur avec variateur', async () => {
  const fan = makeDevice('fan', { class: 'fan', capabilities: ['onoff', 'dim'], obj: { onoff: { value: false }, dim: { value: 0 } } });
  const { api, controller } = await setup([
    { id: 'f', name: 'Ventilo', enabled: true, type: 'fan', devices: ['fan'], schedule: allDays(0, 0, { fanSpeed: 0.6 }) },
  ], [fan], { season: 'cooling' });
  await controller.tick();
  assert.deepStrictEqual(api.writes, [['fan', 'onoff', true], ['fan', 'dim', 0.6]]);
});

test('un radiateur n’est pas proposé pour la climatisation', async () => {
  const heater = makeDevice('rad', { class: 'heater', capabilities: ['target_temperature'] });
  const { dm } = await setup([], [heater]);
  assert.strictEqual(dm.supports(heater, 'cooling'), false);
  assert.strictEqual(dm.supports(heater, 'heating'), true);
});

test('changement de mode : exception appliquée et notification', async () => {
  const trv = makeDevice('trv', { capabilities: ['target_temperature'], obj: { target_temperature: { value: 15 } } });
  const { api, controller, homey } = await setup([
    { id: 'h', name: 'Chauffage', enabled: true, type: 'heating', devices: ['trv'], schedule: allDays(0, 0, { targetTemperature: 20 }), overrides: { Holiday: { targetTemperature: 14 } } },
  ], [trv], { season: 'heating' });
  await controller.tick();
  await controller.setMode(4);
  assert.deepStrictEqual(api.writes.map((w) => w[2]), [20, 14]);
  assert.ok(homey._notifications.some((n) => n.includes('Vacances')));
});

test('conflit entre deux plans sur le même appareil : la plus haute gagne', async () => {
  const trv = makeDevice('trv', { capabilities: ['target_temperature'], obj: { target_temperature: { value: 15 } } });
  const { api, controller } = await setup([
    { id: 'a', name: 'A', enabled: true, type: 'heating', devices: ['trv'], schedule: allDays(0, 0, { targetTemperature: 18 }) },
    { id: 'b', name: 'B', enabled: true, type: 'heating', zones: ['z1'], schedule: allDays(0, 0, { targetTemperature: 21 }) },
  ], [trv], { season: 'heating' });
  await controller.tick();
  assert.deepStrictEqual(api.writes, [['trv', 'target_temperature', 21]]);
});

test('état pour l’interface', async () => {
  const trv = makeDevice('trv', { capabilities: ['target_temperature', 'measure_temperature'], obj: { measure_temperature: { value: 19.4 } } });
  const { controller } = await setup([
    { id: 'h', name: 'Chauffage', enabled: true, type: 'heating', devices: ['trv'], schedule: allDays(6, 0, { targetTemperature: 20 }) },
  ], [trv], { season: 'heating' });
  const s = controller.state();
  assert.strictEqual(s.plans[0].temperature, 19.4);
  assert.ok(s.nextChange);
  assert.strictEqual(s.devices.length, 1);
  assert.strictEqual(s.outdoor.sensorId, null);
});

test('bouton Tester : applique la valeur immédiatement, sans changer le programme', async () => {
  const fan = makeDevice('fan', { class: 'fan', capabilities: ['onoff', 'dim'], obj: { onoff: { value: false }, dim: { value: 0 } } });
  const { api, controller, repository } = await setup([
    { id: 'f', name: 'Ventilo', enabled: false, type: 'fan', devices: ['fan'], schedule: allDays(0, 0, { fanSpeed: 0 }) },
  ], [fan], { season: 'heating' });
  const r = await controller.testPlan(repository.find('f'), { fanSpeed: 0.8 });
  assert.deepStrictEqual(api.writes, [['fan', 'onoff', true], ['fan', 'dim', 0.8]]);
  assert.deepStrictEqual(r.devices, [{ id: 'fan', name: 'fan', ok: true }]);
  await assert.rejects(controller.testPlan(repository.find('f'), null));
});

test('fenêtre ouverte : coupe après le délai, reprend à la fermeture', async () => {
  const trv = makeDevice('trv', { capabilities: ['target_temperature'], obj: { target_temperature: { value: 15 } } });
  const ac = makeDevice('ac', { class: 'airconditioning', capabilities: ['onoff', 'target_temperature'], zone: 'z2', obj: { onoff: { value: false }, target_temperature: { value: 20 } } });
  const win = makeDevice('win', { class: 'sensor', capabilities: ['alarm_contact'], obj: { alarm_contact: { value: false } } });
  const { api, controller, homey, dm } = await setup([
    { id: 'h', name: 'Salon', enabled: true, type: 'heating', zones: ['z1'], schedule: allDays(0, 0, { targetTemperature: 20 }), window: { enabled: true, delay: 30 } },
  ], [trv, ac, win], { season: 'heating' });
  assert.deepStrictEqual(dm.listContacts().map((c) => c.id), ['win']);
  const t0 = Date.parse('2026-11-17T10:00:00Z');
  await controller.runOnce(new Date(t0));
  assert.deepStrictEqual(api.writes, [['trv', 'target_temperature', 20]]);

  win.capabilitiesObj.alarm_contact.value = true; // ouverture
  await controller.runOnce(new Date(t0 + 1000));
  await controller.runOnce(new Date(t0 + 30000)); // 29 s : rien
  assert.strictEqual(api.writes.length, 1);
  await controller.runOnce(new Date(t0 + 31000)); // 30 s : hors-gel
  assert.deepStrictEqual(api.writes[1], ['trv', 'target_temperature', 7]);
  assert.ok(homey._notifications.some((n) => n.includes('Fenêtre ouverte')));
  assert.deepStrictEqual(controller.planStatus(controller.repo.find('h')).windowStopped, ['trv']);

  win.capabilitiesObj.alarm_contact.value = false; // fermeture
  await controller.runOnce(new Date(t0 + 60000));
  assert.deepStrictEqual(api.writes[2], ['trv', 'target_temperature', 20]);
  assert.ok(homey._notifications.some((n) => n.includes('Fenêtre fermée')));
});

test('fenêtre : capteur choisi, clim arrêtée, fenêtre refermée avant le délai = rien', async () => {
  const ac = makeDevice('ac', { class: 'airconditioning', capabilities: ['onoff', 'target_temperature'], zone: 'z2', obj: { onoff: { value: false }, target_temperature: { value: 20 } } });
  const win = makeDevice('win', { class: 'sensor', capabilities: ['alarm_contact'], obj: { alarm_contact: { value: false } } });
  const { api, controller } = await setup([
    { id: 'c', name: 'Clim', enabled: true, type: 'cooling', devices: ['ac'], schedule: allDays(0, 0, { targetTemperature: 25 }), window: { enabled: true, delay: 10, sensors: ['win'] } },
  ], [ac, win], { season: 'cooling' });
  const t0 = Date.parse('2026-07-01T10:00:00Z');
  await controller.runOnce(new Date(t0));
  api.writes.length = 0;
  win.capabilitiesObj.alarm_contact.value = true;
  await controller.runOnce(new Date(t0 + 1000));
  win.capabilitiesObj.alarm_contact.value = false;
  await controller.runOnce(new Date(t0 + 5000));
  await controller.runOnce(new Date(t0 + 20000));
  assert.deepStrictEqual(api.writes, []);
  win.capabilitiesObj.alarm_contact.value = true;
  await controller.runOnce(new Date(t0 + 21000));
  await controller.runOnce(new Date(t0 + 31000));
  assert.deepStrictEqual(api.writes, [['ac', 'onoff', false]]);
});

test('sonde de la pièce : régulation chauffage avec marge, affichage de la température', async () => {
  const rad = makeDevice('rad', { class: 'heater', capabilities: ['onoff', 'target_temperature'], obj: { onoff: { value: true }, target_temperature: { value: 15 } } });
  const trv = makeDevice('trv', { capabilities: ['target_temperature', 'measure_temperature'], obj: { target_temperature: { value: 15 }, measure_temperature: { value: 24 } } });
  const room = makeDevice('room', { class: 'sensor', capabilities: ['measure_temperature'], obj: { measure_temperature: { value: 18 } } });
  const { api, controller, repository } = await setup([
    { id: 'h', name: 'Salon', enabled: true, type: 'heating', devices: ['rad', 'trv'], schedule: allDays(0, 0, { targetTemperature: 20 }), room: { sensor: 'room', mode: 'regulate', hysteresis: 0.5 } },
  ], [rad, trv, room], { season: 'heating' });
  await controller.tick(); // 18° < 19,5° : chauffe
  assert.deepStrictEqual(api.writes.sort(), [['rad', 'target_temperature', 20], ['trv', 'target_temperature', 20]].sort());
  api.writes.length = 0;
  room.capabilitiesObj.measure_temperature.value = 20.2; // dans la marge : on continue
  await controller.tick();
  assert.deepStrictEqual(api.writes, []);
  room.capabilitiesObj.measure_temperature.value = 20.5; // consigne + marge : attente
  await controller.tick();
  assert.deepStrictEqual(api.writes.sort(), [['rad', 'onoff', false], ['trv', 'target_temperature', 7]].sort());
  const st = controller.planStatus(repository.find('h'));
  assert.strictEqual(st.temperature, 20.5); // la sonde remplace la moyenne des appareils
  assert.strictEqual(st.room.regulation, 'idle');
  api.writes.length = 0;
  room.capabilitiesObj.measure_temperature.value = 19.6; // au-dessus de 19,5 : toujours en attente
  await controller.tick();
  assert.deepStrictEqual(api.writes, []);
  room.capabilitiesObj.measure_temperature.value = 19.4; // sous consigne − marge : relance
  await controller.tick();
  assert.deepStrictEqual(api.writes.sort(), [['rad', 'onoff', true], ['trv', 'target_temperature', 20]].sort());
});

test('sonde de la pièce : clim régulée, mode affichage sans effet sur les appareils', async () => {
  const { nextState, normalizeRoom } = require('../lib/room');
  assert.strictEqual(nextState('cooling', 26.6, 26, 0.5, null), 'on');
  assert.strictEqual(nextState('cooling', 25.4, 26, 0.5, 'on'), 'idle');
  assert.strictEqual(nextState('cooling', 26.2, 26, 0.5, 'idle'), 'idle');
  assert.strictEqual(normalizeRoom({ sensor: 's', mode: 'regulate' }, 'fan').mode, 'regulate');
  assert.strictEqual(normalizeRoom({ sensor: 's', mode: 'regulate' }, 'fan').threshold, 26);
  assert.strictEqual(normalizeRoom({ sensor: 's', threshold: 99 }, 'fan').threshold, 40);
  assert.strictEqual(normalizeRoom({ sensor: 's', threshold: 27 }, 'heating').threshold, undefined);
  assert.strictEqual(normalizeRoom({ sensor: 's', hysteresis: 9 }, 'heating').hysteresis, 3);
  const trv = makeDevice('trv', { capabilities: ['target_temperature'], obj: { target_temperature: { value: 15 } } });
  const room = makeDevice('room', { class: 'sensor', capabilities: ['measure_temperature'], obj: { measure_temperature: { value: 25 } } });
  const { api, controller } = await setup([
    { id: 'h', name: 'Salon', enabled: true, type: 'heating', devices: ['trv'], schedule: allDays(0, 0, { targetTemperature: 20 }), room: { sensor: 'room' } },
  ], [trv, room], { season: 'heating' });
  await controller.tick();
  assert.deepStrictEqual(api.writes, [['trv', 'target_temperature', 20]]);
});

test('ventilateur à niveaux (bas / moyen / haut / auto) : niveau, auto, silence par repli', async () => {
  const fan = makeDevice('fan', {
    class: 'fan',
    capabilities: ['onoff', 'fan_speed'],
    obj: { onoff: { value: false }, fan_speed: { value: 'low', values: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }, { id: 'auto' }] } },
  });
  const { api, dm } = await setup([], [fan]);
  assert.strictEqual(dm.list()[0].acFanLevels, 3);
  assert.strictEqual(dm.list()[0].acFanAuto, true);
  const dev = dm.getDevice('fan');
  await dm.apply(dev, { kind: 'fan', speed: 0.67 }, 'fan');
  assert.deepStrictEqual(api.writes, [['fan', 'onoff', true], ['fan', 'fan_speed', 'medium']]);
  api.writes.length = 0;
  await dm.apply(dev, { kind: 'fan', speed: 1, mode: 'auto' }, 'fan');
  assert.deepStrictEqual(api.writes, [['fan', 'fan_speed', 'auto']]);
  api.writes.length = 0;
  await dm.apply(dev, { kind: 'fan', speed: 1, mode: 'quiet' }, 'fan'); // pas de « silence » : vitesse basse
  assert.deepStrictEqual(api.writes, [['fan', 'fan_speed', 'low']]);
  api.writes.length = 0;
  await dm.apply(dev, { kind: 'fan', speed: 0 }, 'fan');
  assert.deepStrictEqual(api.writes, [['fan', 'onoff', false]]);
  const { normalizePlan } = require('../lib/repository');
  const calc = require('../lib/calculator');
  const p = normalizePlan({ name: 'v', type: 'fan', enabled: true, base: { fanSpeed: 0 }, slots: [{ days: [1], start: '10:00', end: '12:00', value: { fanSpeed: 0, fan: 'auto' } }] });
  assert.deepStrictEqual(calc.evaluatePlan(p, { mode: 0, season: 'cooling', local: { day: 1, hour: 11, minute: 0 } }).action, { kind: 'fan', speed: 1, mode: 'auto' });
});

test('personne à la maison : pause après le délai, reprise au retour, forçage par Flow', async () => {
  const { PresenceWatcher } = require('../lib/presence');
  const trv = makeDevice('trv', { capabilities: ['target_temperature'], obj: { target_temperature: { value: 15 } } });
  const ac = makeDevice('ac', { class: 'airconditioning', capabilities: ['onoff', 'target_temperature'], obj: { onoff: { value: false }, target_temperature: { value: 20 } } });
  const users = { u1: { id: 'u1', name: 'Christophe', present: true }, u2: { id: 'u2', name: 'Anne', present: true } };
  const homey = mockHomey({
    plans: JSON.stringify([
      { id: 'h', name: 'Salon', enabled: true, type: 'heating', devices: ['trv'], schedule: allDays(0, 0, { targetTemperature: 20 }) },
      { id: 'c', name: 'Clim', enabled: true, type: 'cooling', devices: ['ac'], schedule: allDays(0, 0, { targetTemperature: 25 }), season: 'always' },
    ]),
    season: 'heating',
    away: { enabled: true, delay: 15, heating: 'off' },
  });
  const api = mockApi([trv, ac]);
  api.users = { getUsers: async () => users, connect: async () => {}, on: () => {} };
  const repository = new PlanRepository(homey); repository.init();
  const dm = new DeviceManager(homey, api); await dm.init();
  const presence = new PresenceWatcher({ homey, api });
  await presence.init();
  const controller = new Controller({ homey, repository, devices: dm, presence });
  presence.removeAllListeners('users'); // pas de passage automatique : le test pilote l'horloge
  const t0 = Date.parse('2026-11-17T10:00:00Z');
  await controller.runOnce(new Date(t0));
  assert.deepStrictEqual(api.writes.sort(), [['ac', 'onoff', true], ['ac', 'target_temperature', 25], ['trv', 'target_temperature', 20]].sort());
  api.writes.length = 0;

  users.u1.present = false; users.u2.present = false; await presence.refresh();
  await controller.runOnce(new Date(t0 + 60000)); // début de l'absence
  await controller.runOnce(new Date(t0 + 15 * 60000)); // 14 min : rien
  assert.deepStrictEqual(api.writes, []);
  await controller.runOnce(new Date(t0 + 16 * 60000)); // 15 min : pause
  assert.deepStrictEqual(api.writes.sort(), [['ac', 'onoff', false], ['trv', 'target_temperature', 7]].sort());
  assert.ok(homey._notifications.some((n) => n.includes('Personne')));
  assert.strictEqual(controller.planStatus(repository.find('h')).source, 'away');
  api.writes.length = 0;

  users.u2.present = true; await presence.refresh(); // retour
  await controller.runOnce(new Date(t0 + 20 * 60000));
  assert.deepStrictEqual(api.writes.sort(), [['ac', 'onoff', true], ['trv', 'target_temperature', 20]].sort());
  api.writes.length = 0;

  await controller.setAwayOverride('away'); // forçage par Flow, sans délai
  await controller.runOnce(new Date(t0 + 21 * 60000));
  assert.deepStrictEqual(api.writes.sort(), [['ac', 'onoff', false], ['trv', 'target_temperature', 7]].sort());
  homey.settings.set('away', { enabled: true, delay: 15, heating: 'eco', ecoTemperature: 16 });
  api.writes.length = 0;
  await controller.runOnce(new Date(t0 + 22 * 60000));
  assert.deepStrictEqual(api.writes, [['trv', 'target_temperature', 16]]);
});

test('fenêtre, portée « programme » : un capteur de la zone sélectionnée coupe tout le programme', async () => {
  const trv1 = makeDevice('trv1', { capabilities: ['target_temperature'], zone: 'z1', obj: { target_temperature: { value: 15 } } });
  const trv2 = makeDevice('trv2', { capabilities: ['target_temperature'], zone: 'z2', obj: { target_temperature: { value: 15 } } });
  const door = makeDevice('door', { class: 'sensor', capabilities: ['alarm_contact'], zone: 'z2', obj: { alarm_contact: { value: false } } });
  const { api, controller } = await setup([
    { id: 'h', name: 'Étage', enabled: true, type: 'heating', zones: ['z1', 'z2'], schedule: allDays(0, 0, { targetTemperature: 20 }), window: { enabled: true, delay: 0, scope: 'plan' } },
  ], [trv1, trv2, door], { season: 'heating' });
  const t0 = Date.parse('2026-11-17T10:00:00Z');
  await controller.runOnce(new Date(t0));
  api.writes.length = 0;
  door.capabilitiesObj.alarm_contact.value = true;
  await controller.runOnce(new Date(t0 + 1000));
  assert.deepStrictEqual(api.writes.sort(), [['trv1', 'target_temperature', 7], ['trv2', 'target_temperature', 7]]);
  const { normalizeWindow } = require('../lib/windows');
  assert.strictEqual(normalizeWindow({ enabled: true }, 'heating').scope, 'plan');
  assert.strictEqual(normalizeWindow({ enabled: true, scope: 'device' }, 'heating').scope, 'device');
});

test('ventilation selon la température de la pièce : seuil et marge', async () => {
  const fan = makeDevice('fan', { class: 'fan', capabilities: ['onoff', 'dim'], obj: { onoff: { value: false }, dim: { value: 0 } } });
  const room = makeDevice('room', { class: 'sensor', capabilities: ['measure_temperature'], obj: { measure_temperature: { value: 24 } } });
  const { api, controller, repository } = await setup([
    { id: 'f', name: 'Ventilo', enabled: true, type: 'fan', devices: ['fan'], schedule: allDays(0, 0, { fanSpeed: 0.6 }), room: { sensor: 'room', mode: 'regulate', threshold: 26, hysteresis: 0.5 } },
  ], [fan, room], { season: 'cooling' });
  await controller.tick(); // 24° : sous le seuil, rien ne tourne
  assert.deepStrictEqual(api.writes, []);
  assert.strictEqual(controller.planStatus(repository.find('f')).room.regulation, 'idle');
  room.capabilitiesObj.measure_temperature.value = 26.3; // dans la marge : on reste à l'arrêt
  await controller.tick();
  assert.deepStrictEqual(api.writes, []);
  room.capabilitiesObj.measure_temperature.value = 26.5; // seuil + marge : ventile
  await controller.tick();
  assert.deepStrictEqual(api.writes, [['fan', 'onoff', true], ['fan', 'dim', 0.6]]);
  api.writes.length = 0;
  room.capabilitiesObj.measure_temperature.value = 25.8; // dans la marge : continue
  await controller.tick();
  assert.deepStrictEqual(api.writes, []);
  room.capabilitiesObj.measure_temperature.value = 25.5; // seuil − marge : arrêt
  await controller.tick();
  assert.deepStrictEqual(api.writes, [['fan', 'onoff', false]]);
});

test('ventilation régulée : une plage à l’arrêt reste à l’arrêt', async () => {
  const fan = makeDevice('fan', { class: 'fan', capabilities: ['onoff', 'dim'], obj: { onoff: { value: true }, dim: { value: 0.5 } } });
  const room = makeDevice('room', { class: 'sensor', capabilities: ['measure_temperature'], obj: { measure_temperature: { value: 30 } } });
  const { api, controller, repository } = await setup([
    { id: 'f', name: 'Ventilo', enabled: true, type: 'fan', devices: ['fan'], schedule: allDays(0, 0, { fanSpeed: 0 }), room: { sensor: 'room', mode: 'regulate', threshold: 26 } },
  ], [fan, room], { season: 'cooling' });
  await controller.tick();
  assert.deepStrictEqual(api.writes, [['fan', 'onoff', false]]);
  assert.strictEqual(controller.planStatus(repository.find('f')).room.regulation, null);
});

test('historique 24 h : mesure et consigne enregistrées par le contrôleur', async () => {
  const trv = makeDevice('trv', {
    capabilities: ['target_temperature', 'measure_temperature'],
    obj: { target_temperature: { value: 15, min: 5, max: 30, step: 0.5 }, measure_temperature: { value: 18.7 } },
  });
  const { controller, homey } = await setup([
    { id: 'h', name: 'Chauffage', enabled: true, type: 'heating', zones: ['z1'], schedule: allDays(0, 0, { targetTemperature: 20 }) },
  ], [trv], { season: 'heating' });
  await controller.tick();
  const h = controller.dayHistory();
  assert.strictEqual(h.points.length, 1);
  assert.deepStrictEqual(h.points[0].p.h, [18.7, 20]);
  assert.ok(homey._store.day_history);
  await controller.tick(); // moins de 10 min : pas de nouveau point
  assert.strictEqual(controller.dayHistory('h').points.length, 1);
});
