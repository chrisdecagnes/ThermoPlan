'use strict';

const { EventEmitter } = require('events');
const { ActionKind, PlanType } = require('./model');

const CAP = Object.freeze({
  Target: 'target_temperature',
  Measure: 'measure_temperature',
  Contact: 'alarm_contact',
  OnOff: 'onoff',
  Dim: 'dim',
  ThermostatMode: 'thermostat_mode',
});

const AC_CLASSES = ['airconditioning', 'heatpump'];

// valeurs de ventilation selon les marques
const FAN_AUTO = /auto/i;
const FAN_QUIET = /quiet|silen|night|nuit|sleep|calme|low_noise/i;
const FAN_MANUAL = /manual|fixed|fixe|manuel|level|speed|normal/i;

/**
 * Noms possibles des modes de `thermostat_mode` selon les fabricants
 * (Homey standard : heat/cool/auto/off ; Daikin : heating/cooling/auto/fanonly/dry...).
 */
const MODE_ALIASES = Object.freeze({
  cool: ['cool', 'cooling', 'cold', 'froid', 'refroidissement'],
  heat: ['heat', 'heating', 'hot', 'chaud', 'chauffage'],
  off: ['off', 'stop', 'arret', 'arrêt'],
});

/** Valeur réelle d'un mode pour un appareil (insensible à la casse), ou null. */
function findModeValue(values, wanted) {
  const aliases = MODE_ALIASES[wanted] || [wanted];
  for (const alias of aliases) {
    const hit = values.find((v) => String(v).toLowerCase() === alias);
    if (hit != null) return hit;
  }
  return null;
}
const FAN_CLASSES = ['fan'];

function hasCap(device, cap) {
  return Array.isArray(device.capabilities) && device.capabilities.includes(cap);
}

function deviceClass(device) {
  return device.virtualClass || device.class;
}

/** Classification d'un appareil Homey pour l'interface et le pilotage. */
function describe(device) {
  const cls = deviceClass(device);
  const thermostat = hasCap(device, CAP.Target);
  const ac = thermostat && (AC_CLASSES.includes(cls) || hasCap(device, CAP.ThermostatMode));
  const fanSpeedCap = (device.capabilities || []).find((c) => c === CAP.Dim || c.startsWith('fan_speed'));
  const fan = FAN_CLASSES.includes(cls) && (hasCap(device, CAP.OnOff) || !!fanSpeedCap);
  return {
    thermostat, ac, fan, fanSpeedCap: fanSpeedCap || null, cls,
  };
}

function isOwnDevice(device, appId) {
  const s = `${device.driverId || ''} ${device.driverUri || ''} ${device.ownerUri || ''}`;
  return s.includes(appId);
}

/**
 * Gestion des appareils Homey via l'API Web (homey-api, permission homey:manager:api).
 * Événement « measure » : (deviceId, valeur) quand une température mesurée change.
 *
 * - `devices` : appareils pilotables (thermostats, climatiseurs, ventilateurs) ;
 * - `sensors` : tous les appareils qui mesurent une température (choix de la
 *   sonde extérieure pour la saison automatique).
 */
class DeviceManager extends EventEmitter {

  constructor(homey, api, log) {
    super();
    this.homey = homey;
    this.api = api;
    this.log = log || (() => {});
    this.devices = {};
    this.contacts = {}; // capteurs d'ouverture : id -> { id, name, zone, device }
    this.contactInst = {};
    this.roomInst = {}; // sondes de pièce suivies : clé -> instance
    this.offByUs = new Set(); // appareils éteints par ThermoPlan (fenêtre, attente, arrêt programmé)
    this.sensors = {}; // clé -> { device, cap } (clé = id de l'appareil, ou id:sous-capacité)
    this.zones = {};
    this.instances = {};
    this.sensorWatch = null; // { key, inst } : sonde extérieure suivie
    this.appId = homey.manifest ? homey.manifest.id : '';
  }

