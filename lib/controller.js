'use strict';

const { EventEmitter } = require('events');
const {
  ActionKind, Mode, ModeName, PlanType, Settings, DEFAULTS, TEMPORARY_MODES, ThermostatMode, SeasonSetting,
} = require('./model');
const calc = require('./calculator');
const { OutdoorTracker } = require('./outdoor');
const { WindowWatcher, windowAction } = require('./windows');
const Room = require('./room');
const { PresenceWatcher } = require('./presence');
const { HistoryRecorder, setpointOf } = require('./history');

const MAX_RETRIES = 3;

/**
 * Cœur de l'application : évalue les plans chaque minute et n'écrit sur les
 * appareils que lorsque l'état calculé d'un plan change (nouveau point de
 * consigne, changement de mode, de saison, modification du plan...).
 * Ainsi, un réglage manuel fait directement sur un thermostat est conservé
 * jusqu'au point de consigne suivant, comme dans l'application d'origine.
 *
 * Événements :
 *  - 'applied'  ({ plans, evaluations })
 *  - 'mode'     (mode)
 *  - 'season'   (season)
 *  - 'outdoor'  (status) : nouvelle mesure de la sonde extérieure
 *  - 'outdoor_average' (valeur, précédente) : la moyenne extérieure (arrondie à 0,5 °C) a changé
 */
class Controller extends EventEmitter {

  constructor({
    homey, repository, devices, log, outdoor, presence,
  }) {
    super();
    this.homey = homey;
    this.repo = repository;
    this.devices = devices;
    this.log = log || (() => {});
    this.outdoor = outdoor || new OutdoorTracker({ homey, devices, log: this.log });
    this.outdoorSeason = null;
    this.windows = new WindowWatcher({ homey, devices, log: this.log });
    this.lastStopped = new Map(); // id du programme -> ids des appareils coupés par une fenêtre
    this.windowTimer = null;
    this.presence = presence || new PresenceWatcher({ homey, api: null, log: this.log });
    this.awayState = { active: false };
    this.awayTimer = null;
    this.presence.on('users', () => this.tick().catch((e) => this.log('tick', e.message)));
    this.presence.on('change', (active) => {
      this.log(active ? 'Personne à la maison : pause' : 'Retour à la maison : reprise');
      this.emit('away', active);
      if (this.setting(Settings.NotifyAway)) {
        this.notify(this.homey.__(active ? 'notification.away_on' : 'notification.away_off')).catch(() => {});
      }
    });
    this.regStates = new Map(); // id du programme -> 'on' | 'idle' (régulation par sonde de pièce)
    this.history = new HistoryRecorder({ homey, log: this.log });
    if (typeof devices.on === 'function') {
      devices.on('contact', () => this.tick().catch((e) => this.log('tick', e.message)));
      devices.on('room', () => this.tick().catch((e) => this.log('tick', e.message)));
    }
    this.lastKeys = new Map();
    this.retries = new Map();
    this.lastDateKey = null;
    this.lastSeason = null;
    this.running = false;
    this.pending = false;
  }

  setting(key) {
    const v = this.homey.settings.get(key);
    return v == null ? DEFAULTS[key] : v;
  }

  get mode() {
    const m = Number(this.setting(Settings.Mode));
    return Number.isInteger(m) && ModeName[m] ? m : Mode.Automatic;
  }

  get seasonSetting() {
    const s = this.setting(Settings.Season);
    return Object.values(SeasonSetting).includes(s) ? s : SeasonSetting.Auto;
  }

  timezone() {
    try {
      return this.homey.clock.getTimezone();
    } catch (e) {
      return 'Europe/Paris';
    }
  }

  context(now = new Date()) {
    const local = calc.localParts(now, this.timezone());
    const season = calc.getEffectiveSeason(
      this.seasonSetting, local, this.setting(Settings.CoolingStart), this.setting(Settings.CoolingEnd),
      this.outdoorSeason,
    );
    return {
      now, local, season, mode: this.mode, away: this.awayState.active ? this.presence.config : null,
    };
  }

