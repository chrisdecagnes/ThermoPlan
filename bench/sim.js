'use strict';

/**
 * Banc d'essai : Homey simulé + vraie classe App de ThermoPlan.
 * Aucun module npm requis : « homey » et « homey-api » sont remplacés ici.
 *
 *   const { startApp } = require('./bench/sim');
 *   const { app, homey, api } = await startApp({ lang: 'fr' });
 */
const path = require('path');
const Module = require('module');
const { EventEmitter } = require('events');

const ROOT = path.resolve(__dirname, '..');
const H = 3600000;

// ------------------------------------------------------------------ appareils simulés
function makeDevice(id, opts) {
  const ee = new EventEmitter();
  const capabilitiesObj = {};
  opts.capabilities.forEach((c) => {
    capabilitiesObj[c] = { id: c, value: null, ...(opts.obj && opts.obj[c]) };
  });
  return {
    id,
    name: opts.name || id,
    class: opts.class || 'thermostat',
    zone: opts.zone || 'salon',
    available: true,
    ready: true,
    capabilities: opts.capabilities,
    capabilitiesObj,
    makeCapabilityInstance(capId, cb) {
      const fn = (v) => cb && cb(v);
      ee.on(capId, fn);
      return {
        get value() { return capabilitiesObj[capId] ? capabilitiesObj[capId].value : null; },
        destroy() { ee.off(capId, fn); },
      };
    },
    _set(capId, value) {
      if (!capabilitiesObj[capId]) return;
      capabilitiesObj[capId].value = value;
      ee.emit(capId, value);
    },
  };
}

function demoDevices() {
  return [
    makeDevice('daikin', {
      name: 'Clim salon (Daikin)',
      class: 'airconditioning',
      zone: 'salon',
      capabilities: ['measure_temperature.outdoorTemperature', 'fan_mode.mode', 'fan_mode.speed',
        'target_temperature', 'measure_temperature', 'onoff', 'thermostat_mode'],
      obj: {
        'measure_temperature.outdoorTemperature': { value: 9.5, title: 'outdoor temperature' },
        'fan_mode.mode': { value: 'auto', values: [{ id: 'auto' }, { id: 'quiet' }, { id: 'manual' }] },
        'fan_mode.speed': { value: '3', values: ['1', '2', '3', '4', '5'].map((x) => ({ id: x })) },
        target_temperature: { value: 22, min: 10, max: 32 }, // jamais une consigne des programmes : écriture garantie quel que soit le jour
        measure_temperature: { value: 20.6 },
        onoff: { value: true },
        thermostat_mode: {
          value: 'heating',
          values: ['fanonly', 'heating', 'cooling', 'auto', 'dry'].map((x) => ({ id: x })),
        },
      },
    }),
    makeDevice('radiateur', {
      name: 'Tête thermostatique chambre',
      class: 'thermostat',
      zone: 'chambre',
      capabilities: ['target_temperature', 'measure_temperature'],
      obj: { target_temperature: { value: 18, min: 5, max: 28 }, measure_temperature: { value: 18.4 } },
    }),
    makeDevice('ventilo', {
      name: 'Ventilateur bureau',
      class: 'fan',
      zone: 'bureau',
      capabilities: ['onoff', 'dim'],
      obj: { onoff: { value: false }, dim: { value: 0 } },
    }),
    makeDevice('sonde-ext', {
      name: 'Sonde extérieure',
      class: 'sensor',
      zone: 'jardin',
      capabilities: ['measure_temperature'],
      obj: { measure_temperature: { value: 8.7 } },
    }),
    makeDevice('sonde-bureau', {
      name: 'Sonde bureau',
      class: 'sensor',
      zone: 'bureau',
      capabilities: ['measure_temperature'],
      obj: { measure_temperature: { value: 21.8 } },
    }),
    makeDevice('fenetre-chambre', {
      name: 'Fenêtre chambre',
      class: 'sensor',
      zone: 'chambre',
      capabilities: ['alarm_contact'],
      obj: { alarm_contact: { value: false } },
    }),
  ];
}