  async init() {
    await this.refresh();
    try {
      await this.api.devices.connect();
      this.api.devices.on('device.create', () => this.refreshSoon());
      this.api.devices.on('device.update', () => this.refreshSoon());
      this.api.devices.on('device.delete', () => this.refreshSoon());
      await this.api.zones.connect();
      this.api.zones.on('zone.create', () => this.refreshSoon());
      this.api.zones.on('zone.update', () => this.refreshSoon());
      this.api.zones.on('zone.delete', () => this.refreshSoon());
    } catch (e) {
      this.log('Abonnement aux événements impossible', e.message);
    }
    // filet de sécurité : rafraîchissement complet toutes les heures
    this.homey.setInterval(() => this.refresh().catch((e) => this.log('refresh', e.message)), 60 * 60 * 1000);
  }

  refreshSoon() {
    if (this.refreshTimer) return;
    this.refreshTimer = this.homey.setTimeout(() => {
      this.refreshTimer = null;
      this.refresh().catch((e) => this.log('refresh', e.message));
    }, 5000);
  }

  async refresh() {
    const all = await this.api.devices.getDevices();
    const next = {};
    const sensors = {};
    const contacts = {};
    for (const d of Object.values(all || {})) {
      if (isOwnDevice(d, this.appId)) continue;
      if (hasCap(d, CAP.Contact)) {
        contacts[d.id] = {
          id: d.id, name: d.name, zone: d.zone, device: d,
        };
      }
      for (const cap of d.capabilities || []) {
        // measure_temperature et ses sous-capacités (ex. measure_temperature.outdoorTemperature des clims Daikin)
        if (cap === CAP.Measure) sensors[d.id] = { device: d, cap };
        else if (cap.startsWith(`${CAP.Measure}.`)) sensors[`${d.id}:${cap}`] = { device: d, cap };
      }
      const info = describe(d);
      if (!info.thermostat && !info.fan) continue;
      next[d.id] = d;
    }

    // détacher les écouteurs des appareils disparus
    for (const id of Object.keys(this.instances)) {
      if (!next[id]) this.detach(id);
    }
    this.devices = next;
    this.sensors = sensors;
    for (const id of Object.keys(this.contactInst)) {
      if (!contacts[id]) this.detachContact(id);
    }
    this.contacts = contacts;
    for (const c of Object.values(contacts)) this.attachContact(c.device);
    for (const d of Object.values(next)) this.attach(d);
    if (this.sensorWatch && !sensors[this.sensorWatch.key]) this.unwatch();
    for (const key of Object.keys(this.roomInst)) {
      if (!sensors[key]) this.unwatchRoom(key);
    }

    this.zones = (await this.api.zones.getZones()) || {};
    this.log(`${Object.keys(this.devices).length} appareils pilotables, ${Object.keys(this.sensors).length} sondes, ${Object.keys(this.zones).length} zones`);
  }

  attach(device) {
    if (this.instances[device.id] || !hasCap(device, CAP.Measure)) return;
    try {
      this.instances[device.id] = device.makeCapabilityInstance(CAP.Measure, (value) => {
        this.emit('measure', device.id, value);
      });
    } catch (e) {
      this.log(`Écoute impossible sur ${device.name}`, e.message);
    }
  }

  attachContact(device) {
    if (this.contactInst[device.id]) return;
    try {
      this.contactInst[device.id] = device.makeCapabilityInstance(CAP.Contact, (value) => {
        this.emit('contact', device.id, value);
      });
    } catch (e) {
      this.log(`Écoute impossible sur ${device.name}`, e.message);
    }
  }

  detachContact(id) {
    const inst = this.contactInst[id];
    if (inst && typeof inst.destroy === 'function') {
      try { inst.destroy(); } catch (e) { /* ignoré */ }
    }
    delete this.contactInst[id];
  }

  /** État d'un capteur d'ouverture : true = ouvert. */
  contactValue(id) {
    const c = this.contacts[id];
    if (!c) return null;
    const inst = this.contactInst[id];
    if (inst && inst.value != null) return inst.value === true;
    const o = c.device.capabilitiesObj && c.device.capabilitiesObj[CAP.Contact];
    return o ? o.value === true : null;
  }

