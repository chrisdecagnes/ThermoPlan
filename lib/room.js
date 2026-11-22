'use strict';

const { ActionKind, PlanType } = require('./model');

/**
 * Sonde de la pièce (option d'un programme).
 *
 *   plan.room = { sensor, mode, hysteresis }
 *  - sensor : clé d'une sonde de température (id d'appareil, ou id:sous-capacité) ;
 *  - mode « display »  : la température de la pièce est seulement affichée ;
 *  - mode « regulate » : ThermoPlan allume / met en attente les appareils selon
 *    la sonde, avec une marge (hystérésis) autour de la consigne du programme :
 *      chauffage : chauffe sous (consigne − marge), attente au-dessus de (consigne + marge) ;
 *      climatisation : refroidit au-dessus de (consigne + marge), attente sous (consigne − marge) ;
 *    entre les deux, l'état précédent est conservé.
 *      ventilation : ventile au-dessus de (seuil + marge), arrêt sous (seuil − marge),
 *      le seuil étant `threshold` (26 °C par défaut) ;
 *    entre les deux, l'état précédent est conservé.
 *  En attente : arrêt si l'appareil sait s'éteindre, sinon consigne minimale
 *  (hors-gel 7 °C en chauffage ; vitesse 0 en ventilation).
 *  Sans mesure, le programme s'applique normalement.
 */

const RoomMode = Object.freeze({ Display: 'display', Regulate: 'regulate' });
const DEFAULT_HYSTERESIS = 0.5;
const IDLE_HEATING_TEMPERATURE = 7;
const DEFAULT_FAN_THRESHOLD = 26;

function normalizeRoom(input, type) {
  if (!input || typeof input !== 'object' || !input.sensor) return null;
  const h = parseFloat(input.hysteresis);
  const room = {
    sensor: String(input.sensor),
    mode: input.mode === RoomMode.Regulate ? RoomMode.Regulate : RoomMode.Display,
    hysteresis: Number.isNaN(h) ? DEFAULT_HYSTERESIS : Math.round(Math.min(Math.max(h, 0.1), 3) * 10) / 10,
  };
  if (type === PlanType.Fan) {
    const th = parseFloat(input.threshold);
    room.threshold = Number.isNaN(th) ? DEFAULT_FAN_THRESHOLD : Math.round(Math.min(Math.max(th, 15), 40) * 2) / 2;
  }
  return room;
}

/**
 * Nouvel état de régulation (« on » = demande, « idle » = attente).
 * @param {string} type type du programme
 * @param {number} room température de la pièce
 * @param {number} target consigne du programme
 * @param {number} h marge
 * @param {string|null} previous état précédent
 */
function nextState(type, room, target, h, previous) {
  if (type === PlanType.Cooling || type === PlanType.Fan) {
    if (room >= target + h) return 'on';
    if (room <= target - h) return 'idle';
  } else {
    if (room <= target - h) return 'on';
    if (room >= target + h) return 'idle';
  }
  if (previous === 'on' || previous === 'idle') return previous;
  // premier calcul, dans la marge : on suit le sens de l'écart
  if (type === PlanType.Cooling || type === PlanType.Fan) return room > target ? 'on' : 'idle';
  return room < target ? 'on' : 'idle';
}

/** Action « en attente » pour un appareil. */
function idleAction(plan, device) {
  if (plan.type === PlanType.Fan) return { kind: ActionKind.Fan, speed: 0 };
  const caps = Array.isArray(device.capabilities) ? device.capabilities : [];
  if (caps.includes('onoff')) return { kind: ActionKind.Off };
  if (plan.type === PlanType.Cooling) return { kind: ActionKind.Off }; // thermostat_mode « off » si disponible
  return { kind: ActionKind.Temperature, value: IDLE_HEATING_TEMPERATURE };
}

/**
 * Valeur de référence de la régulation pour une action, ou null si l'action
 * ne se régule pas (arrêt, ventilation à 0…).
 */
function regulationTarget(plan, action) {
  if (!action) return null;
  if (plan.type === PlanType.Fan) {
    if (action.kind !== ActionKind.Fan || !(action.speed > 0)) return null;
    return typeof plan.room.threshold === 'number' ? plan.room.threshold : DEFAULT_FAN_THRESHOLD;
  }
  return action.kind === ActionKind.Temperature ? action.value : null;
}

module.exports = {
  RoomMode, normalizeRoom, nextState, idleAction, regulationTarget, DEFAULT_HYSTERESIS, DEFAULT_FAN_THRESHOLD,
};