  /** Relève la sonde extérieure et recalcule la saison « extérieure ». */
  updateOutdoor(now = new Date()) {
    try {
      const before = this.outdoor.lastValue;
      this.outdoor.sample(now);
      this.outdoorSeason = this.outdoor.update(now);
      if (this.outdoor.lastValue !== before) this.emit('outdoor', this.outdoor.status(now));
      // déclencheur Flow : moyenne arrondie au demi-degré
      const avg = this.outdoor.average(now);
      if (typeof avg === 'number') {
        const r = Math.round(avg * 2) / 2;
        if (this.lastOutdoorAverage != null && r !== this.lastOutdoorAverage) this.emit('outdoor_average', r, this.lastOutdoorAverage);
        this.lastOutdoorAverage = r;
      }
    } catch (e) {
      this.log('Sonde extérieure', e.message);
    }
  }

  async start() {
    this.updateOutdoor();
    const ctx = this.context();
    this.lastDateKey = ctx.local.dateKey;
    this.lastSeason = ctx.season;

    this.repo.on('changed', (plans) => {
      for (const p of plans) this.lastKeys.delete(p.id);
      this.tick().catch((e) => this.log('tick', e.message));
    });

    await this.tick();

    // alignement sur le début de chaque minute
    const delay = 60000 - (Date.now() % 60000) + 500;
    this.homey.setTimeout(() => {
      this.tick().catch((e) => this.log('tick', e.message));
      this.interval = this.homey.setInterval(() => {
        this.tick().catch((e) => this.log('tick', e.message));
      }, 60000);
    }, delay);
  }