  /** Capteurs d'ouverture, pour l'interface. */
  listContacts() {
    return Object.values(this.contacts).map((c) => ({
      id: c.id,
      name: c.name,
      zone: c.zone,
      zoneName: this.zones[c.zone] ? this.zones[c.zone].name : '',
      open: this.contactValue(c.id),
    })).sort((a, b) => a.zoneName.localeCompare(b.zoneName) || a.name.localeCompare(b.name));
  }

  detach(id) {
    const inst = this.instances[id];
    if (inst && typeof inst.destroy === 'function') {
      try { inst.destroy(); } catch (e) { /* ignoré */ }
    }
    delete this.instances[id];
  }

  getDevice(id) {
    return this.devices[id];
  }

  sensorName(key) {
    const s = this.sensors[key];
    if (!s) return null;
    if (s.cap === CAP.Measure) return s.device.name;
    const c = s.device.capabilitiesObj && s.device.capabilitiesObj[s.cap];
    return `${s.device.name} – ${(c && c.title) || s.cap.slice(CAP.Measure.length + 1)}`;
  }

  getSensor(key) {
    return this.sensors[key] ? { id: key, name: this.sensorName(key) } : null;
  }

  unwatch() {
    if (this.sensorWatch && this.sensorWatch.inst && typeof this.sensorWatch.inst.destroy === 'function') {
      try { this.sensorWatch.inst.destroy(); } catch (e) { /* ignoré */ }
    }
    this.sensorWatch = null;
  }

  /** Suit en temps réel la sonde extérieure (une seule à la fois). */
  watch(key) {
    if (this.sensorWatch && this.sensorWatch.key === key) return;
    this.unwatch();
    const s = this.sensors[key];
    if (!s) return;
    let inst = null;
    try {
      inst = s.device.makeCapabilityInstance(s.cap, () => {});
    } catch (e) {
      this.log(`Écoute impossible sur ${this.sensorName(key)}`, e.message);
    }
    this.sensorWatch = { key, inst };
  }

  /** Température d'une sonde de pièce (suivie en temps réel, plusieurs à la fois). */
  readSensor(key) {
    const s = this.sensors[key];
    if (!s || s.device.available === false) return null;
    if (!this.roomInst[key]) {
      try {
        this.roomInst[key] = s.device.makeCapabilityInstance(s.cap, (value) => this.emit('room', key, value));
      } catch (e) {
        this.roomInst[key] = { value: null, destroy() {} };
        this.log(`Écoute impossible sur ${this.sensorName(key)}`, e.message);
      }
    }
    const inst = this.roomInst[key];
    let v = inst && inst.value != null ? inst.value : null;
    if (v == null) {
      const c = s.device.capabilitiesObj && s.device.capabilitiesObj[s.cap];
      v = c ? c.value : null;
    }
    return typeof v === 'number' ? v : null;
  }

  unwatchRoom(key) {
    const inst = this.roomInst[key];
    if (inst && typeof inst.destroy === 'function') {
      try { inst.destroy(); } catch (e) { /* ignoré */ }
    }
    delete this.roomInst[key];
  }

  /** Température mesurée par une sonde (null si inconnue ou indisponible). */
  sensorValue(key) {
    const s = this.sensors[key];
    if (!s || s.device.available === false) return null;
    this.watch(key);
    const inst = this.sensorWatch && this.sensorWatch.inst;
    let v = inst && inst.value != null ? inst.value : null;
    if (v == null) {
      const c = s.device.capabilitiesObj && s.device.capabilitiesObj[s.cap];
      v = c ? c.value : null;
    }
    return typeof v === 'number' ? v : null;
  }

  /** Appareils d'un plan (appareils explicites + appareils de ses zones), filtrés par type. */
  expandPlan(plan) {
    const ids = new Set(plan.devices || []);
    const zones = new Set(plan.zones || []);
    const out = [];
    for (const d of Object.values(this.devices)) {
      if (!ids.has(d.id) && !zones.has(d.zone)) continue;
      if (!this.supports(d, plan.type)) continue;
      out.push(d);
    }
    return out;
  }

  supports(device, type) {
    const info = describe(device);
    if (type === PlanType.Fan) return info.fan;
    if (type === PlanType.Cooling) return info.ac || (info.thermostat && deviceClass(device) !== 'heater');
    return info.thermostat;
  }

