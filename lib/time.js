'use strict';

/**
 * Outils de date/heure.
 *
 * Avec le SDK 3, les applications Homey tournent en UTC : il faut donc
 * convertir explicitement l'heure courante dans le fuseau horaire du Homey
 * (this.homey.clock.getTimezone()) avant d'évaluer les programmes.
 */

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const MINUTES_PER_WEEK = 7 * 24 * 60;

const formatters = new Map();

function getFormatter(timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/**
 * Décompose une date dans le fuseau horaire donné.
 * @param {Date} date
 * @param {string} [timeZone]
 * @returns {{day:number, hour:number, minute:number, year:number, month:number, date:number, dateKey:string}}
 */
function localParts(date, timeZone) {
  const parts = {};
  for (const p of getFormatter(timeZone || 'UTC').formatToParts(date)) {
    parts[p.type] = p.value;
  }
  const hour = parseInt(parts.hour, 10) % 24;
  return {
    day: WEEKDAYS[parts.weekday],
    hour,
    minute: parseInt(parts.minute, 10),
    year: parseInt(parts.year, 10),
    month: parseInt(parts.month, 10),
    date: parseInt(parts.day, 10),
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

/**
 * Position dans la semaine en minutes, la semaine commençant le lundi à 00:00.
 */
function weekMinute(day, hour, minute) {
  const d = (day + 6) % 7; // lundi = 0 ... dimanche = 6
  return d * 1440 + hour * 60 + minute;
}

/**
 * Indique si la date (mois/jour) est comprise dans l'intervalle « MM-JJ » → « MM-JJ ».
 * Gère les intervalles qui chevauchent le nouvel an.
 */
function isInRange(month, date, start, end) {
  const toNum = (s) => {
    const m = /^(\d{1,2})-(\d{1,2})$/.exec(String(s || '').trim());
    if (!m) return null;
    return parseInt(m[1], 10) * 100 + parseInt(m[2], 10);
  };
  const s = toNum(start);
  const e = toNum(end);
  if (s == null || e == null) return false;
  const v = month * 100 + date;
  if (s <= e) return v >= s && v <= e;
  return v >= s || v <= e;
}

module.exports = {
  localParts,
  weekMinute,
  isInRange,
  MINUTES_PER_WEEK,
};
