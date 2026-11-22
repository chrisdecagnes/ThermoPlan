'use strict';

/**
 * Historique des dernières 24 h pour le graphique de l'aperçu.
 * Un point toutes les 10 minutes :
 *   { t: horodatage (ms), o: température extérieure | null,
 *     p: { idProgramme: [température mesurée | null, consigne | null] } }
 * Conservé dans le réglage « day_history » (≈ 145 points, quelques ko).
 */
const SETTING = 'day_history';
const STEP = 10 * 60000;
const SPAN = 24 * 3600000;

const round1 = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10) / 10 : null);

class HistoryRecorder {

  constructor({ homey, log, step = STEP }) {
    this.homey = homey;
    this.log = log || (() => {});
    this.step = step;
    const saved = homey.settings.get(SETTING);
    this.points = saved && Array.isArray(saved.points) ? saved.points.filter((x) => x && typeof x.t === 'number') : [];
  }

  /** Vrai si un nouveau point doit être enregistré. */
  due(now = Date.now()) {
    const ms = now instanceof Date ? now.getTime() : now;
    const last = this.points[this.points.length - 1];
    return !last || ms - last.t >= this.step - 5000 || ms < last.t;
  }

  /**
   * Ajoute un point.
   * @param {number|Date} now
   * @param {number|null} outdoor température extérieure
   * @param {Array} plans [{ id, temperature, setpoint }]
   */
  record(now, outdoor, plans) {
    const ms = now instanceof Date ? now.getTime() : now;
    if (!this.due(ms)) return false;
    // horloge revenue en arrière : on repart de zéro
    const last = this.points[this.points.length - 1];
    if (last && ms < last.t) this.points = [];
    const p = {};
    (plans || []).forEach((x) => {
      const m = round1(x.temperature);
      const s = round1(x.setpoint);
      if (m != null || s != null) p[x.id] = [m, s];
    });
    this.points.push({ t: Math.floor(ms / 60000) * 60000, o: round1(outdoor), p });
    this.points = this.points.filter((x) => x.t >= ms - SPAN - this.step);
    try {
      this.homey.settings.set(SETTING, { points: this.points });
    } catch (e) {
      this.log('Historique', e.message);
    }
    return true;
  }

  /** Points des dernières 24 h (éventuellement limités à un programme). */
  get(now = Date.now(), planId = null) {
    const ms = now instanceof Date ? now.getTime() : now;
    return this.points
      .filter((x) => x.t >= ms - SPAN)
      .map((x) => (planId ? { t: x.t, o: x.o, p: x.p[planId] ? { [planId]: x.p[planId] } : {} } : x));
  }

  /** Oubli d'un programme supprimé. */
  prune(ids) {
    const keep = new Set(ids);
    this.points.forEach((x) => Object.keys(x.p).forEach((id) => { if (!keep.has(id)) delete x.p[id]; }));
  }

}

/** Consigne « affichable » d'un état de programme (température, ou null). */
function setpointOf(status) {
  if (!status || !status.enabled || !status.inSeason || !status.action) return null;
  if (status.source === 'away') return null;
  return status.action.kind === 'temperature' ? status.action.value : null;
}

module.exports = {
  HistoryRecorder, setpointOf, SETTING, STEP, SPAN,
};