  value(device, cap) {
    const c = device.capabilitiesObj && device.capabilitiesObj[cap];
    if (cap === CAP.Measure && this.instances[device.id] && this.instances[device.id].value != null) {
      return this.instances[device.id].value;
    }
    return c ? c.value : null;
  }

  measured(device) {
    const v = this.value(device, CAP.Measure);
    return typeof v === 'number' ? v : null;
  }

  async setCap(device, capabilityId, value) {
    const current = this.value(device, capabilityId);
    if (current === value) return false;
    if (this.homey.app.dryRun) {
      this.log(`[simulation] ${device.name}.${capabilityId} = ${value}`);
      return true;
    }
    await this.api.devices.setCapabilityValue({ deviceId: device.id, capabilityId, value });
    if (device.capabilitiesObj && device.capabilitiesObj[capabilityId]) {
      device.capabilitiesObj[capabilityId].value = value;
    }
    return true;
  }

  adjustTemperature(device, target) {
    const c = device.capabilitiesObj && device.capabilitiesObj[CAP.Target];
    let t = target;
    if (c) {
      if (typeof c.max === 'number' && t > c.max) t = c.max;
      if (typeof c.min === 'number' && t < c.min) t = c.min;
      if (typeof c.step === 'number' && c.step > 0) t = Math.round(t / c.step) * c.step;
      t = Math.round(t * 100) / 100;
    }
    return t;
  }

  modeValues(device) {
    const c = device.capabilitiesObj && device.capabilitiesObj[CAP.ThermostatMode];
    return c && Array.isArray(c.values) ? c.values.map((v) => v.id) : [];
  }

  /**
   * Applique une action à un appareil.
   * @param {object} device appareil homey-api
   * @param {object} action { kind, value | speed }
   * @param {string} planType type du plan qui a produit l'action
   * @returns {Promise<{changed:boolean, value?:any}>}
   */
  async apply(device, action, planType) {
    if (!device.available && device.available !== undefined) {
      throw new Error('appareil indisponible');
    }
    const info = describe(device);
    let changed = false;

    if (action.kind === ActionKind.Temperature) {
      const isAc = info.ac;
      // rallumer les climatiseurs, et tout appareil que ThermoPlan a lui-même éteint
      if ((isAc || this.offByUs.has(device.id)) && hasCap(device, CAP.OnOff)) changed = (await this.setCap(device, CAP.OnOff, true)) || changed;
      this.offByUs.delete(device.id);
      if (hasCap(device, CAP.ThermostatMode)) {
        const values = this.modeValues(device);
        const wanted = findModeValue(values, planType === PlanType.Cooling ? 'cool' : 'heat');
        const offValue = findModeValue(values, 'off');
        const current = this.value(device, CAP.ThermostatMode);
        // On ne force le mode que sur les climatiseurs/PAC, ou si l'appareil était éteint via ce mode
        if (wanted != null && (isAc || (offValue != null && current === offValue))) {
          changed = (await this.setCap(device, CAP.ThermostatMode, wanted)) || changed;
        }
      }
      const t = this.adjustTemperature(device, action.value);
      changed = (await this.setCap(device, CAP.Target, t)) || changed;
      if (action.fan !== undefined) changed = (await this.applyAcFan(device, action.fan)) || changed;
      return { changed, value: t };
    }

    if (action.kind === ActionKind.Off) {
      if (hasCap(device, CAP.OnOff)) {
        changed = await this.setCap(device, CAP.OnOff, false);
        this.offByUs.add(device.id);
      } else if (hasCap(device, CAP.ThermostatMode) && findModeValue(this.modeValues(device), 'off') != null) {
        changed = await this.setCap(device, CAP.ThermostatMode, findModeValue(this.modeValues(device), 'off'));
      } else if (planType === PlanType.Heating && hasCap(device, CAP.Target)) {
        // tête thermostatique sans arrêt possible : hors-gel
        const t = this.adjustTemperature(device, 7);
        changed = await this.setCap(device, CAP.Target, t);
        return { changed, value: t };
      }
      return { changed, value: 'off' };
    }

    if (action.kind === ActionKind.Fan) {
      if (action.speed <= 0) {
        if (hasCap(device, CAP.OnOff)) changed = await this.setCap(device, CAP.OnOff, false);
        else if (info.fanSpeedCap) changed = await this.setCap(device, info.fanSpeedCap, this.scaleSpeed(device, info.fanSpeedCap, 0));
        return { changed, value: 0 };
      }
      if (hasCap(device, CAP.OnOff)) changed = (await this.setCap(device, CAP.OnOff, true)) || changed;
      const fc = this.acFanCaps(device);
      if (action.mode) {
        changed = (await this.applyAcFan(device, action.mode, true)) || changed;
      } else if (fc.speed) {
        // vitesse par niveaux (fan_speed low/medium/high…) : 1/N…1 → niveau 1…N
        changed = (await this.applyAcFan(device, action.speed, true)) || changed;
      } else if (info.fanSpeedCap) {
        changed = (await this.setCap(device, info.fanSpeedCap, this.scaleSpeed(device, info.fanSpeedCap, action.speed))) || changed;
      }
      return { changed, value: action.speed };
    }
    return { changed: false };
  }

