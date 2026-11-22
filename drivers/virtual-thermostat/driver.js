'use strict';

const Homey = require('homey');
const { PlanType } = require('../../lib/model');

/**
 * Thermostat virtuel : un appareil Homey par programme de chauffage ou de
 * climatisation. Il permet de forcer manuellement la température d'un
 * programme (jusqu'à minuit ou en permanence) depuis l'application Homey.
 */
class VirtualThermostatDriver extends Homey.Driver {

  async onInit() {
    this.overrideChanged = this.homey.flow.getDeviceTriggerCard('thermostat_override_changed');

    this.homey.flow.getActionCard('set_thermostat_override')
      .registerRunListener(async ({ device, mode }) => {
        await device.changeThermostatMode(Number(mode));
      });

    this.homey.flow.getConditionCard('thermostat_override_is')
      .registerRunListener(async ({ device, mode }) => String(device.getCapabilityValue('thermostat_override')) === String(mode));
  }

  async triggerOverrideChanged(device, mode) {
    await this.overrideChanged.trigger(device, { mode: this.homey.__(`thermostat_mode.${mode}`) })
      .catch(this.error);
  }

  async onPairListDevices() {
    const { app } = this.homey;
    return app.repository.getAll()
      .filter((p) => p.type === PlanType.Heating || p.type === PlanType.Cooling)
      .map((p) => ({
        name: this.homey.__('device.pair', { name: p.name }),
        data: { id: p.id },
        icon: p.type === PlanType.Cooling ? '/cooling.svg' : '/heating.svg',
      }));
  }

}

module.exports = VirtualThermostatDriver;