const ZONES = {
  maison: { id: 'maison', name: 'Maison', parent: null },
  salon: { id: 'salon', name: 'Salon', parent: 'maison' },
  chambre: { id: 'chambre', name: 'Chambre', parent: 'maison' },
  bureau: { id: 'bureau', name: 'Bureau', parent: 'maison' },
  jardin: { id: 'jardin', name: 'Jardin', parent: 'maison' },
};

function mockApi(devices) {
  const writes = [];
  const map = {};
  devices.forEach((d) => { map[d.id] = d; });
  const ee = () => {
    const e = new EventEmitter();
    return { connect: async () => {}, on: (n, f) => e.on(n, f), _emit: (n, v) => e.emit(n, v) };
  };
  const dev = ee();
  const zon = ee();
  const usr = ee();
  return {
    writes,
    devices: {
      ...dev,
      getDevices: async () => map,
      getDevice: async ({ id }) => map[id],
      setCapabilityValue: async ({ deviceId, capabilityId, value }) => {
        writes.push([deviceId, capabilityId, value]);
        if (map[deviceId]) map[deviceId]._set(capabilityId, value);
      },
    },
    zones: { ...zon, getZones: async () => ZONES },
    users: {
      ...usr,
      getUsers: async () => ({
        u1: { id: 'u1', name: 'Christophe', present: true, enabled: true },
        u2: { id: 'u2', name: 'Invité', present: false, enabled: true },
      }),
    },
  };
}

// ------------------------------------------------------------------ Homey simulé
function loadLocale(lang) {
  try { return require(path.join(ROOT, 'locales', `${lang}.json`)); } catch (e) { return require(path.join(ROOT, 'locales', 'en.json')); }
}

function translator(lang) {
  const dict = loadLocale(lang);
  const en = loadLocale('en');
  const get = (d, key) => key.split('.').reduce((n, p) => (n ? n[p] : undefined), d);
  return (key, tokens) => {
    let s = get(dict, key);
    if (typeof s !== 'string') s = get(en, key);
    if (typeof s !== 'string') return key;
    Object.entries(tokens || {}).forEach(([k, v]) => { s = s.split(`__${k}__`).join(v); });
    return s;
  };
}

function card() {
  return {
    registerRunListener() { return this; },
    registerArgumentAutocompleteListener() { return this; },
    trigger: async () => {},
  };
}

function mockHomey({ lang = 'fr', settings = {} } = {}) {
  const store = { ...settings };
  const ee = new EventEmitter();
  const realtime = new EventEmitter();
  const manifest = require(path.join(ROOT, 'app.json'));
  const timers = new Set();
  const homey = {
    manifest,
    app: null,
    __: translator(lang),
    i18n: { getLanguage: () => lang },
    settings: {
      get: (k) => (k in store ? store[k] : null),
      set: (k, v) => { store[k] = v; ee.emit('set', k); },
      unset: (k) => { delete store[k]; ee.emit('unset', k); },
      getKeys: () => Object.keys(store),
      on: (e, f) => ee.on(e, f),
    },
    clock: { getTimezone: () => 'Europe/Paris' },
    notifications: { createNotification: async (n) => { homey._notifications.push(n.excerpt); } },
    flow: {
      createToken: async () => ({ setValue: async () => {} }),
      getTriggerCard: card,
      getActionCard: card,
      getConditionCard: card,
      getDeviceTriggerCard: card,
    },
    dashboards: { getWidget: () => ({ registerSettingAutocompleteListener() {} }) },
    api: { realtime: (event, data) => realtime.emit('event', event, data) },
    setTimeout: (f, ms) => { const t = setTimeout(f, ms); timers.add(t); return t; },
    clearTimeout: (t) => clearTimeout(t),
    setInterval: (f, ms) => { const t = setInterval(f, ms); timers.add(t); return t; },
    clearInterval: (t) => clearInterval(t),
    _store: store,
    _realtime: realtime,
    _notifications: [],
    _stop: () => timers.forEach((t) => { clearTimeout(t); clearInterval(t); }),
  };
  return homey;
}

// ------------------------------------------------------------------ remplacement des modules npm
let currentApi = null;
const stubs = {
  homey: {
    App: class App {
      constructor() { /* homey injecté par startApp */ }
      log(...a) { if (process.env.BENCH_LOG) console.log('[app]', ...a); }
      error(...a) { console.error('[app]', ...a); }
    },
    Driver: class Driver {},
    Device: class Device {},
  },
  'homey-api': { HomeyAPI: { createAppAPI: async () => currentApi } },
};
const origLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return origLoad.call(this, request, parent, isMain);
};

