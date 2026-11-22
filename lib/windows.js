'use strict';

const { ActionKind, PlanType, LIMITS } = require('./model');
const calc = require('./calculator');

/**
 * Arrêt sur ouverture de fenêtre.
 *
 * Option d'un programme de chauffage ou de climatisation :
 *   plan.window = { enabled, delay (s), sensors: [ids], value }
 *  - capteurs : ceux choisis, ou à défaut (liste vide) les capteurs d'ouverture
 *    (alarm_contact) situés dans la même zone que chaque appareil ;
 *  - un appareil est « coupé » quand l'un de ses capteurs est ouvert sans
 *    interruption depuis au moins `delay` secondes ;
 *  - chauffage : consigne `value` (hors-gel 7 °C par défaut, ou Arrêt) ;
 *    climatisation : arrêt ; à la fermeture, la consigne du programme revient.
 */

const DEFAULT_WINDOW = Object.freeze({
  enabled: false, delay: 60, sensors: [], value: null,
});
const MAX_DELAY = 3600;

function normalizeWindow(input, type) {
  if (!input || typeof input !== 'object') return null;
  const delay = Math.round(Number(input.delay));
  const out = {
    enabled: input.enabled === true,
    delay: Number.isFinite(delay) ? Math.min(Math.max(delay, 0), MAX_DELAY) : DEFAULT_WINDOW.delay,
    sensors: Array.isArray(input.sensors) ? [...new Set(input.sensors.map(String))] : [],
    // « plan » : une ouverture coupe tout le programme ; « device » : seulement les appareils de la pièce
    scope: input.scope === 'device' ? 'device' : 'plan',
  };
  if (type === PlanType.Heating) {
    const v = input.value || {};
    if (v.off === true) out.value = { off: true };
    else {
      const t = parseFloat(v.targetTemperature);
      out.value = { targetTemperature: Number.isNaN(t) ? 7 : Math.min(Math.max(t, LIMITS.minTemperature), LIMITS.maxTemperature) };
    }
  }
  return out;
}

/** Action appliquée à un appareil dont la fenêtre est ouverte. */
function windowAction(plan) {
  const type = plan.type || PlanType.Heating;
  if (type === PlanType.Fan) return { kind: ActionKind.Fan, speed: 0 };
  if (type === PlanType.Cooling) return { kind: ActionKind.Off };
  return calc.valueToAction(plan, (plan.window && plan.window.value) || { targetTemperature: 7 });
}

class WindowWatcher {

  constructor({ homey, devices, log }) {
    this.homey = homey;
    this.devices = devices;
    this.log = log || (() => {});
    this.openSince = new Map(); // id du capteur -> horodatage d'ouverture (ms)
  }

  /** Met à jour les ouvertures d'après l'état actuel des capteurs. */
  sync(now = Date.now()) {
    const ms = now instanceof Date ? now.getTime() : now;
    const contacts = this.devices.contacts || {};
    for (const id of Object.keys(contacts)) {
      const open = this.devices.contactValue(id) === true;
      if (open && !this.openSince.has(id)) this.openSince.set(id, ms);
      if (!open) this.openSince.delete(id);
    }
    for (const id of [...this.openSince.keys()]) {
      if (!contacts[id]) this.openSince.delete(id);
    }
  }

  /** Capteurs surveillés pour un appareil d'un programme. */
  sensorsFor(plan, device) {
    const w = plan.window;
    if (!w || !w.enabled) return [];
    if (w.sensors && w.sensors.length) return w.sensors.filter((id) => this.devices.contacts[id]);
    return Object.values(this.devices.contacts || {})
      .filter((c) => c.zone && c.zone === device.zone)
      .map((c) => c.id);
  }

  /** L'appareil doit-il être coupé à cet instant ? Renvoie les capteurs en cause. */
  openFor(plan, device, now = Date.now()) {
    const ms = now instanceof Date ? now.getTime() : now;
    const delay = (plan.window ? plan.window.delay : DEFAULT_WINDOW.delay) * 1000;
    return this.sensorsFor(plan, device).filter((id) => {
      const since = this.openSince.get(id);
      return since != null && ms - since >= delay;
    });
  }

  /**
   * Capteurs d'un programme entier : ceux choisis, ou à défaut ceux des zones
   * sélectionnées dans le programme et des zones de ses appareils.
   */
  planSensors(plan) {
    const w = plan.window;
    if (!w || !w.enabled) return [];
    if (w.sensors && w.sensors.length) return w.sensors.filter((id) => this.devices.contacts[id]);
    const zones = new Set([...(plan.zones || []), ...this.devices.expandPlan(plan).map((d) => d.zone)]);
    return Object.values(this.devices.contacts || {}).filter((c) => c.zone && zones.has(c.zone)).map((c) => c.id);
  }

  /** Appareils coupés d'un programme (ids). */
  stoppedDevices(plan, now = Date.now()) {
    if (!plan.window || !plan.window.enabled || plan.type === PlanType.Fan) return [];
    const devices = this.devices.expandPlan(plan);
    if (plan.window.scope !== 'device') {
      const ms = now instanceof Date ? now.getTime() : now;
      const delay = plan.window.delay * 1000;
      const open = this.planSensors(plan).some((id) => {
        const since = this.openSince.get(id);
        return since != null && ms - since >= delay;
      });
      return open ? devices.map((d) => d.id) : [];
    }
    return devices.filter((d) => this.openFor(plan, d, now).length > 0).map((d) => d.id);
  }

  /** Prochaine échéance (ms) à laquelle un capteur ouvert atteindra un délai de programme. */
  nextDeadline(plans, now = Date.now()) {
    const ms = now instanceof Date ? now.getTime() : now;
    let next = null;
    const delays = [...new Set(plans.filter((p) => p.window && p.window.enabled).map((p) => p.window.delay * 1000))];
    for (const since of this.openSince.values()) {
      for (const d of delays) {
        const at = since + d;
        if (at > ms && (next == null || at < next)) next = at;
      }
    }
    return next;
  }

}

module.exports = {
  WindowWatcher, normalizeWindow, windowAction, DEFAULT_WINDOW, MAX_DELAY,
};
