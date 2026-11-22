'use strict';

const {
  ActionKind, Mode, ModeName, PlanType, PlanSeason, Season, SeasonSetting, ThermostatMode, LIMITS,
} = require('./model');
const {
  localParts, weekMinute, isInRange, MINUTES_PER_WEEK,
} = require('./time');

/**
 * Fonctions pures de calcul des programmes. Aucune dépendance à Homey,
 * ce qui permet de les tester unitairement (voir /test).
 */

function sortSchedule(schedule) {
  return (schedule || [])
    .filter((sp) => sp && Number.isInteger(Number(sp.day)) && sp.hour != null && sp.minute != null)
    .map((sp) => ({ ...sp, wm: weekMinute(Number(sp.day), Number(sp.hour), Number(sp.minute)) }))
    .sort((a, b) => a.wm - b.wm);
}

/**
 * Point de consigne actif à un instant donné.
 * Si aucun point n'existe avant « maintenant » dans la semaine, le dernier
 * point de la semaine (semaine précédente) reste actif.
 *
 * @param {object} plan
 * @param {{day:number,hour:number,minute:number}} now heure locale
 * @returns {object|null} le point de consigne (avec .wm) ou null
 */
function getActiveSetPoint(plan, now) {
  const sorted = sortSchedule(plan && plan.schedule);
  if (sorted.length === 0) return null;
  const current = weekMinute(now.day, now.hour, now.minute);
  let found = null;
  for (const sp of sorted) {
    if (sp.wm <= current) found = sp;
    else break;
  }
  return found || sorted[sorted.length - 1];
}

/**
 * Prochain point de consigne.
 * @returns {{setPoint:object, inMinutes:number}|null}
 */
function getNextSetPoint(plan, now) {
  const sorted = sortSchedule(plan && plan.schedule);
  if (sorted.length === 0) return null;
  const current = weekMinute(now.day, now.hour, now.minute);
  const next = sorted.find((sp) => sp.wm > current);
  if (next) return { setPoint: next, inMinutes: next.wm - current };
  return { setPoint: sorted[0], inMinutes: sorted[0].wm + MINUTES_PER_WEEK - current };
}

/**
 * Saison effective selon le réglage et la date locale.
 * @param {string} seasonSetting réglage (auto, outdoor, heating, cooling, off)
 * @param {object} local date locale ({ month, date })
 * @param {string} coolingStart « MM-JJ »
 * @param {string} coolingEnd « MM-JJ »
 * @param {string|null} [outdoor] saison calculée d'après la sonde extérieure
 *   (réglage « outdoor » ; si null, repli sur les dates)
 */
function getEffectiveSeason(seasonSetting, local, coolingStart, coolingEnd, outdoor = null) {
  switch (seasonSetting) {
    case SeasonSetting.Heating: return Season.Heating;
    case SeasonSetting.Cooling: return Season.Cooling;
    case SeasonSetting.Off: return Season.Off;
    case SeasonSetting.Outdoor:
      if (outdoor && Object.values(Season).includes(outdoor)) return outdoor;
      // pas encore de mesure : on se replie sur les dates
      return isInRange(local.month, local.date, coolingStart, coolingEnd) ? Season.Cooling : Season.Heating;
    default:
      return isInRange(local.month, local.date, coolingStart, coolingEnd) ? Season.Cooling : Season.Heating;
  }
}

/**
 * Le plan est-il « de saison » ?
 */
function isPlanInSeason(plan, season) {
  if (plan.season === PlanSeason.Always) return true;
  const type = plan.type || PlanType.Heating;
  if (type === PlanType.Heating) return season === Season.Heating;
  return season === Season.Cooling; // climatisation et ventilation : été
}

function clampTemperature(value) {
  const v = typeof value === 'number' ? value : parseFloat(value);
  if (Number.isNaN(v)) return null;
  return Math.round(Math.min(Math.max(LIMITS.minTemperature, v), LIMITS.maxTemperature) * 100) / 100;
}

function clampSpeed(value) {
  const v = typeof value === 'number' ? value : parseFloat(value);
  if (Number.isNaN(v)) return null;
  return Math.round(Math.min(Math.max(0, v), 1) * 100) / 100;
}

/**
 * Convertit une valeur (point de consigne ou exception) en action.
 */
function valueToAction(plan, value) {
  if (value == null) return null;
  const type = plan.type || PlanType.Heating;

  if (type === PlanType.Fan) {
    if (value.off === true) return { kind: ActionKind.Fan, speed: 0 };
    const speed = clampSpeed(value.fanSpeed);
    if (speed == null) return null;
    const action = { kind: ActionKind.Fan, speed };
    if (speed > 0 && (value.fan === 'auto' || value.fan === 'quiet')) action.mode = value.fan;
    return action;
  }

  if (value.off === true) return { kind: ActionKind.Off };
  const t = clampTemperature(value.targetTemperature);
  if (t == null) return null;
  const action = { kind: ActionKind.Temperature, value: t };
  // ventilation du climatiseur (plages de chauffage / climatisation)
  if (value.fan === 'auto' || value.fan === 'quiet' || typeof value.fan === 'number') action.fan = value.fan;
  return action;
}

