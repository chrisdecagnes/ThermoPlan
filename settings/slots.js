/* Plages horaires (« slots ») d'un programme ThermoPlan.
 *
 * Fichier partagé : chargé par la page de réglages (window.ThermoSlots)
 * et par l'application (require) pour que l'interface et le serveur
 * calculent exactement le même programme.
 *
 * Un programme s'édite comme :
 *  - une valeur « hors plages » (base) : ex. 17 °C, Arrêt ;
 *  - des plages : jours + heure de début + heure de fin + valeur.
 * Il est converti en points de consigne hebdomadaires (schedule) pour
 * l'ordonnanceur. Une plage dont la fin est avant (ou égale à) son début
 * déborde sur le lendemain ; « 00:00 » en fin = jusqu'à minuit.
 * En cas de chevauchement, la plage placée le plus bas dans la liste gagne.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ThermoSlots = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  const WEEK = 7 * 1440;
  /** Ordre d'affichage : lundi → dimanche (0 = dimanche, convention JS). */
  const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
  const PRESETS = {
    weekdays: [1, 2, 3, 4, 5],
    weekend: [6, 0],
    all: [1, 2, 3, 4, 5, 6, 0],
  };
  const MAX_SLOTS = 50;

  const pad = (n) => String(n).padStart(2, '0');
  const weekIndex = (day) => (Number(day) + 6) % 7; // lundi = 0

  function toMin(s) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s == null ? '' : s).trim());
    if (!m) return null;
    const h = Number(m[1]);
    const mi = Number(m[2]);
    if (h > 24 || mi > 59 || (h === 24 && mi > 0)) return null;
    return (h * 60 + mi) % 1440;
  }

  function fmt(min) {
    const m = ((min % 1440) + 1440) % 1440;
    return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
  }

  function defaultBase(type) {
    if (type === 'fan') return { fanSpeed: 0 };
    if (type === 'cooling') return { off: true };
    return { targetTemperature: 17 };
  }

  /**
   * Ventilation d'un climatiseur / PAC pour une plage : 'auto', 'quiet'
   * (silence) ou un niveau 0..1 ; absente = réglage de l'appareil inchangé.
   */
  function cleanAcFan(f) {
    if (f === 'auto' || f === 'quiet') return f;
    const n = parseFloat(f);
    if (f == null || f === '' || Number.isNaN(n)) return undefined;
    return Math.round(Math.min(Math.max(n, 0), 1) * 100) / 100;
  }

  /** Valeur nettoyée selon le type, ou null si invalide. */
  function cleanValue(type, v) {
    if (!v || typeof v !== 'object') return null;
    if (type === 'fan') {
      if (v.off === true) return { fanSpeed: 0 };
      const s = parseFloat(v.fanSpeed);
      if (Number.isNaN(s)) return null;
      const out = { fanSpeed: Math.round(Math.min(Math.max(s, 0), 1) * 100) / 100 };
      // mode du ventilateur (auto / silence) : la vitesse ne sert alors qu'à dire « en marche »
      if (v.fan === 'auto' || v.fan === 'quiet') {
        out.fan = v.fan;
        if (out.fanSpeed === 0) out.fanSpeed = 1;
      }
      return out;
    }
    if (v.off === true) return { off: true };
    const t = parseFloat(String(v.targetTemperature).replace(',', '.'));
    if (Number.isNaN(t)) return null;
    const out = { targetTemperature: Math.round(Math.min(Math.max(t, 4), 35) * 10) / 10 };
    const fan = cleanAcFan(v.fan);
    if (fan !== undefined) out.fan = fan;
    return out;
  }

  function valueKey(type, v) {
    if (!v) return 'null';
    if (type === 'fan') return `f${Math.round((v.off ? 0 : Number(v.fanSpeed) || 0) * 100)}${v.fan ? `/${v.fan}` : ''}`;
    if (v.off) return 'off';
    return `t${Number(v.targetTemperature)}${v.fan !== undefined ? `/${v.fan}` : ''}`;
  }

  function cleanSlot(type, s) {
    if (!s || typeof s !== 'object') return null;
    const days = [...new Set((Array.isArray(s.days) ? s.days : []).map(Number))]
      .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
      .sort((a, b) => weekIndex(a) - weekIndex(b));
    const start = toMin(s.start);
    const end = toMin(s.end);
    const value = cleanValue(type, s.value);
    if (start == null || end == null || !value) return null;
    return {
      days, start: fmt(start), end: fmt(end), value,
    };
  }

  /** Minutes de la semaine couvertes par une plage (lundi 00:00 = 0). */
  function slotMinutes(slot) {
    const s = toMin(slot.start);
    const e = toMin(slot.end);
    if (s == null || e == null) return [];
    const len = e > s ? e - s : 1440 - s + e; // e <= s : déborde sur le lendemain (s == e : 24 h)
    const out = [];
    for (const d of slot.days || []) {
      const off = weekIndex(d) * 1440 + s;
      out.push([off, len]);
    }
    return out;
  }

  /** Peint la semaine : index de valeur et plage propriétaire pour chaque minute. */
  function paint(type, slots, base) {
    const baseV = cleanValue(type, base) || defaultBase(type);
    const values = [baseV];
    const keys = [valueKey(type, baseV)];
    const idx = new Uint16Array(WEEK);
    const owner = new Int16Array(WEEK).fill(-1);
    (slots || []).forEach((raw, si) => {
      const slot = cleanSlot(type, raw);
      if (!slot) return;
      const k = valueKey(type, slot.value);
      let vi = keys.indexOf(k);
      if (vi < 0) {
        values.push(slot.value);
        keys.push(k);
        vi = values.length - 1;
      }
      for (const [off, len] of slotMinutes(slot)) {
        for (let i = 0; i < len; i++) {
          const m = (off + i) % WEEK;
          idx[m] = vi;
          owner[m] = si;
        }
      }
    });
    return {
      values, keys, idx, owner,
    };
  }

  function setPoint(minute, v) {
    const day = DAY_ORDER[Math.floor(minute / 1440)];
    const m = minute % 1440;
    return {
      day, hour: Math.floor(m / 60), minute: m % 60, ...v,
    };
  }

  /** Plages → points de consigne (uniquement aux changements de valeur). */
  function toSchedule(type, slots, base) {
    const { values, idx } = paint(type, slots, base);
    const out = [];
    for (let i = 0; i < WEEK; i++) {
      if (idx[i] !== idx[(i + WEEK - 1) % WEEK]) out.push(setPoint(i, values[idx[i]]));
    }
    if (!out.length) out.push(setPoint(0, values[idx[0]]));
    return out;
  }

  /** Points de consigne (ancien format) → valeur hors plages + plages. */
  function fromSchedule(type, schedule) {
    const sps = (schedule || [])
      .map((sp) => ({ wm: weekIndex(sp.day) * 1440 + Number(sp.hour) * 60 + Number(sp.minute), v: cleanValue(type, sp) }))
      .filter((sp) => sp.v && sp.wm >= 0 && sp.wm < WEEK)
      .sort((a, b) => a.wm - b.wm);
    if (!sps.length) return { base: defaultBase(type), slots: [] };

    const keys = [];
    const values = [];
    const idx = new Int16Array(WEEK);
    let cur = sps[sps.length - 1]; // la dernière consigne de la semaine court jusqu'au premier point
    let p = 0;
    for (let i = 0; i < WEEK; i++) {
      while (p < sps.length && sps[p].wm <= i) cur = sps[p++];
      const k = valueKey(type, cur.v);
      let vi = keys.indexOf(k);
      if (vi < 0) {
        keys.push(k);
        values.push(cur.v);
        vi = keys.length - 1;
      }
      idx[i] = vi;
    }

    // valeur hors plages : la plus économe
    let bi = 0;
    values.forEach((v, i) => {
      const b = values[bi];
      if (type === 'fan') {
        if (v.fanSpeed < b.fanSpeed) bi = i;
      } else if (type === 'cooling') {
        if (v.off && !b.off) bi = i;
        else if (!v.off && !b.off && v.targetTemperature > b.targetTemperature) bi = i;
      } else if (!b.off && (v.off || v.targetTemperature < b.targetTemperature)) bi = i;
    });

    const groups = new Map();
    for (let d = 0; d < 7; d++) {
      let i = 0;
      while (i < 1440) {
        const vi = idx[d * 1440 + i];
        if (vi === bi) { i++; continue; }
        let j = i;
        while (j < 1440 && idx[d * 1440 + j] === vi) j++;
        const key = `${i}-${j}-${vi}`;
        if (!groups.has(key)) groups.set(key, { days: [], start: fmt(i), end: fmt(j), value: { ...values[vi] }, first: d * 1440 + i });
        groups.get(key).days.push(DAY_ORDER[d]);
        i = j;
      }
    }
    const slots = [...groups.values()]
      .sort((a, b) => a.first - b.first)
      .map(({ first, ...s }) => s);
    return { base: { ...values[bi] }, slots };
  }

  /** Segments par jour pour le graphique : [{ day, start, end, slot, value }] (minutes). */
  function dayRuns(type, slots, base) {
    const { values, idx, owner } = paint(type, slots, base);
    const out = [];
    for (let d = 0; d < 7; d++) {
      let i = 0;
      while (i < 1440) {
        const m = d * 1440 + i;
        const o = owner[m];
        if (o < 0) { i++; continue; }
        let j = i;
        while (j < 1440 && owner[d * 1440 + j] === o && idx[d * 1440 + j] === idx[m]) j++;
        out.push({
          day: DAY_ORDER[d], start: i, end: j, slot: o, value: values[idx[m]],
        });
        i = j;
      }
    }
    return out;
  }

  /** Indices des plages qui se chevauchent avec une autre. */
  function overlaps(slots) {
    const seen = new Int16Array(WEEK).fill(-1);
    const hit = new Set();
    (slots || []).forEach((s, si) => {
      for (const [off, len] of slotMinutes(s)) {
        for (let i = 0; i < len; i++) {
          const m = (off + i) % WEEK;
          if (seen[m] >= 0 && seen[m] !== si) {
            hit.add(si);
            hit.add(seen[m]);
          }
          seen[m] = si;
        }
      }
    });
    return [...hit].sort((a, b) => a - b);
  }

  /** Plages par défaut d'un nouveau programme. */
  function defaults(type) {
    if (type === 'cooling') {
      return { base: { off: true }, slots: [{ days: PRESETS.all, start: '12:00', end: '23:00', value: { targetTemperature: 26 } }] };
    }
    if (type === 'fan') {
      return { base: { fanSpeed: 0 }, slots: [{ days: PRESETS.all, start: '13:00', end: '22:00', value: { fanSpeed: 0.6 } }] };
    }
    return {
      base: { targetTemperature: 17 },
      slots: [
        { days: PRESETS.weekdays, start: '06:00', end: '08:00', value: { targetTemperature: 20 } },
        { days: PRESETS.weekdays, start: '17:00', end: '22:30', value: { targetTemperature: 20 } },
        { days: PRESETS.weekend, start: '08:00', end: '23:00', value: { targetTemperature: 20 } },
      ],
    };
  }

  return {
    DAY_ORDER,
    PRESETS,
    MAX_SLOTS,
    toMin,
    fmt,
    defaultBase,
    cleanValue,
    cleanAcFan,
    cleanSlot,
    valueKey,
    toSchedule,
    fromSchedule,
    dayRuns,
    overlaps,
    defaults,
  };
}));