  /** Une itération de l'ordonnanceur. */
  async tick() {
    if (this.running) {
      this.pending = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.pending = false;
        await this.runOnce();
      } while (this.pending);
    } finally {
      this.running = false;
    }
  }

  async runOnce(now = new Date()) {
    this.updateOutdoor(now);
    this.windows.sync(now);
    this.updateAway(now);
    let ctx = this.context(now);

    // Passage à minuit : fin des réglages « jusqu'à minuit » et des modes temporaires
    if (this.lastDateKey && ctx.local.dateKey !== this.lastDateKey) {
      this.lastDateKey = ctx.local.dateKey;
      await this.midnight();
      ctx = this.context(now);
    }
    this.lastDateKey = ctx.local.dateKey;

    if (this.lastSeason && ctx.season !== this.lastSeason) {
      this.lastSeason = ctx.season;
      await this.onSeasonChanged(ctx.season);
    }
    this.lastSeason = ctx.season;

    const evaluations = this.evaluateAll(ctx);
    this.applyRoomRegulation(evaluations);
    await this.applyWindows(evaluations, now);
    this.scheduleWindowCheck(now);
    const changed = evaluations.filter((e) => this.lastKeys.get(e.plan.id) !== e.key);
    if (changed.length) await this.applyEvaluations(changed, evaluations, ctx);
    this.recordHistory(now, ctx);
  }

  /** Point d'historique (toutes les 10 min) pour le graphique de l'aperçu. */
  recordHistory(now, ctx) {
    try {
      if (!this.history.due(now)) return;
      const plans = this.repo.getAll().map((p) => {
        const st = this.planStatus(p, ctx);
        let setpoint = setpointOf(st);
        // régulation par sonde : en attente, pas de consigne active
        if (setpoint != null && this.regStates.get(p.id) === 'idle') setpoint = null;
        return { id: p.id, temperature: st.temperature, setpoint };
      });
      this.history.prune(plans.map((p) => p.id));
      this.history.record(now, this.outdoor.lastValue, plans);
    } catch (e) {
      this.log('Historique', e.message);
    }
  }

  /** Historique des dernières 24 h (API). */
  dayHistory(planId) {
    return { step: this.history.step, now: Date.now(), points: this.history.get(Date.now(), planId || null) };
  }

  evaluateAll(ctx) {
    return this.repo.getAll().map((plan) => ({ plan, ...calc.evaluatePlan(plan, ctx) }));
  }

  /**
   * Fenêtres ouvertes : marque les appareils à couper dans chaque évaluation
   * (et modifie la clé pour forcer l'écriture au changement), notifie.
   */
  async applyWindows(evaluations, now) {
    for (const e of evaluations) {
      const stopped = e.action ? this.windows.stoppedDevices(e.plan, now).sort() : [];
      e.windowStopped = new Set(stopped);
      if (stopped.length) e.key = `${e.key}|win:${stopped.join(',')}`;
      const before = this.lastStopped.get(e.plan.id) || [];
      const opened = stopped.filter((id) => !before.includes(id));
      const closed = before.filter((id) => !stopped.includes(id));
      this.lastStopped.set(e.plan.id, stopped);
      if ((opened.length || closed.length) && this.setting(Settings.NotifyWindow)) {
        const names = (ids) => ids.map((id) => (this.devices.getDevice(id) || { name: id }).name).join(', ');
        if (opened.length) await this.notify(this.homey.__('notification.window_open', { names: names(opened), plan: e.plan.name }));
        if (closed.length) await this.notify(this.homey.__('notification.window_closed', { names: names(closed), plan: e.plan.name }));
      }
      if (opened.length || closed.length) this.emit('window', { planId: e.plan.id, stopped });
    }
  }

  /** Absence : état courant + passage programmé à la fin du délai. */
  updateAway(now = new Date()) {
    const ms = now instanceof Date ? now.getTime() : now;
    this.awayState = this.presence.status(ms);
    if (this.awayTimer) {
      this.homey.clearTimeout(this.awayTimer);
      this.awayTimer = null;
    }
    if (this.awayState.pending) {
      this.awayTimer = this.homey.setTimeout(() => {
        this.awayTimer = null;
        this.tick().catch((e) => this.log('tick', e.message));
      }, Math.max(0, this.awayState.pending - ms) + 500);
    }
  }

  /** Forçage de l'absence (carte Flow) : 'auto' | 'away' | 'home'. */
  async setAwayOverride(value) {
    if (!['auto', 'away', 'home'].includes(value)) throw new Error(`Valeur inconnue : ${value}`);
    this.homey.settings.set(Settings.AwayOverride, value);
    await this.tick();
  }

  /** Régulation par sonde de pièce : marque les programmes « en attente ». */
  applyRoomRegulation(evaluations) {
    for (const e of evaluations) {
      const room = e.plan.room;
      const target = room && room.mode === Room.RoomMode.Regulate ? Room.regulationTarget(e.plan, e.action) : null;
      if (target == null) {
        this.regStates.delete(e.plan.id);
        continue;
      }
      const t = this.devices.readSensor(room.sensor);
      if (typeof t !== 'number') {
        this.regStates.delete(e.plan.id);
        continue;
      }
      const st = Room.nextState(e.plan.type, t, target, room.hysteresis, this.regStates.get(e.plan.id));
      if (st !== this.regStates.get(e.plan.id)) this.log(`${e.plan.name} : pièce ${t}° / référence ${target}° → ${st}`);
      this.regStates.set(e.plan.id, st);
      e.regIdle = st === 'idle';
      e.key = `${e.key}|reg:${st}`;
    }
  }

  /** Programme un passage de l'ordonnanceur quand un délai « fenêtre » arrive à échéance. */
  scheduleWindowCheck(now) {
    const ms = now instanceof Date ? now.getTime() : now;
    const next = this.windows.nextDeadline(this.repo.getAll(), ms);
    if (this.windowTimer) {
      this.homey.clearTimeout(this.windowTimer);
      this.windowTimer = null;
    }
    if (next == null) return;
    this.windowTimer = this.homey.setTimeout(() => {
      this.windowTimer = null;
      this.tick().catch((e) => this.log('tick', e.message));
    }, Math.max(0, next - ms) + 300);
  }

  /**
   * Applique les plans « changed » en tenant compte de tous les plans
   * concernant les mêmes appareils (résolution des conflits).
   */
  async applyEvaluations(changed, evaluations, ctx) {
    // appareils touchés -> liste des actions candidates
    const perDevice = new Map();
    const touched = new Set();

    for (const e of changed) {
      if (!e.action) continue;
      for (const d of this.devices.expandPlan(e.plan)) touched.add(d.id);
    }

    for (const e of evaluations) {
      if (!e.action) continue;
      for (const d of this.devices.expandPlan(e.plan)) {
        if (!touched.has(d.id)) continue;
        if (!perDevice.has(d.id)) perDevice.set(d.id, []);
        const win = e.windowStopped && e.windowStopped.has(d.id);
        perDevice.get(d.id).push({
          window: win,
          action: win ? windowAction(e.plan) : (e.regIdle ? Room.idleAction(e.plan, d) : e.action),
          planId: e.plan.id, planName: e.plan.name, planType: e.plan.type, source: e.source,
        });
      }
    }

    const failedPlans = new Set();
    const policies = {
      heating: this.setting(Settings.HeatingConflict),
      cooling: this.setting(Settings.CoolingConflict),
      season: ctx.season,
    };

    await Promise.all([...perDevice.entries()].map(async ([deviceId, entries]) => {
      const device = this.devices.getDevice(deviceId);
      if (!device) return;
      // une fenêtre ouverte l'emporte sur toute autre consigne
      const winner = entries.find((x) => x.window) || calc.resolveConflict(entries, policies);
      if (!winner) return;
      try {
        const res = await this.devices.apply(device, winner.action, winner.planType);
        if (res.changed) {
          this.log(`${device.name} ← ${JSON.stringify(winner.action)} (${winner.planName})`);
          if (this.setting(Settings.NotifySetSuccess)) {
            await this.notify(this.successMessage(device, winner));
          }
        }
      } catch (err) {
        this.log(`Échec sur ${device.name}`, err.message);
        entries.forEach((en) => failedPlans.add(en.planId));
        const k = `${deviceId}`;
        const n = (this.retries.get(k) || 0) + 1;
        this.retries.set(k, n);
        if (n === MAX_RETRIES && this.setting(Settings.NotifySetError)) {
          await this.notify(this.homey.__('notification.failed', {
            name: device.name, error: err.message,
          }));
        }
        return;
      }
      this.retries.delete(deviceId);
    }));

    for (const e of changed) {
      // en cas d'échec, on réessaie à la minute suivante (MAX_RETRIES fois)
      const retries = Math.max(0, ...this.devices.expandPlan(e.plan).map((d) => this.retries.get(d.id) || 0));
      if (failedPlans.has(e.plan.id) && retries < MAX_RETRIES) this.lastKeys.delete(e.plan.id);
      else this.lastKeys.set(e.plan.id, e.key);
    }

    this.emit('applied', { plans: changed.map((e) => e.plan), evaluations });
  }

  successMessage(device, winner) {
    const a = winner.action;
    if (a.kind === ActionKind.Temperature) {
      return this.homey.__('notification.set_temperature', { name: device.name, value: a.value, plan: winner.planName });
    }
    if (a.kind === ActionKind.Fan) {
      return a.speed > 0
        ? this.homey.__('notification.set_fan', { name: device.name, value: Math.round(a.speed * 100), plan: winner.planName })
        : this.homey.__('notification.set_off', { name: device.name, plan: winner.planName });
    }
    return this.homey.__('notification.set_off', { name: device.name, plan: winner.planName });
  }

  /** Force la réapplication de tous les plans actifs. */
  async applyAll() {
    this.lastKeys.clear();
    await this.tick();
  }

  /** Force la réapplication d'un plan. */
  async applyPlan(planId) {
    this.lastKeys.delete(planId);
    await this.tick();
  }

  async midnight() {
    this.log('Minuit : réinitialisation des réglages temporaires');
    for (const plan of this.repo.getAll()) {
      if (plan.thermostatMode === ThermostatMode.OverrideDay) {
        this.repo.patch(plan.id, { thermostatMode: ThermostatMode.Automatic }, { notify: false });
        this.lastKeys.delete(plan.id);
        this.emit('thermostat', plan.id);
      }
    }
    if (TEMPORARY_MODES.includes(this.mode)) {
      await this.setMode(Mode.Automatic);
    }
  }

  async setMode(mode) {
    const m = Number(mode);
    if (!ModeName[m]) throw new Error(`Mode inconnu : ${mode}`);
    if (m === this.mode) return;
    this.homey.settings.set(Settings.Mode, m);
    this.log(`Mode : ${ModeName[m]}`);
    this.lastKeys.clear();
    this.emit('mode', m);
    if (this.setting(Settings.NotifyModeChange)) {
      await this.notify(this.homey.__('notification.mode', { mode: this.homey.__(`modes.${m}`) }));
    }
    await this.tick();
  }

  async setSeason(setting) {
    if (!Object.values(SeasonSetting).includes(setting)) throw new Error(`Saison inconnue : ${setting}`);
    this.homey.settings.set(Settings.Season, setting);
    await this.tick();
  }

  async onSeasonChanged(season) {
    this.log(`Saison : ${season}`);
    this.lastKeys.clear();
    this.emit('season', season);
    if (this.setting(Settings.NotifySeasonChange)) {
      await this.notify(this.homey.__('notification.season', { season: this.homey.__(`seasons.${season}`) }));
    }
  }

  async notify(excerpt) {
    try {
      await this.homey.notifications.createNotification({ excerpt });
    } catch (e) {
      this.log('Notification impossible', e.message);
    }
  }

  /** État d'un plan, pour l'interface et les thermostats virtuels. */
  planStatus(plan, ctx = this.context()) {
    const evaluation = calc.evaluatePlan(plan, ctx);
    const devices = this.devices.expandPlan(plan);
    const temps = devices.map((d) => this.devices.measured(d)).filter((v) => typeof v === 'number');
    let average = temps.length ? Math.round((temps.reduce((a, b) => a + b, 0) / temps.length) * 10) / 10 : null;
    // sonde de la pièce : sa mesure remplace la moyenne des appareils
    const roomTemp = plan.room ? this.devices.readSensor(plan.room.sensor) : null;
    if (typeof roomTemp === 'number') average = Math.round(roomTemp * 10) / 10;
    const nextChange = plan.enabled ? calc.getNextChange(plan, ctx.local, ctx.now) : null;
    return {
      id: plan.id,
      name: plan.name,
      type: plan.type,
      enabled: plan.enabled,
      inSeason: calc.isPlanInSeason(plan, ctx.season),
      thermostatMode: plan.thermostatMode || ThermostatMode.Automatic,
      action: evaluation.action,
      source: evaluation.source,
      devices: devices.map((d) => d.id),
      temperature: average,
      room: plan.room ? {
        sensor: plan.room.sensor,
        name: this.devices.sensorName(plan.room.sensor),
        mode: plan.room.mode,
        temperature: typeof roomTemp === 'number' ? roomTemp : null,
        regulation: this.regStates.get(plan.id) || null,
      } : null,
      windowStopped: (this.lastStopped.get(plan.id) || [])
        .map((id) => (this.devices.getDevice(id) || { name: id }).name),
      nextChange: nextChange ? nextChange.toISOString() : null,
    };
  }

  state() {
    const ctx = this.context();
    const plans = this.repo.getAll().map((p) => this.planStatus(p, ctx));
    const next = plans.map((p) => p.nextChange).filter(Boolean).sort()[0] || null;
    return {
      mode: ctx.mode,
      seasonSetting: this.seasonSetting,
      season: ctx.season,
      outdoor: this.outdoor.status(ctx.now),
      away: {
        ...this.awayState,
        override: this.presence.override,
        config: this.presence.config,
        users: this.presence.users,
      },
      timezone: this.timezone(),
      version: this.homey.manifest ? this.homey.manifest.version : null,
      localDay: ctx.local.day,
      localMinutes: ctx.local.hour * 60 + ctx.local.minute,
      localTime: `${String(ctx.local.hour).padStart(2, '0')}:${String(ctx.local.minute).padStart(2, '0')}`,
      nextChange: next,
      plans,
      devices: this.devices.list(),
    };
  }

  /** Utilisé par le thermostat virtuel : consigne manuelle sur tous les appareils du plan. */
  async setManualTemperature(plan, value) {
    const action = { kind: ActionKind.Temperature, value: calc.clampTemperature(value) };
    const devices = this.devices.expandPlan(plan);
    await Promise.all(devices.map(async (d) => {
      try {
        await this.devices.apply(d, action, plan.type || PlanType.Heating);
      } catch (e) {
        this.log(`Échec manuel sur ${d.name}`, e.message);
      }
    }));
  }

  /**
   * Bouton « Tester » de l'interface : applique tout de suite une valeur aux
   * appareils d'un programme (enregistré ou non). La consigne reste en place
   * jusqu'au prochain changement du programme, ou jusqu'à « Revenir au programme ».
   */
  async testPlan(plan, value) {
    const action = calc.valueToAction(plan, value);
    if (!action) throw new Error('Valeur invalide');
    const devices = this.devices.expandPlan(plan);
    const results = await Promise.all(devices.map(async (d) => {
      try {
        await this.devices.apply(d, action, plan.type || PlanType.Heating);
        return { id: d.id, name: d.name, ok: true };
      } catch (e) {
        return {
          id: d.id, name: d.name, ok: false, error: e.message,
        };
      }
    }));
    this.log(`Test « ${plan.name} » : ${JSON.stringify(action)} sur ${results.length} appareil(s)`);
    return { action, devices: results };
  }

  destroy() {
    if (this.interval) this.homey.clearInterval(this.interval);
    if (this.windowTimer) this.homey.clearTimeout(this.windowTimer);
    if (this.awayTimer) this.homey.clearTimeout(this.awayTimer);
  }

}

module.exports = { Controller };
