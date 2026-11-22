'use strict';

const { EventEmitter } = require('events');
const { Settings, DEFAULTS } = require('./model');

/**
 * « Personne à la maison » : pause de toutes les programmations.
 *
 * Source : la présence des utilisateurs Homey (ManagerUsers, propriété
 * `present`), ou un forçage par Flow (absent / présent / automatique).
 * L'absence n'est prise en compte qu'après un délai (sorties courtes),
 * le retour est immédiat.
 *
 * Événement « change » quand l'état (présent / absent) change.
 */

const Override = Object.freeze({ Auto: 'auto', Away: 'away', Home: 'home' });

function normalizeAway(input) {
  const v = input && typeof input === 'object' ? input : {};
  const delay = Math.round(Number(v.delay));
  const eco = parseFloat(v.ecoTemperature);
  return {
    enabled: v.enabled === true,
    delay: Number.isFinite(delay) ? Math.min(Math.max(delay, 0), 240) : 15, // minutes
    heating: v.heating === 'eco' ? 'eco' : 'off',
    ecoTemperature: Number.isNaN(eco) ? 16 : Math.min(Math.max(eco, 5), 25),
  };
}

class PresenceWatcher extends EventEmitter {

  constructor({ homey, api, log }) {
    super();
    this.homey = homey;
    this.api = api;
    this.log = log || (() => {});
    this.users = [];
    this.awaySince = null;
    this.lastAway = null;
  }

  async init() {
    await this.refresh();
    try {
      if (this.api && this.api.users) {
        await this.api.users.connect();
        this.api.users.on('user.update', () => this.refresh().catch((e) => this.log('présence', e.message)));
        this.api.users.on('user.create', () => this.refresh().catch((e) => this.log('présence', e.message)));
        this.api.users.on('user.delete', () => this.refresh().catch((e) => this.log('présence', e.message)));
      }
    } catch (e) {
      this.log('Abonnement à la présence impossible', e.message);
    }
  }

  async refresh() {
    try {
      const all = this.api && this.api.users ? await this.api.users.getUsers() : {};
      this.users = Object.values(all || {})
        .filter((u) => u && typeof u.present === 'boolean')
        .map((u) => ({ id: u.id, name: u.name, present: u.present }));
    } catch (e) {
      this.log('Lecture de la présence impossible', e.message);
    }
    this.emit('users', this.users);
  }

  get config() {
    return normalizeAway(this.homey.settings.get(Settings.Away));
  }

  get override() {
    const o = this.homey.settings.get(Settings.AwayOverride);
    return Object.values(Override).includes(o) ? o : Override.Auto;
  }

  /** Quelqu'un est-il présent d'après Homey ? (null si aucune information) */
  anyoneHome() {
    if (!this.users.length) return null;
    return this.users.some((u) => u.present);
  }

  /**
   * Absence active à cet instant ?
   * @returns {{active:boolean, source:string, since:number|null, pending:number|null}}
   *   pending : instant (ms) où l'absence deviendra active (délai en cours)
   */
  status(now = Date.now()) {
    const ms = now instanceof Date ? now.getTime() : now;
    const cfg = this.config;
    const o = this.override;
    let active = false;
    let source = 'presence';
    let pending = null;
    if (o === Override.Away) { active = true; source = 'flow'; } else if (o === Override.Home) { source = 'flow'; } else {
      const home = this.anyoneHome();
      if (home === false) {
        if (this.awaySince == null) this.awaySince = ms;
        const at = this.awaySince + cfg.delay * 60000;
        if (ms >= at) active = true; else pending = at;
      } else {
        this.awaySince = null;
      }
    }
    if (!cfg.enabled) { active = false; pending = null; }
    if (this.lastAway !== null && this.lastAway !== active) this.emit('change', active);
    this.lastAway = active;
    return {
      active, source, since: active ? (source === 'flow' ? null : this.awaySince) : null, pending, enabled: cfg.enabled,
    };
  }

}

module.exports = { PresenceWatcher, normalizeAway, Override };
