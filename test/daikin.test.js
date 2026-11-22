'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { PlanRepository } = require('../lib/repository');
const { DeviceManager, findModeValue } = require('../lib/devices');
const { Controller } = require('../lib/controller');
const { mockHomey, mockApi, makeDevice } = require('./helpers');

/** Climatiseur Daikin tel qu'exposé par l'app Daikin pour Homey (relevé réel). */
function daikin(id = 'dk', mode = 'auto') {
  return makeDevice(id, {
    name: 'Clim salon',
    class: 'airconditioning',
    capabilities: [
      'measure_temperature.outdoorTemperature', 'swing_mode.horizontal', 'swing_mode.vertical',
      'fan_mode.mode', 'fan_mode.speed', 'fan_mode.powerful', 'meter_power',
      'target_temperature', 'measure_temperature', 'onoff', 'thermostat_mode',
    ],
    obj: {
      'measure_temperature.outdoorTemperature': { value: 10, title: 'outdoor temperature' },
      'fan_mode.mode': { value: 'auto', values: [{ id: 'auto' }, { id: 'quiet' }, { id: 'manual' }] },
      'fan_mode.speed': { value: '1', values: [{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }, { id: '5' }] },
      'fan_mode.powerful': { value: 'off', values: [{ id: 'off' }, { id: 'on' }] },
      target_temperature: { value: 21 },
      measure_temperature: { value: 22 },
      onoff: { value: false },
      thermostat_mode: {
        value: mode,
        values: [{ id: 'fanonly' }, { id: 'heating' }, { id: 'cooling' }, { id: 'auto' }, { id: 'dry' }],
      },
    },
  });
}

const all = (v) => [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, hour: 0, minute: 0, ...v }));

async function setup(plans, settings) {
  const dev = daikin();
  const homey = mockHomey({ plans: JSON.stringify(plans), ...settings });
  const api = mockApi([dev]);
  const repository = new PlanRepository(homey);
  repository.init();
  const dm = new DeviceManager(homey, api);
  await dm.init();
  const controller = new Controller({ homey, repository, devices: dm });
  return {
    dev, homey, api, dm, controller,
  };
}

test('noms de modes selon les fabricants', () => {
  const daikinModes = ['fanonly', 'heating', 'cooling', 'auto', 'dry'];
  assert.strictEqual(findModeValue(daikinModes, 'cool'), 'cooling');
  assert.strictEqual(findModeValue(daikinModes, 'heat'), 'heating');
  assert.strictEqual(findModeValue(daikinModes, 'off'), null);
  assert.strictEqual(findModeValue(['auto', 'heat', 'cool', 'off'], 'cool'), 'cool');
  assert.strictEqual(findModeValue(['Auto', 'Cool'], 'cool'), 'Cool');
});

test('Daikin : reconnu comme climatiseur et passé en froid l’été', async () => {
  const { api, dm, controller } = await setup([
    { id: 'c', name: 'Clim', enabled: true, type: 'cooling', devices: ['dk'], schedule: all({ targetTemperature: 25 }) },
  ], { season: 'cooling' });
  assert.ok(dm.list()[0].ac);
  await controller.tick();
  assert.deepStrictEqual(api.writes, [['dk', 'onoff', true], ['dk', 'thermostat_mode', 'cooling'], ['dk', 'target_temperature', 25]]);
});

test('Daikin : passé en chaud l’hiver par un programme de chauffage, éteint par onoff', async () => {
  const { api, controller } = await setup([
    { id: 'h', name: 'PAC', enabled: true, type: 'heating', devices: ['dk'], schedule: all({ targetTemperature: 20 }) },
    { id: 'c', name: 'Clim', enabled: true, type: 'cooling', devices: ['dk'], schedule: all({ targetTemperature: 25 }) },
  ], { season: 'heating' });
  await controller.tick();
  // la clim (hors saison) demande l'arrêt, le chauffage une consigne : la consigne l'emporte
  assert.deepStrictEqual(api.writes, [['dk', 'onoff', true], ['dk', 'thermostat_mode', 'heating'], ['dk', 'target_temperature', 20]]);
});

test('Daikin : la température extérieure de la clim peut servir de sonde extérieure', async () => {
  const { dm, controller } = await setup([], { season: 'outdoor', outdoor_sensor: 'dk:measure_temperature.outdoorTemperature', outdoor_hours: 1 });
  const sensors = dm.listSensors();
  assert.strictEqual(sensors[0].id, 'dk:measure_temperature.outdoorTemperature'); // proposée en premier
  assert.strictEqual(sensors[0].name, 'Clim salon – outdoor temperature');
  const t = new Date('2026-11-17T10:00:00Z');
  await controller.runOnce(t);
  assert.strictEqual(controller.outdoor.status(t).value, 10);
  assert.strictEqual(controller.context(t).season, 'heating');
});

test('Daikin : ventilation de la clim réglée par plage (auto, silence, niveau)', async () => {
  const { normalizePlan } = require('../lib/repository');
  const plan = normalizePlan({
    id: 'c', name: 'Clim', enabled: true, type: 'cooling', devices: ['dk'], base: { off: true },
    slots: [
      { days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '12:00', value: { targetTemperature: 25, fan: 0.75 } },
      { days: [0, 1, 2, 3, 4, 5, 6], start: '12:00', end: '00:00', value: { targetTemperature: 25, fan: 'quiet' } },
    ],
  });
  assert.strictEqual(plan.schedule.length, 14); // la ventilation change : nouveaux points de consigne
  const { api, dm } = await setup([], {});
  const dev = dm.getDevice('dk');
  assert.strictEqual(dm.list()[0].acFanLevels, 5);
  assert.strictEqual(dm.list()[0].acFanQuiet, true);
  await dm.apply(dev, { kind: 'temperature', value: 25, fan: 0.75 }, 'cooling');
  assert.deepStrictEqual(api.writes.filter((w) => w[1].startsWith('fan')), [['dk', 'fan_mode.mode', 'manual'], ['dk', 'fan_mode.speed', '4']]);
  api.writes.length = 0;
  await dm.apply(dev, { kind: 'temperature', value: 25, fan: 'quiet' }, 'cooling');
  assert.deepStrictEqual(api.writes.filter((w) => w[1].startsWith('fan')), [['dk', 'fan_mode.mode', 'quiet']]);
  api.writes.length = 0;
  await dm.apply(dev, { kind: 'temperature', value: 25, fan: 'auto' }, 'cooling');
  assert.deepStrictEqual(api.writes.filter((w) => w[1].startsWith('fan')), [['dk', 'fan_mode.mode', 'auto']]);
  api.writes.length = 0;
  await dm.apply(dev, { kind: 'temperature', value: 24 }, 'cooling'); // sans réglage : ventilation inchangée
  assert.deepStrictEqual(api.writes.filter((w) => w[1].startsWith('fan')), []);
});
