'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { startApp } = require('../bench/sim');

// La vraie classe App (app.js) démarrée sur le Homey simulé du banc d'essai.
test('app.js démarre et applique les programmes sur le Homey simulé', async () => {
  const sim = await startApp({ lang: 'fr' });
  try {
    const st = sim.app.widgetState(null);
    assert.strictEqual(st.plans.length, 4);
    assert.strictEqual(st.season, 'heating');
    // les deux programmes de chauffage ont écrit une consigne
    const ids = sim.api.writes.filter((w) => w[1] === 'target_temperature').map((w) => w[0]).sort();
    assert.deepStrictEqual(ids, ['daikin', 'radiateur']);
    // routes de l'API web
    const api = require('../api');
    const plans = await api.getPlans({ homey: sim.homey });
    assert.strictEqual(plans.length, 4);
    const hist = await api.getHistory({ homey: sim.homey, query: { plan: 'p-salon' } });
    assert.ok(hist && Array.isArray(hist.points) && hist.points.length > 100);
  } finally {
    await sim.stop();
  }
});
