'use strict';

const { EventEmitter } = require('events');
const crypto = require('crypto');
const { PlanType, PlanSeason, Settings } = require('./model');
const Slots = require('../settings/slots');
const { normalizeWindow } = require('./windows');
const { normalizeRoom } = require('./room');

const MODE_KEYS = ['DayAtHome', 'DayAway', 'Sleep', 'Holiday', 'OutOfSeason'];

function newId() {
  return crypto.randomUUID();
}

/** Programme d'exemple selon le type. */
function defaultSchedule(type) {
  const days = [1, 2, 3, 4, 5];
  const weekend = [6, 0];
  const out = [];
  if (type === PlanType.Cooling) {
    for (const d of [...days, ...weekend]) {
      out.push({ day: d, hour: 12, minute: 0, targetTemperature: 26 });
      out.push({ day: d, hour: 23, minute: 0, off: true });
    }
  } else if (type === PlanType.Fan) {
    for (const d of [...days, ...weekend]) {
      out.push({ day: d, hour: 13, minute: 0, fanSpeed: 0.6 });
      out.push({ day: d, hour: 22, minute: 0, fanSpeed: 0 });
    }
  } else {
    for (const d of days) {
      out.push({ day: d, hour: 6, minute: 0, targetTemperature: 20 });
      out.push({ day: d, hour: 8, minute: 0, targetTemperature: 17 });
      out.push({ day: d, hour: 17, minute: 0, targetTemperature: 20 });
      out.push({ day: d, hour: 22, minute: 30, targetTemperature: 17 });
    }
    for (const d of weekend) {
      out.push({ day: d, hour: 8, minute: 0, targetTemperature: 20 });
      out.push({ day: d, hour: 23, minute: 0, targetTemperature: 17 });
    }
  }
  return out;
}

/**
 * Nettoie et valide un plan reçu de l'interface ou d'une sauvegarde.
 * Accepte aussi les plans de l'application d'origine (sans « type »).
 */
function normalizePlan(input) {
  if (!input || typeof input !== 'object') throw new Error('Plan invalide');
  const type = Object.values(PlanType).includes(input.type) ? input.type : PlanType.Heating;

  // Format « plages » (interface v2.2+) : les plages sont la référence, le
  // programme hebdomadaire en est recalculé.
  let slots = null;
  let base = null;
  if (Array.isArray(input.slots)) {
    slots = input.slots.map((sl) => Slots.cleanSlot(type, sl)).filter(Boolean).slice(0, Slots.MAX_SLOTS);
    base = Slots.cleanValue(type, input.base) || Slots.defaultBase(type);
  }

  const schedule = (slots ? Slots.toSchedule(type, slots, base) : (Array.isArray(input.schedule) ? input.schedule : []))
    .map((sp) => {
      const day = parseInt(sp.day, 10);
      const hour = parseInt(sp.hour, 10);
      const minute = parseInt(sp.minute, 10);
      if (!(day >= 0 && day <= 6 && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59)) return null;
      const out = { day, hour, minute };
      if (sp.off === true) out.off = true;
      if (type === PlanType.Fan) {
        const s = parseFloat(sp.fanSpeed);
        out.fanSpeed = Number.isNaN(s) ? 0 : Math.min(Math.max(s, 0), 1);
        if (sp.fan === 'auto' || sp.fan === 'quiet') out.fan = sp.fan;
      } else if (!out.off) {
        const t = parseFloat(sp.targetTemperature);
        if (Number.isNaN(t)) return null;
        out.targetTemperature = t;
        const fan = Slots.cleanAcFan(sp.fan);
        if (fan !== undefined) out.fan = fan;
      }
      return out;
    })
    .filter(Boolean);

  const overrides = {};
  const src = input.overrides || {};
  for (const k of MODE_KEYS) {
    // l'application d'origine a parfois stocké les exceptions par numéro de mode
    const idx = MODE_KEYS.indexOf(k) + 1;
    const v = src[k] != null ? src[k] : src[idx];
    if (v == null) continue;
    if (v.off === true) overrides[k] = { off: true };
    else if (type === PlanType.Fan && v.fanSpeed != null && !Number.isNaN(parseFloat(v.fanSpeed))) {
      overrides[k] = { fanSpeed: Math.min(Math.max(parseFloat(v.fanSpeed), 0), 1) };
      if (v.fan === 'auto' || v.fan === 'quiet') overrides[k].fan = v.fan;
    } else if (v.targetTemperature != null && !Number.isNaN(parseFloat(v.targetTemperature))) {
      overrides[k] = { targetTemperature: parseFloat(v.targetTemperature) };
    }
  }

  const plan = {
    id: String(input.id || newId()),
    name: String(input.name || 'Programme').slice(0, 80),
    description: input.description ? String(input.description).slice(0, 500) : '',
    type,
    enabled: input.enabled !== false,
    season: input.season === PlanSeason.Always ? PlanSeason.Always : PlanSeason.Default,
    offOutOfSeason: input.offOutOfSeason !== false,
    schedule,
    devices: Array.isArray(input.devices) ? input.devices.map(String) : [],
    zones: Array.isArray(input.zones) ? input.zones.map(String) : [],
    overrides,
  };
  const win = normalizeWindow(input.window, type);
  if (win && type !== PlanType.Fan) plan.window = win;
  const room = normalizeRoom(input.room, type);
  if (room) plan.room = room;
  if (slots) {
    plan.slots = slots;
    plan.base = base;
  }
  if (input.thermostatMode != null && Number.isInteger(Number(input.thermostatMode))) {
    plan.thermostatMode = Number(input.thermostatMode);
  }
  return plan;
}

