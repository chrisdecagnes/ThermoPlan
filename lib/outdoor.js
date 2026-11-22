'use strict';

const {
  Season, Settings, DEFAULTS, OUTDOOR_HYSTERESIS,
} = require('./model');

/**
 * Saison automatique selon la température extérieure.
 *
 * La température d'une sonde choisie par l'utilisateur est relevée à chaque
 * passage de l'ordonnanceur (chaque minute) et regroupée en moyennes horaires.
 * La saison découle de la moyenne glissante sur N heures (24 h par défaut) :
 *  - moyenne ≥ seuil « été »   → été (climatisation / ventilation) ;
 *  - moyenne ≤ seuil « hiver » → hiver (chauffage) ;
 *  - entre les deux            → mi-saison (aucun pilotage).
 * Une hystérésis évite les bascules répétées autour d'un seuil.
 * Sans sonde ou sans mesure, l'appelant se replie sur les dates.
 */

const HOUR = 3600 * 1000;
const MAX_HOURS = 72;

/**
 * Saison déduite d'une température moyenne (fonction pure).
 * @param {number|null} avg moyenne glissante (°C)
 * @param {string|null} previous saison précédemment calculée
 * @param {number} coolAbove seuil été (°C)
 * @param {number} heatBelow seuil hiver (°C)
 * @param {number} [hysteresis]
 * @returns {string|null} saison, ou null si indéterminable
 */
function outdoorSeason(avg, previous, coolAbove, heatBelow, hysteresis = OUTDOOR_HYSTERESIS) {
  if (typeof avg !== 'number' || Number.isNaN(avg)) return null;
  const cool = Number(coolAbove);
  const heat = Number(heatBelow);
  if (!(cool > heat)) return null; // réglage incohérent
  const h = Math.max(0, Math.min(Number(hysteresis) || 0, (cool - heat) / 2));
  if (previous === Season.Cooling && avg > cool - h) return Season.Cooling;
  if (previous === Season.Heating && avg < heat + h) return Season.Heating;
  if (avg >= cool) return Season.Cooling;
  if (avg <= heat) return Season.Heating;
  return Season.Off;
}

/** Ajoute une mesure aux moyennes horaires et supprime les tranches trop anciennes. */
function addSample(buckets, ms, value) {
  const hour = Math.floor(ms / HOUR);
  const out = (buckets || []).filter((b) => b && b.h > hour - MAX_HOURS && b.h <= hour);
  const last = out[out.length - 1];
  if (last && last.h === hour) {
    last.s = Math.round((last.s + value) * 100) / 100;
    last.n += 1;
  } else {
    out.push({ h: hour, s: value, n: 1 });
  }
  return out;
}

/** Moyenne (chaque heure a le même poids) des tranches des `hours` dernières heures. */
function averageOver(buckets, ms, hours) {
  const hour = Math.floor(ms / HOUR);
  const span = Math.max(1, Math.min(MAX_HOURS, Number(hours) || DEFAULTS[Settings.OutdoorHours]));
  const used = (buckets || []).filter((b) => b && b.n > 0 && b.h > hour - span && b.h <= hour);
  if (!used.length) return null;
  const sum = used.reduce((acc, b) => acc + b.s / b.n, 0);
  return Math.round((sum / used.length) * 10) / 10;
}

class OutdoorTracker {

  constructor({ homey, devices, log }) {
    this.homey = homey;
    this.devices = devices;
    this.log = log || (() => {});
    this.lastValue = null;
    this.current = null;
    this.persistedHour = null;
    const saved = homey.settings.get(Settings.OutdoorHistory);
    this.history = saved && typeof saved === 'object' && Array.isArray(saved.buckets)
      ? saved : { sensor: null, buckets: [] };
  }

  setting(key) {
    const v = this.homey.settings.get(key);
    return v == null || v === '' ? DEFAULTS[key] : v;
  }

  get sensorId() {
    return this.homey.settings.get(Settings.OutdoorSensor) || null;
  }

  save() {
    try {
      this.homey.settings.set(Settings.OutdoorHistory, this.history);
    } catch (e) {
      this.log('Sauvegarde de l’historique extérieur impossible', e.message);
    }
  }

  /** Relève la température de la sonde (à appeler chaque minute). */
  sample(now = new Date()) {
    const id = this.sensorId;
    if (!id) {
      this.lastValue = null;
      return;
    }
    if (this.history.sensor !== id) {
      // nouvelle sonde : on repart d'un historique vide
      this.history = { sensor: id, buckets: [] };
      this.persistedHour = null;
    }
    const v = this.devices.sensorValue(id);
    this.lastValue = typeof v === 'number' ? v : null;
    if (this.lastValue == null) return;
    const ms = now.getTime();
    this.history.buckets = addSample(this.history.buckets, ms, this.lastValue);
    const hour = Math.floor(ms / HOUR);
    if (this.persistedHour !== hour) {
      // une écriture par heure suffit (au début de chaque nouvelle tranche)
      this.persistedHour = hour;
      this.save();
    }
  }

  average(now = new Date()) {
    if (!this.sensorId || this.history.sensor !== this.sensorId) return null;
    return averageOver(this.history.buckets, now.getTime(), this.setting(Settings.OutdoorHours));
  }

  /** Recalcule la saison « extérieure » ; renvoie null si elle est indéterminable. */
  update(now = new Date()) {
    const previous = this.homey.settings.get(Settings.OutdoorSeason) || null;
    const season = outdoorSeason(
      this.average(now),
      previous,
      Number(this.setting(Settings.OutdoorCoolAbove)),
      Number(this.setting(Settings.OutdoorHeatBelow)),
    );
    if (season && season !== previous) this.homey.settings.set(Settings.OutdoorSeason, season);
    this.current = season;
    return season;
  }

  status(now = new Date()) {
    const id = this.sensorId;
    const device = id ? this.devices.getSensor(id) : null;
    return {
      sensorId: id,
      sensorName: device ? device.name : null,
      value: this.lastValue,
      average: this.average(now),
      hours: Number(this.setting(Settings.OutdoorHours)),
      coolAbove: Number(this.setting(Settings.OutdoorCoolAbove)),
      heatBelow: Number(this.setting(Settings.OutdoorHeatBelow)),
      season: this.current,
    };
  }

}

module.exports = {
  OutdoorTracker, outdoorSeason, addSample, averageOver, HOUR,
};
