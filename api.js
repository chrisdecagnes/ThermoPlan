'use strict';

/**
 * API Web de l'application (SDK 3). Les routes sont déclarées dans
 * .homeycompose/app.json (section « api »).
 */
module.exports = {
  async getState({ homey }) {
    return homey.app.apiState();
  },

  async getHistory({ homey, query }) {
    return homey.app.apiHistory(query && query.plan);
  },

  async getPlans({ homey }) {
    return homey.app.apiPlans();
  },

  async getPlan({ homey, params }) {
    return homey.app.apiPlan(params.id);
  },

  async newPlan({ homey, query }) {
    return homey.app.apiNewPlan(query.type, query.name);
  },

  async putPlan({ homey, params, body }) {
    return homey.app.apiSavePlan(params.id, body);
  },

  async deletePlan({ homey, params }) {
    return homey.app.apiDeletePlan(params.id);
  },

  async putPlans({ homey, body }) {
    return homey.app.apiReplacePlans(body);
  },

  async putMode({ homey, body }) {
    return homey.app.apiSetMode(body.mode);
  },

  async putSeason({ homey, body }) {
    return homey.app.apiSetSeason(body.season);
  },

  async testPlan({ homey, params, body }) {
    return homey.app.apiTestPlan(params.id, body);
  },

  async applyPlan({ homey, params }) {
    return homey.app.apiApplyPlan(params.id);
  },

  async applyAll({ homey }) {
    return homey.app.apiApplyAll();
  },

  async getDevices({ homey, query }) {
    if (query && query.refresh === '1') return homey.app.apiRefreshDevices();
    return homey.app.apiDevices();
  },
};