  /**
   * Capacités de ventilation d'un climatiseur : « vitesse » (fan_speed, fan_mode.speed,
   * fan_level…) et « mode » (fan_mode, fan_mode.mode, thermostat_fan_mode…).
   */
  acFanCaps(device) {
    const caps = (device.capabilities || []).filter((c) => /fan/i.test(c) && !/powerful|swing|onoff/i.test(c));
    const speed = caps.find((c) => /(speed|level|rate|strength)/i.test(c)) || null;
    const mode = caps.find((c) => c !== speed && /mode/i.test(c)) || null;
    return { speed, mode };
  }

  /** Toutes les valeurs des capacités de ventilation (mode + vitesse). */
  fanValues(device) {
    const { speed, mode } = this.acFanCaps(device);
    return [...(mode ? this.capValues(device, mode) : []), ...(speed ? this.capValues(device, speed) : [])];
  }

  capValues(device, cap) {
    const c = device.capabilitiesObj && device.capabilitiesObj[cap];
    return c && Array.isArray(c.values) ? c.values.map((v) => String(v.id)) : [];
  }

  /** Nombre de niveaux de vitesse réglables (hors auto / silence), 0 si aucun. */
  acFanLevels(device) {
    const { speed, mode } = this.acFanCaps(device);
    if (!speed && !mode) return 0;
    if (speed) {
      const vals = this.capValues(device, speed).filter((v) => !FAN_AUTO.test(v) && !FAN_QUIET.test(v));
      if (vals.length) return vals.length;
      const c = device.capabilitiesObj && device.capabilitiesObj[speed];
      if (c && typeof c.min === 'number' && typeof c.max === 'number' && typeof c.step === 'number' && c.step > 0) {
        return Math.min(10, Math.round((c.max - c.min) / c.step) + 1);
      }
      return 5;
    }
    return 0;
  }

  /** Applique la ventilation d'une plage ('auto', 'quiet' ou niveau 0..1). */
  async applyAcFan(device, fan, fanScale = false) {
    const { speed, mode } = this.acFanCaps(device);
    if (!speed && !mode) return false;
    const modeVals = mode ? this.capValues(device, mode) : [];
    const speedVals = speed ? this.capValues(device, speed) : [];
    const find = (vals, re) => vals.find((v) => re.test(v));
    let changed = false;
    if (fan === 'auto' || fan === 'quiet') {
      const re = fan === 'auto' ? FAN_AUTO : FAN_QUIET;
      const m = find(modeVals, re);
      if (m != null) return this.setCap(device, mode, m);
      const s = find(speedVals, re);
      if (s != null) return this.setCap(device, speed, s);
      if (fan === 'quiet' && speed) return this.applyAcFan(device, fanScale ? 0.01 : 0, fanScale); // à défaut : vitesse minimale
      return false;
    }
    if (typeof fan !== 'number' || !speed) return false;
    // vitesse fixe : sortir du mode auto / silence si le mode est séparé
    if (mode && modeVals.length) {
      const cur = String(this.value(device, mode));
      if (FAN_AUTO.test(cur) || FAN_QUIET.test(cur)) {
        const manual = modeVals.find((v) => FAN_MANUAL.test(v)) || modeVals.find((v) => !FAN_AUTO.test(v) && !FAN_QUIET.test(v));
        if (manual != null) changed = (await this.setCap(device, mode, manual)) || changed;
      }
    }
    const levels = speedVals.filter((v) => !FAN_AUTO.test(v) && !FAN_QUIET.test(v));
    let value;
    const n = levels.length;
    // clim : 0..1 → niveaux 1..N ; ventilateur : 0 = arrêt, donc 1/N..1 → niveaux 1..N
    const idx = fanScale ? Math.max(0, Math.ceil(fan * n - 0.05) - 1) : Math.round(fan * (n - 1));
    if (n) value = levels[Math.min(n - 1, idx)];
    else value = this.scaleSpeed(device, speed, fan);
    const c = device.capabilitiesObj && device.capabilitiesObj[speed];
    if (c && typeof c.value === 'number' && typeof value === 'string') value = Number(value);
    changed = (await this.setCap(device, speed, value)) || changed;
    return changed;
  }

