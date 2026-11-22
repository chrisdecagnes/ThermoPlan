'use strict';

/**
 * Serveur du banc d'essai : sert la page de réglages et le widget avec un
 * objet « Homey » simulé branché sur la vraie application (bench/sim.js).
 *
 *   node bench/server.js [port] [langue]    → http://localhost:8123/settings/  et  /widget/
 *
 * Widget : /widget/?plan=<id>&chart=0&header=0&day=0&disabled=0
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { startApp, ROOT } = require('./sim');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
};

function compile(defs) {
  return Object.entries(defs).map(([name, d]) => {
    const keys = [];
    const re = new RegExp(`^${d.path.replace(/:(\w+)/g, (m, k) => { keys.push(k); return '([^/]+)'; })}$`);
    return {
      name, method: d.method, re, keys,
    };
  });
}

/** Script injecté : objet Homey de la page de réglages (style callback). */
const SETTINGS_SHIM = (lang) => `
(function () {
  var dict = null;
  function call(method, p, body) {
    return fetch('/api/app' + p, { method: method, headers: { 'content-type': 'application/json' }, body: body == null ? undefined : JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || r.status); return j.result; }); });
  }
  function tr(key) { var n = key.split('.').reduce(function (o, k) { return o ? o[k] : undefined; }, dict); return typeof n === 'string' ? n : null; }
  var Homey = {
    __: function (k) { return tr(k); },
    api: function (m, p, b, cb) { call(m, p, b).then(function (r) { cb(null, r); }, function (e) { cb(e); }); },
    get: function (k, cb) { fetch('/bench/setting?key=' + encodeURIComponent(k)).then(function (r) { return r.json(); }).then(function (j) { cb(null, j.value); }, cb); },
    set: function (k, v, cb) { fetch('/bench/setting?key=' + encodeURIComponent(k), { method: 'PUT', body: JSON.stringify({ value: v }) }).then(function () { cb && cb(null); }, cb); },
    confirm: function (msg, icon, cb) { cb(null, true); },
    alert: function (msg, icon, cb) { cb && cb(null); },
    on: function () {},
    ready: function () { window.__benchReady = true; },
  };
  fetch('/locales/${lang}.json').then(function (r) { return r.json(); }).then(function (j) {
    dict = j;
    var go = function () { window.onHomeyReady && window.onHomeyReady(Homey); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else setTimeout(go, 0);
  });
}());`;

/** Script injecté : objet Homey du widget (style promesses). */
const WIDGET_SHIM = (lang, settings) => `
(function () {
  var dict = null;
  function tr(key) { var n = key.split('.').reduce(function (o, k) { return o ? o[k] : undefined; }, dict); return typeof n === 'string' ? n : null; }
  var Homey = {
    __: function (k) { return tr(k); },
    getSettings: function () { return ${JSON.stringify(settings)}; },
    api: function (m, p, b) {
      return fetch('/api/widget' + p, { method: m, headers: { 'content-type': 'application/json' }, body: b == null ? undefined : JSON.stringify(b) })
        .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || r.status); return j.result; }); });
    },
    on: function () {},
    hapticFeedback: function () {},
    setHeight: function (h) { window.__benchHeight = h; },
    ready: function (o) { window.__benchHeight = o && o.height; window.__benchReady = true; },
  };
  fetch('/locales/${lang}.json').then(function (r) { return r.json(); }).then(function (j) {
    dict = j;
    var go = function () { window.onHomeyReady && window.onHomeyReady(Homey); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else setTimeout(go, 0);
  });
}());`;

async function startServer({ port = 0, lang = 'fr', appOptions = {} } = {}) {
  const sim = await startApp({ lang, ...appOptions });
  const appApi = require(path.join(ROOT, 'api.js'));
  const widgetApi = require(path.join(ROOT, 'widgets/thermoplan/api.js'));
  const appRoutes = compile(require(path.join(ROOT, 'app.json')).api);
  const widgetDefs = JSON.parse(fs.readFileSync(path.join(ROOT, 'widgets/thermoplan/widget.compose.json'), 'utf8')).api;
  const widgetRoutes = compile(widgetDefs);

  const send = (res, code, type, data) => { res.writeHead(code, { 'content-type': type }); res.end(data); };
  const sendFile = (res, file, inject) => {
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'text/plain', 'not found');
    let data = fs.readFileSync(file);
    if (inject) data = Buffer.from(String(data).replace(/<head>/i, `<head><script>${inject}</script>`));
    return send(res, 200, TYPES[path.extname(file)] || 'application/octet-stream', data);
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      const body = raw ? JSON.parse(raw) : undefined;
      const query = Object.fromEntries(url.searchParams);
      try {
        const m = /^\/api\/(app|widget)(\/.*)$/.exec(url.pathname);
        if (m) {
          const routes = m[1] === 'app' ? appRoutes : widgetRoutes;
          const impl = m[1] === 'app' ? appApi : widgetApi;
          const r = routes.find((x) => x.method === req.method && x.re.test(m[2]));
          if (!r) return send(res, 404, 'application/json', JSON.stringify({ error: 'route' }));
          const vals = r.re.exec(m[2]).slice(1);
          const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(vals[i])]));
          try {
            const result = await impl[r.name]({
              homey: sim.homey, params, query, body,
            });
            return send(res, 200, 'application/json', JSON.stringify({ result: result === undefined ? null : result }));
          } catch (e) {
            return send(res, 500, 'application/json', JSON.stringify({ error: e.message }));
          }
        }
        if (url.pathname === '/bench/setting') {
          if (req.method === 'PUT') { sim.homey.settings.set(query.key, body.value); return send(res, 200, 'application/json', '{}'); }
          return send(res, 200, 'application/json', JSON.stringify({ value: sim.homey.settings.get(query.key) }));
        }
        if (url.pathname === '/homey.js') return send(res, 200, 'text/javascript', '/* remplacé par le banc d’essai */');
        if (url.pathname.startsWith('/locales/')) return sendFile(res, path.join(ROOT, url.pathname));
        if (url.pathname.startsWith('/settings/')) {
          const f = path.join(ROOT, url.pathname.endsWith('/') ? `${url.pathname}index.html` : url.pathname);
          return sendFile(res, f, f.endsWith('index.html') ? SETTINGS_SHIM(lang) : null);
        }
        if (url.pathname.startsWith('/widget/')) {
          const rel = url.pathname.slice('/widget/'.length) || 'index.html';
          const f = path.join(ROOT, 'widgets/thermoplan/public', rel);
          const settings = {
            plan: query.plan ? { id: query.plan } : null,
            show_header: query.header !== '0',
            show_day: query.day !== '0',
            show_chart: query.chart !== '0',
            show_disabled: query.disabled !== '0',
          };
          return sendFile(res, f, rel === 'index.html' ? WIDGET_SHIM(lang, settings) : null);
        }
        if (url.pathname.startsWith('/assets/')) return sendFile(res, path.join(ROOT, url.pathname));
        return send(res, 404, 'text/plain', 'not found');
      } catch (e) {
        return send(res, 500, 'text/plain', e.stack);
      }
    });
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, sim,
    close: async () => { server.close(); await sim.stop(); },
  };
}

module.exports = { startServer };

if (require.main === module) {
  const port = Number(process.argv[2] || 8123);
  const lang = process.argv[3] || 'fr';
  startServer({ port, lang }).then(({ base }) => {
    console.log(`Banc d'essai ThermoPlan (${lang}) : ${base}/settings/  —  ${base}/widget/`);
  });
}
