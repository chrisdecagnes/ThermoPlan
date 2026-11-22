'use strict';

const { EventEmitter } = require('events');
const fr = require('../locales/fr.json');

function translate(key, tokens) {
  let n = fr;
  for (const p of key.split('.')) n = n && n[p];
  let s = typeof n === 'string' ? n : key;
  Object.entries(tokens || {}).forEach(([k, v]) => { s = s.split(`__${k}__`).join(v); });
  return s;
}

function mockHomey(settings = {}) {
  const ee = new EventEmitter();
  const store = { ...settings };
  const notifications = [];
  return {
    manifest: { id: 'fr.cpistre.thermoplan', version: '2.1.0' },
    app: { dryRun: false },
    settings: {
      get: (k) => (k in store ? store[k] : null),
      set: (k, v) => { store[k] = v; ee.emit('set', k); },
      on: (e, fn) => ee.on(e, fn),
    },
    clock: { getTimezone: () => 'Europe/Paris' },
    __: translate,
    notifications: { createNotification: async (n) => { notifications.push(n.excerpt); } },
    setTimeout: () => null,
    setInterval: () => null,
    clearTimeout: () => {},
    clearInterval: () => {},
    _store: store,
    _notifications: notifications,
  };
}

function makeDevice(id, opts) {
  const caps = opts.capabilities;
  const capabilitiesObj = {};
  caps.forEach((c) => { capabilitiesObj[c] = { value: null, ...(opts.obj && opts.obj[c]) }; });
  return {
    id,
    name: opts.name || id,
    class: opts.class || 'thermostat',
    zone: opts.zone || 'z1',
    available: true,
    capabilities: caps,
    capabilitiesObj,
    makeCapabilityInstance: (capId) => ({
      get value() { return capabilitiesObj[capId] ? capabilitiesObj[capId].value : null; },
      destroy() {},
    }),
  };
}

function mockApi(devices, zones = { z1: { id: 'z1', name: 'Salon' } }) {
  const writes = [];
  const map = {};
  devices.forEach((d) => { map[d.id] = d; });
  return {
    writes,
    devices: {
      getDevices: async () => map,
      setCapabilityValue: async ({ deviceId, capabilityId, value }) => { writes.push([deviceId, capabilityId, value]); },
      connect: async () => {},
      on: () => {},
    },
    zones: {
      getZones: async () => zones,
      connect: async () => {},
      on: () => {},
    },
  };
}

module.exports = { mockHomey, mockApi, makeDevice, translate };
