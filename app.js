'use strict';

const Homey = require('homey');
const { HomeyAPI } = require('homey-api');
const { PlanRepository, normalizePlan } = require('./lib/repository');
const { DeviceManager } = require('./lib/devices');
const { Controller } = require('./lib/controller');
const { PresenceWatcher } = require('./lib/presence');
const { Mode, SeasonSetting, ThermostatMode } = require('./lib/model');
const Slots = require('./settings/slots');

/**
 * ThermoPlan : planificateur chauffage, climatisation et ventilation pour Homey (SDK 3).
 * Réécriture de « Homey Heating Scheduler » (M. Kling, GPL-3.0)
 * avec gestion de la climatisation et des ventilateurs.
 */
class ThermoPlanApp extends Homey.App {

  async onInit() {
    this.log(`Démarrage v${this.homey.manifest.version}`);
    // mode simulation : n'écrit rien sur les appareils (développement)
    this.dryRun = process.env.DRY_RUN === '1';

    const log = (...args) => this.log(...args);

    this.api = await HomeyAPI.createAppAPI({ homey: this.homey });
    this.repository = new PlanRepository(this.homey, log);
    this.repository.init();

    this.devices = new DeviceManager(this.homey, this.api, log);
    await this.devices.init();

    this.presence = new PresenceWatcher({ homey: this.homey, api: this.api, log });
    await this.presence.init();

    this.controller = new Controller({
      homey: this.homey, repository: this.repository, devices: this.devices, log, presence: this.presence,
    });

    this.registerFlow();
    this.registerTokens();
    this.registerWidget();

    await this.controller.start();
    this.log('Prêt');
  }

  async onUninit() {
    if (this.controller) this.controller.destroy();
    if (this.devices) this.devices.destroy();
  }

  async registerTokens() {
    try {
      this.modeToken = await this.homey.flow.createToken('heating_mode', {
        type: 'string', title: this.homey.__('tokens.mode'),
      });
      this.seasonToken = await this.homey.flow.createToken('season', {
        type: 'string', title: this.homey.__('tokens.season'),
      });
      this.nextToken = await this.homey.flow.createToken('next_change', {
        type: 'string', title: this.homey.__('tokens.next'),
      });
      this.outdoorToken = await this.homey.flow.createToken('outdoor_average', {
        type: 'number', title: this.homey.__('tokens.outdoor'),
      });
      const update = async () => {
        const s = this.controller.state();
        await this.modeToken.setValue(this.homey.__(`modes.${s.mode}`));
        await this.seasonToken.setValue(this.homey.__(`seasons.${s.season}`));
        await this.nextToken.setValue(s.nextChange ? this.formatDate(s.nextChange) : '-');
        if (s.outdoor && typeof s.outdoor.average === 'number') await this.outdoorToken.setValue(s.outdoor.average);
      };
      this.controller.on('mode', () => update().catch(this.error));
      this.controller.on('season', () => update().catch(this.error));
      this.controller.on('applied', () => update().catch(this.error));
      this.controller.on('outdoor', () => update().catch(this.error));
      await update();
    } catch (e) {
      this.error('Jetons', e);
    }
  }

  /** Widget de tableau de bord (Homey ≥ 12.3) : autocomplétion + rafraîchissement en temps réel. */
  registerWidget() {
    try {
      const widget = this.homey.dashboards.getWidget('thermoplan');
      widget.registerSettingAutocompleteListener('plan', async (query) => this.planAutocomplete(query));
    } catch (e) {
      this.log('Widget non disponible sur ce Homey', e.message);
    }
    const push = () => {
      try {
        this.homey.api.realtime('thermoplan.state', { at: Date.now() });
      } catch (e) { /* aucune page ouverte */ }
    };
    ['applied', 'mode', 'season', 'thermostat', 'window'].forEach((ev) => this.controller.on(ev, push));
    this.repository.on('changed', push);
  }

