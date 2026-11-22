'use strict';

const Homey = require('homey');
const { ThermostatMode, ActionKind } = require('../../lib/model');

class VirtualThermostatDevice extends Homey.Device {

  async onInit() {
    this.planId = this.getData().id;
    this.app = this.homey.app;
    this.controller = this.app.controller;
    this.repository = this.app.repository;

    this.registerCapabilityListener('target_temperature', this.debounce(this.onTargetTemperature.bind(this)));
    this.registerCapabilityListener('thermostat_override', async (value) => {
      await this.changeThermostatMode(Number(value), false);
    });

    this.onRepoChanged = (plans) => {
      if (plans.some((p) => p.id === this.planId)) this.refresh().catch(this.error);
    };
    this.onApplied = () => this.refresh().catch(this.error);
    this.onMeasure = () => this.refreshTemperature().catch(this.error);
    this.onThermostatReset = (id) => {
      if (id === this.planId) this.refresh().catch(this.error);
    };

    this.repository.on('changed', this.onRepoChanged);
    this.controller.on('applied', this.onApplied);
    this.controller.on('mode', this.onApplied);
    this.controller.on('season', this.onApplied);
    this.controller.on('thermostat', this.onThermostatReset);
    this.app.devices.on('measure', this.onMeasure);

    await this.refresh();
  }

  async onDeleted() {
    this.cleanup();
  }

  async onUninit() {
    this.cleanup();
  }

  cleanup() {
    if (!this.repository) return;
    this.repository.removeListener('changed', this.onRepoChanged);
    this.controller.removeListener('applied', this.onApplied);
    this.controller.removeListener('mode', this.onApplied);
    this.controller.removeListener('season', this.onApplied);
    this.controller.removeListener('thermostat', this.onThermostatReset);
    this.app.devices.removeListener('measure', this.onMeasure);
  }

  debounce(fn, ms = 3000) {
    let timer = null;
    let lastValue;
    return async (value) => {
      lastValue = value;
      if (timer) this.homey.clearTimeout(timer);
      timer = this.homey.setTimeout(() => {
        timer = null;
        fn(lastValue).catch(this.error);
      }, ms);
    };
  }

  get plan() {
    return this.repository.find(this.planId);
  }

  async setIfChanged(cap, value) {
    if (value == null || this.getCapabilityValue(cap) === value) return false;
    await this.setCapabilityValue(cap, value);
    return true;
  }

  async refresh() {
    const plan = this.plan;
    if (!plan) {
      await this.setUnavailable(this.homey.__('device.plan_removed'));
      return;
    }
    if (!this.getAvailable()) await this.setAvailable();

    const status = this.controller.planStatus(plan);
    const mode = plan.enabled ? (plan.thermostatMode || ThermostatMode.Automatic) : ThermostatMode.FullManual;
    if (await this.setIfChanged('thermostat_override', String(mode))) {
      await this.driver.triggerOverrideChanged(this, mode);
    }

    if (status.action && status.action.kind === ActionKind.Temperature) {
      await this.setIfChanged('target_temperature', status.action.value);
    }
    await this.refreshTemperature(status);
  }

  async refreshTemperature(status) {
    const plan = this.plan;
    if (!plan) return;
    const s = status || this.controller.planStatus(plan);
    if (typeof s.temperature === 'number') await this.setIfChanged('measure_temperature', s.temperature);
  }

  /** Consigne modifiée depuis l'application Homey. */
  async onTargetTemperature(value) {
    const plan = this.plan;
    if (!plan) return;
    this.log(`Consigne manuelle ${value}`);

    if (plan.thermostatMode !== ThermostatMode.FullManual) {
      this.repository.patch(plan.id, { thermostatMode: ThermostatMode.OverrideDay }, { notify: false });
      if (await this.setIfChanged('thermostat_override', String(ThermostatMode.OverrideDay))) {
        await this.driver.triggerOverrideChanged(this, ThermostatMode.OverrideDay);
      }
    }
    await this.controller.setManualTemperature(plan, value);
  }

  /** Changement du mode du thermostat (automatique / jusqu'à minuit / manuel). */
  async changeThermostatMode(mode, updateCapability = true) {
    const plan = this.plan;
    if (!plan) return;
    if (![ThermostatMode.Automatic, ThermostatMode.OverrideDay, ThermostatMode.FullManual].includes(mode)) {
      throw new Error('mode');
    }
    this.log(`Mode du thermostat ${mode}`);
    const changes = { thermostatMode: mode };
    // repasser en automatique réactive un plan désactivé
    if (mode === ThermostatMode.Automatic && !plan.enabled) changes.enabled = true;
    this.repository.patch(plan.id, changes); // notifie le contrôleur, qui réapplique si besoin
    if (updateCapability) await this.setIfChanged('thermostat_override', String(mode));
    await this.driver.triggerOverrideChanged(this, mode);
  }

}

module.exports = VirtualThermostatDevice;