  scaleSpeed(device, cap, speed) {
    const c = device.capabilitiesObj && device.capabilitiesObj[cap];
    if (c && Array.isArray(c.values) && c.values.length) {
      // capacité de type « enum » (ex. low/medium/high) : on choisit la valeur la plus proche
      const idx = Math.min(c.values.length - 1, Math.round(speed * (c.values.length - 1)));
      return c.values[idx].id;
    }
    const min = c && typeof c.min === 'number' ? c.min : 0;
    const max = c && typeof c.max === 'number' ? c.max : 1;
    let v = min + (max - min) * speed;
    if (c && typeof c.step === 'number' && c.step > 0) v = Math.round(v / c.step) * c.step;
    return Math.round(v * 100) / 100;
  }

  /** Liste simplifiée pour l'interface de réglages. */
  list() {
    return Object.values(this.devices).map((d) => {
      const info = describe(d);
      return {
        id: d.id,
        name: d.name,
        zone: d.zone,
        zoneName: this.zones[d.zone] ? this.zones[d.zone].name : '',
        class: info.cls,
        thermostat: info.thermostat,
        ac: info.ac,
        fan: info.fan,
        available: d.available !== false,
        temperature: this.measured(d),
        targetTemperature: this.value(d, CAP.Target),
        onoff: this.value(d, CAP.OnOff),
        thermostatMode: this.value(d, CAP.ThermostatMode),
        acFanLevels: info.ac || info.fan ? this.acFanLevels(d) : 0,
        acFanQuiet: info.ac || info.fan ? this.fanValues(d).some((v) => FAN_QUIET.test(v)) : false,
        acFanAuto: info.ac || info.fan ? this.fanValues(d).some((v) => FAN_AUTO.test(v)) : false,
      };
    }).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Sondes de température, pour le choix de la sonde extérieure. */
  listSensors() {
    return Object.entries(this.sensors).map(([key, s]) => {
      const c = s.device.capabilitiesObj && s.device.capabilitiesObj[s.cap];
      const v = s.cap === CAP.Measure ? this.measured(s.device) : (c ? c.value : null);
      return {
        id: key,
        name: this.sensorName(key),
        zoneName: this.zones[s.device.zone] ? this.zones[s.device.zone].name : '',
        class: deviceClass(s.device),
        outdoor: /outdoor|outside|exterieur|extérieur/i.test(`${s.cap} ${c && c.title}`),
        temperature: typeof v === 'number' ? v : null,
      };
    }).sort((a, b) => (b.outdoor - a.outdoor) || a.name.localeCompare(b.name));
  }

  listZones() {
    return Object.values(this.zones).map((z) => ({ id: z.id, name: z.name, parent: z.parent || null }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  destroy() {
    for (const id of Object.keys(this.instances)) this.detach(id);
    for (const id of Object.keys(this.contactInst)) this.detachContact(id);
    for (const key of Object.keys(this.roomInst)) this.unwatchRoom(key);
    this.unwatch();
  }

}

module.exports = {
  DeviceManager, describe, findModeValue, CAP,
};
