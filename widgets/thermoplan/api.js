'use strict';

/**
 * API du widget ThermoPlan (routes déclarées dans widget.compose.json).
 * Chaque fonction délègue à l'application.
 */
module.exports = {
  async getState({ homey, query }) {
    return homey.app.widgetState(query && query.plan ? String(query.plan) : null);
  },

  async getHistory({ homey, query }) {
    return homey.app.apiHistory(query && query.plan ? String(query.plan) : null);
  },

  async setMode({ homey, body }) {
    return homey.app.apiSetMode(body && body.mode);
  },

  async setPlanEnabled({ homey, params, body }) {
    return homey.app.apiSetPlanEnabled(params.id, !!(body && body.enabled));
  },

  async testPlan({ homey, params, body }) {
    return homey.app.apiTestPlan(params.id, { value: body && body.value });
  },

  async applyPlan({ homey, params }) {
    return homey.app.apiApplyPlan(params.id);
  },

  async applyAll({ homey }) {
    return homey.app.apiApplyAll();
  },
};