/**
 * Évalue un plan : quelle action appliquer à ses appareils maintenant ?
 *
 * @param {object} plan
 * @param {object} ctx { mode, season, local }
 * @returns {{action: object|null, source: string, key: string, setPoint?: object}}
 *   key : identifiant stable de l'état, utilisé par l'ordonnanceur pour
 *   détecter un changement et n'écrire sur les appareils qu'à ce moment-là.
 */
function evaluatePlan(plan, ctx) {
  const type = plan.type || PlanType.Heating;
  const modeName = ModeName[ctx.mode] || 'Automatic';
  const overrides = plan.overrides || {};

  if (!plan.enabled) {
    return { action: null, source: 'disabled', key: 'disabled' };
  }

  // Personne à la maison : pause (chauffage arrêté ou réduit, clim et ventilation arrêtées)
  if (ctx.away && isPlanInSeason(plan, ctx.season)) {
    let action;
    if (type === PlanType.Fan) action = { kind: ActionKind.Fan, speed: 0 };
    else if (type === PlanType.Cooling) action = { kind: ActionKind.Off };
    else if (ctx.away.heating === 'eco') action = { kind: ActionKind.Temperature, value: clampTemperature(ctx.away.ecoTemperature) };
    else action = { kind: ActionKind.Off };
    return { action, source: 'away', key: `away:${JSON.stringify(action)}` };
  }

  // Thermostat virtuel en mode manuel : on ne touche à rien.
  if (plan.thermostatMode === ThermostatMode.OverrideDay || plan.thermostatMode === ThermostatMode.FullManual) {
    return { action: null, source: 'manual', key: `manual:${plan.thermostatMode}` };
  }

  // Hors saison
  if (!isPlanInSeason(plan, ctx.season)) {
    if (type === PlanType.Heating) {
      // compatibilité : l'exception « hors saison » est appliquée au chauffage
      const action = valueToAction(plan, overrides.OutOfSeason);
      return { action, source: 'season', key: `season:${ctx.season}:${JSON.stringify(action)}` };
    }
    // climatisation / ventilation : on éteint (une seule fois, au changement d'état)
    const action = plan.offOutOfSeason === false
      ? null
      : (type === PlanType.Fan ? { kind: ActionKind.Fan, speed: 0 } : { kind: ActionKind.Off });
    return { action, source: 'season', key: `season:${ctx.season}:${JSON.stringify(action)}` };
  }

  // Exception du mode courant
  if (ctx.mode !== Mode.Automatic && overrides[modeName] != null) {
    const action = valueToAction(plan, overrides[modeName]);
    if (action) {
      return { action, source: `mode:${modeName}`, key: `mode:${modeName}:${JSON.stringify(action)}` };
    }
  }

  const sp = getActiveSetPoint(plan, ctx.local);
  if (!sp) return { action: null, source: 'empty', key: 'empty' };
  const action = valueToAction(plan, sp);
  return {
    action,
    source: 'schedule',
    setPoint: sp,
    key: `sp:${sp.wm}:${JSON.stringify(action)}`,
  };
}

/**
 * Résout les conflits lorsqu'un même appareil reçoit plusieurs actions
 * (plusieurs plans actifs le concernent).
 *
 * Règles :
 *  - une consigne de température l'emporte sur un arrêt ;
 *  - chauffage : maximum (par défaut) ; climatisation : minimum (par défaut) ;
 *  - ventilation : vitesse maximale.
 */
function resolveConflict(entries, policies = {}) {
  if (!entries || entries.length === 0) return null;
  if (entries.length === 1) return entries[0];

  const fans = entries.filter((e) => e.action.kind === ActionKind.Fan);
  if (fans.length === entries.length) {
    return fans.reduce((a, b) => (b.action.speed > a.action.speed ? b : a));
  }

  const temps = entries.filter((e) => e.action.kind === ActionKind.Temperature);
  if (temps.length === 0) return entries.find((e) => e.action.kind === ActionKind.Off) || entries[0];

  const pick = (list, policy) => list.reduce((a, b) => {
    if (policy === 'min') return b.action.value < a.action.value ? b : a;
    return b.action.value > a.action.value ? b : a;
  });

  const cooling = temps.filter((e) => e.planType === PlanType.Cooling);
  const heating = temps.filter((e) => e.planType !== PlanType.Cooling);
  // en principe une seule famille est active selon la saison
  if (heating.length > 0 && cooling.length === 0) return pick(heating, policies.heating || 'max');
  if (cooling.length > 0 && heating.length === 0) return pick(cooling, policies.cooling || 'min');
  // les deux (plans « toute l'année ») : le chauffage prime en hiver, la clim en été
  return policies.season === Season.Cooling
    ? pick(cooling, policies.cooling || 'min')
    : pick(heating, policies.heating || 'max');
}

/**
 * Calcule la date locale (approximative) du prochain changement d'un plan.
 */
function getNextChange(plan, local, nowDate = new Date()) {
  const next = getNextSetPoint(plan, local);
  if (!next) return null;
  return new Date(nowDate.getTime() + next.inMinutes * 60000 - (nowDate.getSeconds() * 1000));
}

module.exports = {
  sortSchedule,
  getActiveSetPoint,
  getNextSetPoint,
  getEffectiveSeason,
  isPlanInSeason,
  evaluatePlan,
  resolveConflict,
  valueToAction,
  clampTemperature,
  clampSpeed,
  getNextChange,
  localParts,
};