  /** Données compactes pour le widget (un programme ou tous). */
  widgetState(planId) {
    const s = this.controller.state();
    const plans = this.repository.getAll()
      .filter((p) => !planId || p.id === planId)
      .map((p) => {
        const st = s.plans.find((x) => x.id === p.id) || {};
        const sb = Array.isArray(p.slots) ? { slots: p.slots, base: p.base } : Slots.fromSchedule(p.type, p.schedule);
        const runs = Slots.dayRuns(p.type, sb.slots, sb.base);
        const today = runs.filter((r) => r.day === s.localDay)
          .map((r) => ({ start: r.start, end: r.end, value: r.value }));
        const current = today.find((r) => r.start <= s.localMinutes && s.localMinutes < r.end);
        return {
          id: p.id,
          name: p.name,
          type: p.type,
          enabled: p.enabled,
          inSeason: st.inSeason,
          windowStopped: st.windowStopped || [],
          room: st.room || null,
          away: st.source === 'away',
          manual: p.thermostatMode === ThermostatMode.OverrideDay || p.thermostatMode === ThermostatMode.FullManual,
          action: st.action || null,
          nextChange: st.nextChange || null,
          today,
          base: sb.base,
          testValue: (current && current.value) || (sb.slots[0] && sb.slots[0].value) || null,
        };
      });
    return {
      mode: s.mode,
      season: s.season,
      seasonSetting: s.seasonSetting,
      outdoor: s.outdoor && typeof s.outdoor.average === 'number' ? s.outdoor.average : null,
      timezone: s.timezone,
      localDay: s.localDay,
      localMinutes: s.localMinutes,
      plans,
    };
  }

  apiSetPlanEnabled(id, enabled) {
    const p = this.repository.find(id);
    if (!p) throw new Error(this.homey.__('errors.plan_not_found'));
    const changes = { enabled: enabled === true };
    if (!changes.enabled) changes.thermostatMode = ThermostatMode.Automatic;
    this.repository.patch(id, changes);
    return { id, enabled: changes.enabled };
  }

  formatDate(iso) {
    try {
      return new Date(iso).toLocaleString(this.homey.i18n.getLanguage() === 'fr' ? 'fr-FR' : 'en-GB', {
        timeZone: this.homey.clock.getTimezone(), weekday: 'short', hour: '2-digit', minute: '2-digit',
      });
    } catch (e) {
      return iso;
    }
  }

  planAutocomplete(query) {
    const q = String(query || '').toLowerCase();
    return this.repository.getAll()
      .filter((p) => (p.name || '').toLowerCase().includes(q))
      .map((p) => ({
        id: p.id,
        name: p.name,
        description: this.homey.__(`types.${p.type}`),
      }));
  }

  resolvePlan(arg) {
    const plan = arg && (this.repository.find(arg.id) || this.repository.findByName(arg.name));
    if (!plan) throw new Error(this.homey.__('errors.plan_not_found'));
    return plan;
  }