// ------------------------------------------------------------------ données de démonstration
function demoPlans() {
  const all = [1, 2, 3, 4, 5];
  const we = [0, 6];
  const every = [0, 1, 2, 3, 4, 5, 6];
  return [
    {
      id: 'p-salon', name: 'Salon', type: 'heating', enabled: true, devices: ['daikin'], zones: [],
      slots: [
        { days: all, start: '06:30', end: '08:30', value: { targetTemperature: 20.5 } },
        { days: all, start: '17:00', end: '22:30', value: { targetTemperature: 21 } },
        { days: we, start: '08:00', end: '23:00', value: { targetTemperature: 21 } },
      ],
      base: { targetTemperature: 18 },
    },
    {
      id: 'p-chambre', name: 'Chambre', type: 'heating', enabled: true, devices: ['radiateur'], zones: [],
      slots: [{ days: every, start: '06:00', end: '07:30', value: { targetTemperature: 19 } }],
      base: { targetTemperature: 17 },
      window: { enabled: true, delay: 60, sensors: [], value: { targetTemperature: 7 } },
    },
    {
      id: 'p-clim', name: 'Clim été', type: 'cooling', enabled: true, devices: ['daikin'], zones: [],
      slots: [{ days: every, start: '13:00', end: '22:00', value: { targetTemperature: 25, fan: 'auto' } }],
      base: { off: true },
    },
    {
      id: 'p-ventilo', name: 'Ventilation bureau', type: 'fan', enabled: false, devices: ['ventilo'], zones: [],
      season: 'always',
      slots: [{ days: all, start: '09:00', end: '18:00', value: { fanSpeed: 0.6 } }],
      base: { fanSpeed: 0 },
      room: { sensor: 'sonde-bureau', mode: 'regulate', hysteresis: 0.5, threshold: 26 },
    },
  ];
}

/** Historique de 24 h simulé (un point toutes les 10 min). */
function demoHistory(now = Date.now()) {
  const points = [];
  const start = Math.floor((now - 24 * H) / 600000) * 600000;
  for (let t = start; t <= now; t += 600000) {
    const d = new Date(t);
    const h = d.getHours() + d.getMinutes() / 60;
    const o = 6 + 4 * Math.sin(((h - 9) / 24) * 2 * Math.PI);
    const sSalon = (h >= 6.5 && h < 8.5) ? 20.5 : (h >= 17 && h < 22.5) ? 21 : 18;
    const sCh = (h >= 6 && h < 7.5) ? 19 : 17;
    const lag = (s, k) => Math.round((s - 0.4 + 0.3 * Math.sin(t / 2.7e6 + k)) * 10) / 10;
    points.push({
      t,
      o: Math.round(o * 10) / 10,
      p: { 'p-salon': [lag(sSalon, 1), sSalon], 'p-chambre': [lag(sCh, 2), sCh], 'p-clim': [lag(20, 3), null] },
    });
  }
  return { points };
}

/**
 * Démarre la vraie application sur le Homey simulé.
 * @param {object} opts { lang, settings, plans, history }
 */
async function startApp(opts = {}) {
  const devices = demoDevices();
  currentApi = mockApi(devices);
  const settings = {
    plans: JSON.stringify(opts.plans || demoPlans()),
    outdoor_sensor: 'sonde-ext',
    day_history: opts.history === false ? undefined : demoHistory(),
    away: { enabled: true, delay: 15, heating: 'eco', ecoTemperature: 16 },
    ...opts.settings,
  };
  Object.keys(settings).forEach((k) => settings[k] === undefined && delete settings[k]);
  const homey = mockHomey({ lang: opts.lang || 'fr', settings });
  const App = require(path.join(ROOT, 'app.js'));
  const app = new App();
  app.homey = homey;
  homey.app = app;
  await app.onInit();
  return {
    app, homey, api: currentApi, devices,
    stop: async () => { await app.onUninit(); homey._stop(); },
  };
}

module.exports = {
  startApp, mockHomey, mockApi, demoDevices, demoPlans, demoHistory, translator, ROOT,
};
