'use strict';

/**
 * Modèle de données de l'application.
 *
 * Un « plan » (programme) regroupe :
 *  - un type : chauffage, climatisation ou ventilation ;
 *  - une liste de points de consigne hebdomadaires ;
 *  - des appareils et/ou des zones Homey ;
 *  - des exceptions par mode (à la maison, absent, nuit, vacances, hors saison).
 */

/** Jours de la semaine (convention JavaScript : dimanche = 0). */
const Day = Object.freeze({
  Sunday: 0,
  Monday: 1,
  Tuesday: 2,
  Wednesday: 3,
  Thursday: 4,
  Friday: 5,
  Saturday: 6,
});

/** Types de programme. */
const PlanType = Object.freeze({
  Heating: 'heating',
  Cooling: 'cooling',
  Fan: 'fan',
});

/** Modes de fonctionnement globaux (compatibles avec l'application d'origine). */
const Mode = Object.freeze({
  Automatic: 0,
  DayAtHome: 1,
  DayAway: 2,
  Sleep: 3,
  Holiday: 4,
  OutOfSeason: 5,
});

/** Nom des modes (clé utilisée pour les exceptions des plans). */
const ModeName = Object.freeze({
  0: 'Automatic',
  1: 'DayAtHome',
  2: 'DayAway',
  3: 'Sleep',
  4: 'Holiday',
  5: 'OutOfSeason',
});

/** Modes temporaires : ils reviennent automatiquement en « Automatique » à minuit. */
const TEMPORARY_MODES = Object.freeze([Mode.DayAtHome, Mode.DayAway, Mode.Sleep]);

/** Mode du thermostat virtuel d'un plan. */
const ThermostatMode = Object.freeze({
  Automatic: 0,
  OverrideDay: 6, // manuel jusqu'à minuit
  FullManual: 7, // entièrement manuel
});

/** Réglage de saison choisi par l'utilisateur. */
const SeasonSetting = Object.freeze({
  Auto: 'auto', // selon les dates configurées
  Outdoor: 'outdoor', // selon la température extérieure (sonde), repli sur les dates
  Heating: 'heating', // hiver : chauffage
  Cooling: 'cooling', // été : climatisation / ventilation
  Off: 'off', // mi-saison : rien n'est piloté
});

/** Saison effective. */
const Season = Object.freeze({
  Heating: 'heating',
  Cooling: 'cooling',
  Off: 'off',
});

/** Comportement d'un plan vis-à-vis des saisons. */
const PlanSeason = Object.freeze({
  Default: 'default', // chauffage en hiver, clim/ventilation en été
  Always: 'always', // toute l'année
});

/** Clés des réglages persistés. */
const Settings = Object.freeze({
  Plans: 'plans',
  Mode: 'mode',
  Season: 'season',
  CoolingStart: 'cooling_start', // « MM-JJ »
  CoolingEnd: 'cooling_end', // « MM-JJ »
  OutdoorSensor: 'outdoor_sensor', // id de l'appareil (measure_temperature)
  OutdoorCoolAbove: 'outdoor_cool_above', // °C : été au-dessus
  OutdoorHeatBelow: 'outdoor_heat_below', // °C : hiver en dessous
  OutdoorHours: 'outdoor_hours', // durée de la moyenne glissante (heures)
  OutdoorHistory: 'outdoor_history', // interne : moyennes horaires
  OutdoorSeason: 'outdoor_season', // interne : dernière saison calculée
  NotifyModeChange: 'notify_modechange',
  NotifySeasonChange: 'notify_seasonchange',
  NotifySetSuccess: 'notify_settempsuccess',
  NotifySetError: 'notify_settemperror',
  NotifyWindow: 'notify_window',
  NotifyAway: 'notify_away',
  Away: 'away', // { enabled, delay (min), heating: 'off'|'eco', ecoTemperature }
  AwayOverride: 'away_override', // 'auto' | 'away' | 'home' (carte Flow)
  HeatingConflict: 'heating_conflict', // 'max' | 'min'
  CoolingConflict: 'cooling_conflict', // 'min' | 'max'
});

const DEFAULTS = Object.freeze({
  [Settings.Mode]: Mode.Automatic,
  [Settings.Season]: SeasonSetting.Auto,
  [Settings.CoolingStart]: '06-01',
  [Settings.CoolingEnd]: '09-15',
  [Settings.OutdoorCoolAbove]: 22,
  [Settings.OutdoorHeatBelow]: 15,
  [Settings.OutdoorHours]: 24,
  [Settings.NotifyModeChange]: true,
  [Settings.NotifySeasonChange]: true,
  [Settings.NotifySetSuccess]: false,
  [Settings.NotifySetError]: true,
  [Settings.NotifyWindow]: true,
  [Settings.NotifyAway]: true,
  [Settings.HeatingConflict]: 'max',
  [Settings.CoolingConflict]: 'min',
});

/** Bornes de sécurité pour les températures. */
const LIMITS = Object.freeze({
  minTemperature: 4,
  maxTemperature: 35,
});

/** Saison selon la température extérieure : écart (°C) évitant les bascules répétées. */
const OUTDOOR_HYSTERESIS = 1;

/**
 * Type d'action calculée pour un appareil :
 *  - { kind: 'temperature', value }
 *  - { kind: 'off' }
 *  - { kind: 'fan', speed } (0..1, 0 = arrêt)
 *  - null : rien à faire
 */
const ActionKind = Object.freeze({
  Temperature: 'temperature',
  Off: 'off',
  Fan: 'fan',
});

module.exports = {
  Day,
  PlanType,
  Mode,
  ModeName,
  TEMPORARY_MODES,
  ThermostatMode,
  SeasonSetting,
  Season,
  PlanSeason,
  Settings,
  DEFAULTS,
  LIMITS,
  OUTDOOR_HYSTERESIS,
  ActionKind,
};