  registerFlow() {
    const { flow } = this.homey;
    const c = this.controller;

    // --- Déclencheurs
    this.modeChangedTrigger = flow.getTriggerCard('mode_changed');
    this.seasonChangedTrigger = flow.getTriggerCard('season_changed');
    c.on('mode', (m) => this.modeChangedTrigger
      .trigger({ mode: this.homey.__(`modes.${m}`) }).catch(this.error));
    c.on('season', (s) => this.seasonChangedTrigger
      .trigger({ season: this.homey.__(`seasons.${s}`) }).catch(this.error));
    const outdoorAvgTrigger = flow.getTriggerCard('outdoor_average_changed');
    c.on('outdoor_average', (value, previous) => outdoorAvgTrigger
      .trigger({ average: value, previous }).catch(this.error));

    // --- Actions
    flow.getActionCard('apply_all').registerRunListener(async () => {
      await c.applyAll();
    });

    const applyPlan = flow.getActionCard('apply_plan');
    applyPlan.registerArgumentAutocompleteListener('plan', async (q) => this.planAutocomplete(q));
    applyPlan.registerRunListener(async ({ plan }) => {
      await c.applyPlan(this.resolvePlan(plan).id);
    });

    flow.getActionCard('set_mode').registerRunListener(async ({ mode }) => {
      await c.setMode(Number(mode));
    });

    flow.getActionCard('set_season').registerRunListener(async ({ season }) => {
      await c.setSeason(season);
    });

    const setPlanState = flow.getActionCard('set_plan_state');
    setPlanState.registerArgumentAutocompleteListener('plan', async (q) => this.planAutocomplete(q));
    setPlanState.registerRunListener(async ({ plan, state }) => {
      const p = this.resolvePlan(plan);
      const enabled = state === 'true';
      const changes = { enabled };
      if (!enabled) changes.thermostatMode = 0;
      this.repository.patch(p.id, changes);
    });

    // --- Conditions
    flow.getConditionCard('mode_is').registerRunListener(async ({ mode }) => Number(mode) === c.mode);
    flow.getConditionCard('season_is').registerRunListener(async ({ season }) => c.context().season === season);
    flow.getConditionCard('away_active').registerRunListener(async () => c.awayState.active === true);
    flow.getActionCard('set_away').registerRunListener(async ({ state }) => {
      await c.setAwayOverride(state);
    });
    const awayOn = flow.getTriggerCard('away_started');
    const awayOff = flow.getTriggerCard('away_ended');
    c.on('away', (active) => (active ? awayOn : awayOff).trigger().catch(this.error));
    const planEnabled = flow.getConditionCard('plan_enabled');
    planEnabled.registerArgumentAutocompleteListener('plan', async (q) => this.planAutocomplete(q));
    planEnabled.registerRunListener(async ({ plan }) => this.resolvePlan(plan).enabled === true);
  }

  // ---------------------------------------------------------------------------
  // API Web utilisée par la page de réglages (voir api.js)
  // ---------------------------------------------------------------------------

  apiState() {
    return this.controller.state();
  }

  apiHistory(planId) {
    return this.controller.dayHistory(planId);
  }

  apiPlans() {
    return this.repository.getAll();
  }

  apiPlan(id) {
    const p = this.repository.find(id);
    if (!p) throw new Error(this.homey.__('errors.plan_not_found'));
    return p;
  }

  apiNewPlan(type, name) {
    return this.repository.createDefault(type, name);
  }

  apiSavePlan(id, body) {
    const plan = { ...body, id };
    // un plan désactivé repasse en automatique (sortie du mode « entièrement manuel »)
    if (plan.enabled === false) plan.thermostatMode = 0;
    return this.repository.upsert(plan);
  }

  apiDeletePlan(id) {
    return this.repository.remove(id);
  }

  apiReplacePlans(list) {
    this.repository.replaceAll(list);
    return this.repository.getAll();
  }

  async apiSetMode(mode) {
    await this.controller.setMode(Number(mode));
    return { mode: this.controller.mode };
  }

  async apiSetSeason(season) {
    if (!Object.values(SeasonSetting).includes(season)) throw new Error('season');
    await this.controller.setSeason(season);
    return this.controller.state();
  }

  /** Test immédiat depuis l'éditeur (programme éventuellement non enregistré). */
  async apiTestPlan(id, body) {
    const saved = this.repository.find(id) || {};
    const plan = normalizePlan({ ...saved, ...((body && body.plan) || {}), id });
    return this.controller.testPlan(plan, body && body.value);
  }

  /** Revenir au programme : renvoie la consigne prévue maintenant. */
  async apiApplyPlan(id) {
    await this.controller.applyPlan(id);
    return this.controller.state().plans.find((p) => p.id === id) || null;
  }

  async apiApplyAll() {
    await this.controller.applyAll();
    return true;
  }

  devicesPayload() {
    return {
      devices: this.devices.list(),
      zones: this.devices.listZones(),
      sensors: this.devices.listSensors(),
      contacts: this.devices.listContacts(),
    };
  }

  async apiRefreshDevices() {
    await this.devices.refresh();
    return this.devicesPayload();
  }

  apiDevices() {
    return this.devicesPayload();
  }

}

ThermoPlanApp.Mode = Mode;
module.exports = ThermoPlanApp;