/**
 * Stockage des plans dans les réglages de l'application (clé « plans », JSON).
 * Événement « changed » : (plans modifiés, type: 'changed' | 'removed').
 */
class PlanRepository extends EventEmitter {

  constructor(homey, log) {
    super();
    this.homey = homey;
    this.log = log || (() => {});
    this.plans = [];
    this.saving = false;
  }

  init() {
    this.load();
    this.homey.settings.on('set', (key) => {
      if (key !== Settings.Plans || this.saving) return;
      this.log('Plans modifiés depuis les réglages, rechargement');
      try {
        this.load();
        this.emit('changed', this.plans, 'changed');
      } catch (e) {
        this.log('Rechargement impossible', e.message);
      }
    });
  }

  load() {
    const raw = this.homey.settings.get(Settings.Plans);
    if (raw == null) {
      this.plans = [];
      return;
    }
    const list = typeof raw === 'string' ? JSON.parse(raw) : raw;
    this.plans = (Array.isArray(list) ? list : []).map((p) => {
      try {
        return normalizePlan(p);
      } catch (e) {
        return null;
      }
    }).filter(Boolean);
  }

  save() {
    this.saving = true;
    try {
      this.homey.settings.set(Settings.Plans, JSON.stringify(this.plans));
    } finally {
      this.saving = false;
    }
  }

  getAll() {
    return this.plans;
  }

  getActive() {
    return this.plans.filter((p) => p.enabled);
  }

  find(id) {
    return this.plans.find((p) => p.id === id);
  }

  findByName(name) {
    const n = String(name || '').toLowerCase();
    return this.plans.find((p) => (p.name || '').toLowerCase() === n);
  }

  upsert(planInput, { notify = true } = {}) {
    const plan = normalizePlan(planInput);
    const idx = this.plans.findIndex((p) => p.id === plan.id);
    if (idx >= 0) this.plans[idx] = plan;
    else this.plans.push(plan);
    this.save();
    if (notify) this.emit('changed', [plan], 'changed');
    return plan;
  }

  /** Mise à jour partielle sans revalidation complète (thermostat virtuel). */
  patch(id, changes, { notify = true } = {}) {
    const plan = this.find(id);
    if (!plan) return null;
    Object.assign(plan, changes);
    this.save();
    if (notify) this.emit('changed', [plan], 'changed');
    return plan;
  }

  remove(id) {
    const plan = this.find(id);
    if (!plan) return false;
    this.plans = this.plans.filter((p) => p.id !== id);
    this.save();
    this.emit('changed', [plan], 'removed');
    return true;
  }

  replaceAll(list) {
    this.plans = (Array.isArray(list) ? list : []).map(normalizePlan);
    this.save();
    this.emit('changed', this.plans, 'changed');
  }

  createDefault(type, name) {
    const t = Object.values(PlanType).includes(type) ? type : PlanType.Heating;
    return normalizePlan({
      id: newId(),
      name: name || 'Nouveau programme',
      type: t,
      enabled: false,
      ...Slots.defaults(t),
    });
  }

}

module.exports = {
  PlanRepository, normalizePlan, defaultSchedule, MODE_KEYS,
};
