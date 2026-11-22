/* global window, document */
/* eslint-disable no-alert */
'use strict';

(function () {
  let H = null; // objet Homey de la page de réglages
  const state = {
    status: null,
    devices: [],
    zones: [],
    sensors: [],
    plans: [],
    plan: null, // plan en cours d'édition (copie)
    history: null, // graphique 24 h
    chartPlan: null,
    isNew: false,
  };

  const MODE_IDS = [0, 1, 2, 3, 4, 5];
  const SEASON_SETTINGS = ['auto', 'outdoor', 'heating', 'cooling', 'off'];
  const OVERRIDE_KEYS = [['DayAtHome', 1], ['DayAway', 2], ['Sleep', 3], ['Holiday', 4], ['OutOfSeason', 5]];
  const ICON = { heating: '🔥', cooling: '❄️', fan: '🌀' };

  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs = {}, children = []) => {
    const e = document.createElement(tag);
    Object.entries(attrs).forEach(([k, v]) => {
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v === true) e.setAttribute(k, '');
      else if (v !== false && v != null) e.setAttribute(k, v);
    });
    (Array.isArray(children) ? children : [children]).forEach((c) => {
      if (c == null) return;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return e;
  };

  function __(key, tokens) {
    let s = H ? H.__(key) : key;
    if (!s) s = key;
    if (tokens) Object.keys(tokens).forEach((k) => { s = s.split(`__${k}__`).join(tokens[k]); });
    return s;
  }

  function api(method, path, body) {
    return new Promise((resolve, reject) => {
      H.api(method, path, body || null, (err, result) => (err ? reject(err) : resolve(result)));
    });
  }

  function hget(key) {
    return new Promise((resolve, reject) => {
      H.get(key, (err, v) => (err ? reject(err) : resolve(v)));
    });
  }

  function hset(key, value) {
    return new Promise((resolve, reject) => {
      H.set(key, value, (err) => (err ? reject(err) : resolve()));
    });
  }

  let toastTimer = null;
  function toast(msg, isError) {
    const t = $('toast');
    t.textContent = msg;
    t.className = `toast${isError ? ' error' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), isError ? 6000 : 2500);
  }

  function errorMessage(e) {
    return (e && (e.message || e.toString())) || 'Erreur';
  }

  function translatePage() {
    document.querySelectorAll('[data-i18n]').forEach((n) => {
      const v = __(n.getAttribute('data-i18n'));
      if (v && v !== n.getAttribute('data-i18n')) n.textContent = v;
    });
  }

  // Virgule décimale pour fr, nl et de (point seulement en anglais).
  const commaLocale = () => !/^en/.test((H && H.__('settings.locale')) || 'fr-FR');
  const num = (v) => (typeof v === 'number' ? String(v).replace('.', commaLocale() ? ',' : '.') : '–');

  function formatDate(iso) {
    if (!iso) return '–';
    try {
      return new Date(iso).toLocaleString(H.__('settings.locale') || 'fr-FR', {
        timeZone: state.status ? state.status.timezone : undefined,
        weekday: 'long', hour: '2-digit', minute: '2-digit',
      });
    } catch (e) {
      return iso;
    }
  }

  function describeAction(a) {
    if (!a) return '–';
    if (a.kind === 'temperature') return `${a.value}°`;
    if (a.kind === 'fan') return a.speed > 0 ? describeValue('fan', { fanSpeed: a.speed, fan: a.mode }) : __('settings.common.off');
    return __('settings.common.off');
  }

  function supports(d, type) {
    if (type === 'fan') return d.fan;
    if (type === 'cooling') return d.ac || (d.thermostat && d.class !== 'heater');
    return d.thermostat;
  }

  // ===================================================================== Onglets
  function showTab(name, skipLoad) {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    ['overview', 'plans', 'options'].forEach((n) => $(`tab-${n}`).classList.toggle('hidden', n !== name));
    if (name !== 'plans') $('tp').className = '';
    if (skipLoad) return;
    if (name === 'overview') loadOverview();
    if (name === 'plans') showPlanList();
    if (name === 'options') loadOptions();
  }

  // ===================================================================== Aperçu
  async function loadOverview() {
    try {
      const [st, plans, hist] = await Promise.all([
        api('GET', '/state'), api('GET', '/plans'), api('GET', '/history').catch(() => null),
      ]);
      state.status = st;
      state.plans = plans || [];
      state.history = hist;
      renderOverview();
      renderChart();
    } catch (e) {
      toast(errorMessage(e), true);
    }
  }

  function renderOutdoor(s) {
    const box = $('outdoor-info');
    const o = s.outdoor;
    box.classList.toggle('hidden', s.seasonSetting !== 'outdoor');
    if (s.seasonSetting !== 'outdoor') return;
    if (!o || !o.sensorId) box.textContent = __('settings.overview.outdoor_none');
    else if (typeof o.average !== 'number') box.textContent = __('settings.overview.outdoor_wait');
    else {
      box.textContent = __('settings.overview.outdoor', {
        sensor: o.sensorName || '?', value: num(o.value), hours: o.hours, average: num(o.average),
      });
    }
  }

  /** Plages du jour d'un programme (pour la mini-barre). */
  function todayRuns(plan, s) {
    if (!plan || !s || s.localDay == null) return { runs: [], base: null };
    const sb = Array.isArray(plan.slots) ? { slots: plan.slots, base: plan.base } : S.fromSchedule(plan.type, plan.schedule);
    return { runs: S.dayRuns(plan.type, sb.slots, sb.base).filter((r) => r.day === s.localDay), base: sb.base };
  }

  /** Carte de programme (aperçu et liste) : état, valeur, interrupteur, plages du jour. */
  function planCard(plan, st, s) {
    const type = plan.type;
    const active = st && st.enabled && st.inSeason && st.source !== 'manual' && st.source !== 'away';
    const { runs } = todayRuns(plan, s);
    let sub;
    if (!plan.enabled) sub = __('settings.plan.badge_disabled');
    else if (st && st.source === 'away') sub = __('settings.plan.away_card');
    else if (st && st.windowStopped && st.windowStopped.length) sub = __('settings.plan.window_stopped', { names: st.windowStopped.join(', ') });
    else if (st && !st.inSeason) sub = `${__('settings.plan.badge_season')} · ${__('settings.plan.status_season', { season: __(`settings.plan.season_word_${type === 'heating' ? 'heating' : 'cooling'}`) })}`;
    else if (st && st.source === 'manual') sub = __(`thermostat_mode.${st.thermostatMode}`);
    else if (st && st.source && st.source.startsWith('mode:')) sub = __('settings.overview.by_mode', { mode: __(`modes.${s.mode}`) });
    else {
      const cur = runs.find((r) => r.start <= s.localMinutes && s.localMinutes < r.end);
      sub = cur ? __('widget.now_until', { value: describeValue(type, cur.value), time: S.fmt(cur.end) })
        : `${__('settings.plan.base')} · ${__('settings.overview.next_short', { date: formatDate(st && st.nextChange) })}`;
    }
    const rt = roomText(st, type);
    if (rt && plan.enabled) sub = `${sub} · ${rt}`;
    const toggle = el('input', { type: 'checkbox', class: 'switch', onclick: (ev) => ev.stopPropagation() });
    toggle.checked = plan.enabled;
    toggle.addEventListener('change', async () => {
      try {
        await api('PUT', `/plans/${encodeURIComponent(plan.id)}`, { ...plan, enabled: toggle.checked });
        toast(__('settings.plans.saved'));
        if (!$('tab-overview').classList.contains('hidden')) loadOverview(); else showPlanList();
      } catch (e) {
        toggle.checked = !toggle.checked;
        toast(errorMessage(e), true);
      }
    });

    const track = el('div', { class: 'track' });
    runs.forEach((r) => {
      const off = type === 'fan' ? !(r.value.fanSpeed > 0) : !!r.value.off;
      track.appendChild(el('div', {
        class: `seg${off ? ' dim' : ''}`,
        style: `left:${(r.start / 1440) * 100}%;width:${((r.end - r.start) / 1440) * 100}%`,
      }));
    });
    if (s && typeof s.localMinutes === 'number') track.appendChild(el('div', { class: 'now', style: `left:${(s.localMinutes / 1440) * 100}%` }));
    const axis = el('div', { class: 'axis' }, ['0h', '6h', '12h', '18h', '24h'].map((x) => el('span', { text: x })));

    return el('div', { class: `pcard ${type}${active ? '' : ' dimmed'}`, onclick: () => { showTab('plans', true); openPlan(plan.id); } }, [
      el('div', { class: 'top' }, [
        el('span', { class: 'badge', text: ICON[type] }),
        el('div', { class: 'main' }, [el('div', { class: 'name', text: plan.name }), el('div', { class: 'sub', text: sub })]),
        active && st.action ? el('div', { class: 'big', text: st.action.kind === 'temperature' ? fmtTemp(st.action.value) : describeAction(st.action) }) : null,
        toggle,
      ]),
      el('div', { class: 'daybar' }, [track, axis]),
    ]);
  }

  function renderOverview() {
    const s = state.status;
    const modes = $('mode-chips');
    modes.innerHTML = '';
    MODE_IDS.forEach((m) => modes.appendChild(el('button', {
      class: `chip${s.mode === m ? ' sel' : ''}`,
      text: __(`modes.${m}`),
      onclick: async () => {
        try {
          await api('PUT', '/mode', { mode: m });
          await loadOverview();
        } catch (e) { toast(errorMessage(e), true); }
      },
    })));

    const seasons = $('season-chips');
    seasons.innerHTML = '';
    const SEASON_ICON = { auto: '📅', outdoor: '🌡️', heating: '🔥', cooling: '☀️', off: '🌤️' };
    SEASON_SETTINGS.forEach((v) => seasons.appendChild(el('button', {
      class: `chip${s.seasonSetting === v ? ' sel' : ''}`,
      text: `${SEASON_ICON[v]} ${__(`settings.season_short.${v}`)}`,
      title: __(`settings.season_setting.${v}`),
      onclick: async () => {
        try {
          state.status = await api('PUT', '/season', { season: v });
          await loadOverview();
        } catch (e) { toast(errorMessage(e), true); }
      },
    })));

    $('season-info').textContent = __('settings.overview.season_now', { season: __(`seasons.${s.season}`), time: s.localTime });
    renderOutdoor(s);
    const aw = s.away || {};
    const awayBox = $('away-info');
    let awayText = '';
    if (aw.active) awayText = aw.source === 'flow' ? __('settings.overview.away_forced') : __('settings.overview.away_active');
    else if (aw.pending) awayText = __('settings.overview.away_pending', { time: formatDate(new Date(aw.pending).toISOString()) });
    awayBox.textContent = awayText;
    awayBox.classList.toggle('hidden', !awayText);
    $('next-info').textContent = __('settings.overview.next', { date: formatDate(s.nextChange) });
    $('app-version').textContent = s.version ? `ThermoPlan v${s.version}` : '';
    $('tp').className = `type-${s.season === 'cooling' ? 'cooling' : 'heating'}`;

    const box = $('overview-plans');
    box.innerHTML = '';
    if (!state.plans.length) box.appendChild(el('div', { class: 'card empty-state', text: __('settings.plans.empty') }));
    sortPlans(state.plans).forEach((p) => box.appendChild(planCard(p, s.plans.find((x) => x.id === p.id), s)));

    const devs = $('overview-devices');
    devs.innerHTML = '';
    if (!s.devices.length) devs.appendChild(el('div', { class: 'card empty-state', text: __('settings.overview.no_devices') }));
    s.devices.forEach((d) => {
      const type = d.fan ? 'fan' : (d.ac ? 'cooling' : 'heating');
      let value = '';
      if (d.thermostat) value = d.onoff === false ? __('settings.common.off') : `${d.targetTemperature != null ? fmtTemp(d.targetTemperature) : '–'}`;
      else if (d.fan) value = d.onoff ? __('settings.common.on') : __('settings.common.off');
      const measured = typeof d.temperature === 'number' ? `${fmtTemp(d.temperature)} · ` : '';
      devs.appendChild(el('div', { class: `item ${type}` }, [
        el('span', { class: `badge${d.available ? '' : ' off'}`, text: ICON[type] }),
        el('div', { class: 'main' }, [
          el('div', { class: 'title', text: d.name }),
          el('div', { class: 'sub', text: `${measured}${d.zoneName || ''}${d.thermostatMode ? ` · ${d.thermostatMode}` : ''}` }),
        ]),
        el('div', { class: 'value', text: value }),
      ]));
    });
  }

  // ===================================================================== Graphique 24 h
  const SVGNS = 'http://www.w3.org/2000/svg';
  const svg = (tag, attrs = {}, text) => {
    const e = document.createElementNS(SVGNS, tag);
    Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v));
    if (text != null) e.textContent = text;
    return e;
  };

  /** Segments continus d'une série (coupée sur valeur absente ou trou > 2 pas). */
  function chartSegments(points, pick, step) {
    const segs = [];
    let cur = null;
    let lastT = null;
    points.forEach((pt) => {
      const v = pick(pt);
      if (typeof v !== 'number' || (lastT != null && pt.t - lastT > step * 2.5)) {
        cur = null;
      }
      if (typeof v === 'number') {
        if (!cur) { cur = []; segs.push(cur); }
        cur.push([pt.t, v]);
      }
      lastT = pt.t;
    });
    return segs;
  }

  function renderChart() {
    const h = state.history;
    const s = state.status;
    const chips = $('chart-plans');
    const box = $('chart');
    const legend = $('chart-legend');
    chips.innerHTML = '';
    box.innerHTML = '';
    legend.innerHTML = '';
    $('chart-hint').textContent = '';
    const plans = sortPlans(state.plans);
    if (!plans.length) {
      box.appendChild(el('p', { class: 'muted', text: __('settings.chart.no_plan') }));
      return;
    }
    if (!plans.some((p) => p.id === state.chartPlan)) {
      const first = plans.find((p) => p.enabled && (s.plans.find((x) => x.id === p.id) || {}).inSeason) || plans[0];
      state.chartPlan = first.id;
    }
    plans.forEach((p) => chips.appendChild(el('button', {
      class: `chip small ${p.type}${p.id === state.chartPlan ? ' sel' : ''}`,
      text: `${ICON[p.type]} ${p.name}`,
      onclick: () => { state.chartPlan = p.id; renderChart(); },
    })));
    const plan = plans.find((p) => p.id === state.chartPlan);
    $('chart-card').className = `card chart-card ${plan.type}`;
    const points = (h && h.points) || [];
    const step = (h && h.step) || 600000;
    const now = (h && h.now) || Date.now();
    const start = now - 24 * 3600000;
    const pv = (pt, i) => (pt.p && pt.p[plan.id] ? pt.p[plan.id][i] : null);
    const series = [
      { cls: 'out', label: __('settings.chart.outdoor'), segs: chartSegments(points, (pt) => pt.o, step) },
      { cls: 'set', label: __('settings.chart.setpoint'), segs: plan.type === 'fan' ? [] : chartSegments(points, (pt) => pv(pt, 1), step), stepped: true },
      { cls: 'meas', label: __('settings.chart.measured'), segs: chartSegments(points, (pt) => pv(pt, 0), step) },
    ];
    const values = [];
    series.forEach((se) => se.segs.forEach((sg) => sg.forEach(([, v]) => values.push(v))));
    if (!values.length) {
      box.appendChild(el('p', { class: 'muted', text: __('settings.chart.empty') }));
      return;
    }
    let lo = Math.floor(Math.min(...values) - 0.5);
    let hi = Math.ceil(Math.max(...values) + 0.5);
    if (hi - lo < 4) { const mid = (hi + lo) / 2; lo = Math.floor(mid - 2); hi = Math.ceil(mid + 2); }
    const W = 360; const H = 190; const L = 30; const R = 6; const T = 8; const B = 22;
    const x = (t) => L + ((t - start) / (now - start)) * (W - L - R);
    const y = (v) => T + ((hi - v) / (hi - lo)) * (H - T - B);
    const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': __('settings.chart.title') });

    // grille horizontale (pas de 1, 2 ou 5 °C)
    const gstep = [1, 2, 5, 10].find((g) => (hi - lo) / g <= 6) || 10;
    for (let v = Math.ceil(lo / gstep) * gstep; v <= hi; v += gstep) {
      root.appendChild(svg('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: 'grid' }));
      root.appendChild(svg('text', { x: L - 5, y: y(v) + 4, class: 'ylab' }, `${v}°`));
    }
    // graduations toutes les 6 h (heure locale du Homey)
    if (s && typeof s.localMinutes === 'number') {
      const hour = Math.floor(s.localMinutes / 60);
      let hh = hour - (hour % 6);
      let t = now - (s.localMinutes - hh * 60) * 60000;
      while (t >= start) {
        root.appendChild(svg('line', { x1: x(t), x2: x(t), y1: T, y2: H - B, class: 'grid v' }));
        root.appendChild(svg('text', { x: x(t), y: H - 6, class: 'xlab' }, `${hh}h`));
        t -= 6 * 3600000;
        hh = (hh + 18) % 24;
      }
    }
    // séries
    series.forEach((se) => se.segs.forEach((sg) => {
      let d = '';
      sg.forEach(([t, v], i) => {
        if (i === 0) d += `M${x(t).toFixed(1)},${y(v).toFixed(1)}`;
        else if (se.stepped) d += `H${x(t).toFixed(1)}V${y(v).toFixed(1)}`;
        else d += `L${x(t).toFixed(1)},${y(v).toFixed(1)}`;
      });
      // prolonge le dernier palier d'un pas
      const lastPt = sg[sg.length - 1];
      if (se.stepped) d += `H${x(Math.min(now, lastPt[0] + step)).toFixed(1)}`;
      if (sg.length === 1 && !se.stepped) {
        root.appendChild(svg('circle', { cx: x(lastPt[0]), cy: y(lastPt[1]), r: 2.5, class: `dot ${se.cls}` }));
      } else {
        root.appendChild(svg('path', { d, class: `line ${se.cls}` }));
      }
    }));
    // dernière mesure
    const meas = series[2].segs[series[2].segs.length - 1];
    if (meas) {
      const [t, v] = meas[meas.length - 1];
      root.appendChild(svg('circle', { cx: x(t), cy: y(v), r: 4, class: 'dot meas' }));
    }
    box.appendChild(root);
    series.slice().reverse().forEach((se) => {
      if (!se.segs.length) return;
      legend.appendChild(el('span', { class: `lg ${se.cls}` }, [el('i'), se.label]));
    });
    $('chart-hint').textContent = __('settings.chart.hint');
  }

  function sortPlans(list) {
    const order = { heating: 0, cooling: 1, fan: 2 };
    return [...list].sort((a, b) => (order[a.type] - order[b.type]) || a.name.localeCompare(b.name));
  }

  // ===================================================================== Liste des programmes
  async function loadDevices(refresh) {
    const r = await api('GET', `/devices${refresh ? '?refresh=1' : ''}`);
    state.devices = r.devices || [];
    state.zones = r.zones || [];
    state.sensors = r.sensors || [];
    state.contacts = r.contacts || [];
  }

  async function showPlanList() {
    $('plan-list-view').classList.remove('hidden');
    $('plan-edit-view').classList.add('hidden');
    $('tp').className = '';
    try {
      const [st, plans] = await Promise.all([api('GET', '/state'), api('GET', '/plans')]);
      state.status = st;
      state.plans = plans || [];
    } catch (e) {
      toast(errorMessage(e), true);
      return;
    }
    const list = $('plan-list');
    list.innerHTML = '';
    if (!state.plans.length) list.appendChild(el('div', { class: 'card empty-state', text: __('settings.plans.empty') }));
    sortPlans(state.plans).forEach((p) => list.appendChild(planCard(p, state.status.plans.find((x) => x.id === p.id), state.status)));
  }

  async function newPlan(type) {
    try {
      const name = __(`settings.plans.default_name_${type}`);
      const plan = await api('GET', `/new-plan?type=${type}&name=${encodeURIComponent(name)}`);
      await openEditor(plan, true);
    } catch (e) {
      toast(errorMessage(e), true);
    }
  }

  async function openPlan(id) {
    try {
      const plan = await api('GET', `/plans/${encodeURIComponent(id)}`);
      await openEditor(plan, false);
    } catch (e) {
      toast(errorMessage(e), true);
    }
  }

  // ===================================================================== Éditeur (plages horaires)
  const S = window.ThermoSlots;
  // initiale du jour dans la langue de Homey (L M M J V S D, M D M D F S S…)
  const dayLetter = (d) => (__(`settings.days_short.${d}`) || '?').charAt(0).toUpperCase();
  // libellé court du graphique : « lun », « mon » ; « Mo », « Di » en allemand / néerlandais
  const dayLabel = (d) => (/^(fr|en)/.test(__('settings.locale') || 'fr')
    ? __(`settings.days.${d}`).slice(0, 3).toLowerCase()
    : __(`settings.days_short.${d}`));
  let dirty = false;

  function markDirty() {
    dirty = true;
    $('dirty').classList.remove('hidden');
  }

  function clearDirty() {
    dirty = false;
    $('dirty').classList.add('hidden');
  }

  function fmtTemp(v) {
    const n = Number(v);
    const s = Number.isInteger(n) ? String(n) : n.toFixed(1);
    return `${(commaLocale() ? s.replace('.', ',') : s)}°`;
  }

  function describeValue(type, v) {
    if (!v) return '–';
    if (type === 'fan') {
      if (v.fan === 'auto' || v.fan === 'quiet') return __(`settings.plan.ac_fan_${v.fan}`);
      if (v.off || !v.fanSpeed) return __('settings.common.off');
      const n = Math.max(0, ...(state.devices || []).filter((d) => d.fan).map((d) => d.acFanLevels || 0));
      return n > 0 ? `🌀${Math.max(1, Math.ceil(v.fanSpeed * n - 0.05))}` : `${Math.round(v.fanSpeed * 100)} %`;
    }
    if (v.off) return __('settings.common.off');
    return fmtTemp(v.targetTemperature) + fanSuffix(v);
  }

  function fanSuffix(v) {
    if (v.fan === undefined) return '';
    if (v.fan === 'auto') return ' · 🌀A';
    if (v.fan === 'quiet') return ' · 🌀🤫';
    const devs = (state.devices || []).filter((d) => d.acFanLevels > 0);
    const n = Math.max(2, ...devs.map((d) => d.acFanLevels));
    return ` · 🌀${Math.round(v.fan * (n - 1)) + 1}`;
  }

  /** Conversion d'une valeur lors d'un changement de type de programme. */
  function convertValue(v, from, to, isBase) {
    const on = from === 'fan' ? v.fanSpeed > 0 : !v.off;
    if (to === 'fan') return { fanSpeed: on ? (from === 'fan' ? v.fanSpeed : 0.6) : 0 };
    if (!on) return to === 'cooling' ? { off: true } : { targetTemperature: 17 };
    if (from === 'fan') return { targetTemperature: to === 'cooling' ? 26 : (isBase ? 17 : 20) };
    return { targetTemperature: v.targetTemperature };
  }

  async function openEditor(plan, isNew) {
    if (!state.devices.length) {
      try { await loadDevices(true); } catch (e) { toast(errorMessage(e), true); }
    }
    try { state.status = await api('GET', '/state'); } catch (e) { /* état indisponible */ }
    const p = JSON.parse(JSON.stringify(plan));
    p.overrides = p.overrides || {};
    if (!Array.isArray(p.slots)) {
      // programme créé avec une version précédente : conversion en plages
      const conv = S.fromSchedule(p.type, p.schedule);
      p.slots = conv.slots;
      p.base = conv.base;
    }
    p.base = S.cleanValue(p.type, p.base) || S.defaultBase(p.type);
    state.plan = p;
    state.isNew = isNew;
    $('plan-list-view').classList.add('hidden');
    $('plan-edit-view').classList.remove('hidden');

    $('p-name').value = p.name;
    $('p-type').value = p.type;
    $('p-enabled').checked = p.enabled;
    $('p-off').checked = p.offOutOfSeason !== false;
    $('p-desc').value = p.description || '';
    $('plan-delete').classList.toggle('hidden', isNew);
    $('plan-clone').classList.toggle('hidden', isNew);
    clearDirty();
    if (isNew) markDirty();
    renderEditor();
    window.scrollTo(0, 0);
  }

  function renderEditor() {
    const p = state.plan;
    $('plan-edit-view').className = `type-${p.type}`;
    $('p-icon').className = `badge ${p.type}`;
    $('p-icon').textContent = ICON[p.type];
    $('p-off-row').classList.toggle('hidden', p.type === 'heating');
    renderStatus();
    renderPeriod();
    renderBase();
    renderSlots();
    renderWeek();
    renderWindow();
    renderRoom();
    renderOverrides();
    renderTargets();
  }

  function renderStatus() {
    const p = state.plan;
    const badge = $('p-badge');
    const text = $('p-status');
    const st = state.status && state.status.plans.find((x) => x.id === p.id);
    let cls = '';
    let label;
    let msg = '';
    if (state.isNew || !st) {
      label = __('settings.plan.badge_new');
      msg = __('settings.plan.status_new');
    } else if (!st.enabled) {
      label = __('settings.plan.badge_disabled');
      msg = __('settings.plan.status_disabled');
    } else if (!st.inSeason) {
      label = __('settings.plan.badge_season');
      msg = __('settings.plan.status_season', { season: __(`settings.plan.season_word_${p.type === 'heating' ? 'heating' : 'cooling'}`) });
    } else if (st.source === 'away') {
      cls = 'manual';
      label = __('settings.plan.badge_away');
      msg = __('settings.plan.status_away');
    } else if (st.windowStopped && st.windowStopped.length) {
      cls = 'manual';
      label = __('settings.plan.window_title');
      msg = __('settings.plan.window_stopped', { names: st.windowStopped.join(', ') });
    } else if (st.source === 'manual') {
      cls = 'manual';
      label = __('settings.plan.badge_manual');
      msg = __('settings.plan.status_manual', { mode: __(`thermostat_mode.${st.thermostatMode}`) });
    } else {
      cls = 'active';
      label = __('settings.plan.badge_active');
      const a = st.action;
      const now = !a ? '–' : (a.kind === 'temperature' ? fmtTemp(a.value) : describeAction(a));
      msg = __('settings.plan.status_active', { value: now, date: formatDate(st.nextChange) });
    }
    const rt = roomText(st, p.type);
    if (rt) msg = msg ? `${msg} · ${rt}` : rt;
    badge.className = `pill ${cls}`;
    badge.textContent = label;
    text.textContent = msg;

    // boutons de test
    const slotValue = currentSlotValue() || (p.slots[0] && p.slots[0].value);
    $('t-on').classList.toggle('hidden', !slotValue);
    if (slotValue) $('t-on').textContent = __('settings.plan.test_on', { value: describeValue(p.type, slotValue) });
    $('t-off').textContent = __('settings.plan.test_off', { value: describeValue(p.type, p.base) });
  }

  /** Valeur de la plage active à l'heure du Homey (ou null). */
  function currentSlotValue() {
    const s = state.status;
    if (!s || s.localDay == null) return null;
    const p = state.plan;
    const run = S.dayRuns(p.type, p.slots, p.base)
      .find((r) => r.day === s.localDay && r.start <= s.localMinutes && s.localMinutes < r.end);
    return run ? run.value : null;
  }

  function renderPeriod() {
    const p = state.plan;
    const box = $('p-period');
    box.innerHTML = '';
    const seasonKey = p.type === 'heating' ? 'heating' : 'cooling';
    [['default', __(`settings.plan.period_season_${seasonKey}`)], ['always', `🗓️ ${__('settings.plan.period_always')}`]].forEach(([v, label]) => {
      box.appendChild(el('button', {
        class: `chip${(p.season || 'default') === v ? ' sel' : ''}`,
        text: label,
        onclick: () => { p.season = v; markDirty(); renderPeriod(); },
      }));
    });
    const current = state.status ? __(`settings.plan.season_word_${state.status.season}`) : '?';
    $('p-period-text').textContent = (p.season || 'default') === 'always'
      ? __('settings.plan.period_text_always')
      : __('settings.plan.period_text_season', { season: __(`settings.plan.season_word_${seasonKey}`), current });
  }

  /** Sélecteur de valeur : température (− / +, arrêt possible) ou vitesse. */
  function stepper(target, type, onChange, allowOff) {
    const wrap = el('div', { class: 'stepper' });
    const changed = () => { markDirty(); if (onChange) onChange(); };
    if (type === 'fan') {
      const info = fanInfo();
      const mode = (m) => target.fan === m;
      const setLevel = (speed, m) => {
        target.fanSpeed = speed;
        delete target.off;
        if (m) target.fan = m; else delete target.fan;
        changed();
        redraw();
      };
      const redraw = () => {
        wrap.innerHTML = '';
        if (info.levels > 0) {
          // ventilateur à vitesses : Arrêt, 1…N, Auto, Silence
          const n = info.levels;
          const cur = target.fan ? null : Math.ceil((target.fanSpeed || 0) * n - 0.05);
          const chips = el('div', { class: 'chips' });
          const add = (label, sel, fn) => chips.appendChild(el('button', { class: `chip small${sel ? ' sel' : ''}`, text: label, onclick: fn }));
          add(__('settings.common.off'), !target.fan && !(target.fanSpeed > 0), () => setLevel(0));
          for (let i = 1; i <= n; i++) add(String(i), cur === i, () => setLevel(Math.round((i / n) * 100) / 100));
          if (info.auto) add(__('settings.plan.ac_fan_auto'), mode('auto'), () => setLevel(1, 'auto'));
          if (info.quiet) add(__('settings.plan.ac_fan_quiet'), mode('quiet'), () => setLevel(1, 'quiet'));
          wrap.appendChild(chips);
          return;
        }
        // variateur continu : curseur en %, + Auto / Silence si l'appareil les propose
        const val = el('span', { class: 'sval' });
        const range = el('input', { type: 'range', min: 0, max: 100, step: 5 });
        range.value = Math.round((target.fanSpeed || 0) * 100);
        range.disabled = !!target.fan;
        const show = () => {
          val.textContent = target.fan ? __(`settings.plan.ac_fan_${target.fan}`) : (Number(range.value) === 0 ? __('settings.common.off') : `${range.value} %`);
          val.classList.toggle('off', !target.fan && Number(range.value) === 0);
        };
        range.addEventListener('input', () => { target.fanSpeed = Number(range.value) / 100; delete target.off; show(); });
        range.addEventListener('change', changed);
        show();
        wrap.append(range, val);
        if (info.auto || info.quiet) {
          const chips = el('div', { class: 'chips' });
          [['auto', info.auto], ['quiet', info.quiet]].forEach(([m, ok]) => {
            if (!ok) return;
            chips.appendChild(el('button', {
              class: `chip small${mode(m) ? ' sel' : ''}`,
              text: __(`settings.plan.ac_fan_${m}`),
              onclick: () => (mode(m) ? setLevel(target.fanSpeed || 0.5) : setLevel(1, m)),
            }));
          });
          wrap.appendChild(chips);
        }
      };
      redraw();
      return wrap;
    }
    const val = el('span', { class: 'sval' });
    const minus = el('button', { class: 'sbtn', text: '−', 'aria-label': '-0.5' });
    const plus = el('button', { class: 'sbtn', text: '+', 'aria-label': '+0.5' });
    const show = () => {
      val.textContent = target.off ? '' : fmtTemp(target.targetTemperature);
      [minus, val, plus].forEach((n) => n.classList.toggle('hidden', !!target.off));
    };
    const step = (d) => {
      const t = Math.round(Math.min(35, Math.max(4, (Number(target.targetTemperature) || 20) + d)) * 10) / 10;
      target.targetTemperature = t;
      show();
      changed();
    };
    minus.addEventListener('click', () => step(-0.5));
    plus.addEventListener('click', () => step(0.5));
    wrap.append(minus, val, plus);
    if (allowOff) {
      const off = el('button', { class: `chip${target.off ? ' sel' : ''}`, text: __('settings.common.off') });
      off.addEventListener('click', () => {
        if (target.off) {
          delete target.off;
          if (target.targetTemperature == null) target.targetTemperature = 26;
        } else {
          target.off = true;
        }
        off.classList.toggle('sel', !!target.off);
        show();
        changed();
      });
      wrap.append(off);
    }
    if (target.targetTemperature == null && !target.off) target.targetTemperature = 20;
    show();
    return wrap;
  }

  function renderBase() {
    const p = state.plan;
    const box = $('p-base');
    box.innerHTML = '';
    box.appendChild(stepper(p.base, p.type, () => { renderWeek(); renderStatus(); }, p.type === 'cooling'));
    $('p-base-hint').textContent = __(`settings.plan.base_hint_${p.type}`);
  }

  function renderSlots() {
    const p = state.plan;
    const box = $('slots');
    box.innerHTML = '';
    const overlapping = S.overlaps(p.slots);
    if (!p.slots.length) box.appendChild(el('div', { class: 'card empty-state', text: __('settings.plan.no_slot') }));
    p.slots.forEach((slot, i) => {
      const refresh = () => { renderWeek(); renderStatus(); };
      // jours
      const days = el('div', { class: 'days7' });
      S.DAY_ORDER.forEach((d) => {
        days.appendChild(el('button', {
          class: `dchip${slot.days.includes(d) ? ' sel' : ''}`,
          text: dayLetter(d),
          title: __(`settings.days.${d}`),
          onclick: () => {
            slot.days = slot.days.includes(d) ? slot.days.filter((x) => x !== d) : [...slot.days, d];
            markDirty();
            renderSlots();
            refresh();
          },
        }));
      });
      const del = el('button', {
        class: 'icon-btn',
        text: '🗑️',
        title: __('settings.plan.slot_delete'),
        onclick: () => { p.slots.splice(i, 1); markDirty(); renderSlots(); refresh(); },
      });

      // heures (sélecteurs 24 h, indépendants de la langue du téléphone)
      const next = el('span', { class: 'next' });
      const showNext = () => {
        const s = S.toMin(slot.start);
        const e = S.toMin(slot.end);
        next.textContent = e !== 0 && e <= s ? `(${__('settings.plan.next_day')})` : '';
      };
      const onTime = (key) => (value) => {
        slot[key] = value;
        showNext();
        markDirty();
        renderSlotsWarnings();
        refresh();
      };
      const start = timePicker(slot.start, onTime('start'));
      const end = timePicker(slot.end, onTime('end'));
      showNext();

      // raccourcis de jours
      const presets = el('div', { class: 'chips' });
      [['weekdays', 'preset_weekdays'], ['weekend', 'preset_weekend'], ['all', 'preset_all']].forEach(([k, label]) => {
        const same = S.PRESETS[k].length === slot.days.length && S.PRESETS[k].every((d) => slot.days.includes(d));
        presets.appendChild(el('button', {
          class: `chip${same ? ' sel' : ''}`,
          text: __(`settings.plan.${label}`),
          onclick: () => { slot.days = [...S.PRESETS[k]]; markDirty(); renderSlots(); refresh(); },
        }));
      });

      const warn = el('p', { class: 'warn' });
      if (!slot.days.length) warn.textContent = `⚠️ ${__('settings.plan.no_day')}`;
      else if (overlapping.includes(i)) warn.textContent = `⚠️ ${__('settings.plan.overlap')}`;

      box.appendChild(el('div', { class: 'card slot', id: `slot-${i}` }, [
        el('div', { class: 'slot-top' }, [days, del]),
        el('div', { class: 'slot-time' }, [
          el('span', { text: __('settings.plan.slot_from') }), start,
          el('span', { text: __('settings.plan.slot_to') }), end, next,
        ]),
        stepper(slot.value, p.type, refresh, p.type === 'cooling'),
        acFanRow(slot.value, refresh),
        presets,
        warn.textContent ? warn : null,
      ]));
    });
  }

  /** Capacités des ventilateurs du programme édité : niveaux, auto, silence. */
  function fanInfo() {
    const devs = (state.plan ? editedDevices() : []).filter((d) => d.fan);
    return {
      levels: Math.max(0, ...devs.map((d) => d.acFanLevels || 0)),
      auto: devs.some((d) => d.acFanAuto),
      quiet: devs.some((d) => d.acFanQuiet),
    };
  }

  /** Ventilation du climatiseur pour une plage (si un appareil du programme la gère). */
  function acFanRow(value, onChange) {
    const p = state.plan;
    if (p.type === 'fan') return null;
    const devs = editedDevices().filter((d) => d.acFanLevels > 0 || d.acFanQuiet);
    if (!devs.length) {
      if (value.fan !== undefined) delete value.fan;
      return null;
    }
    const n = Math.max(2, ...devs.map((d) => d.acFanLevels || 0));
    const quiet = devs.some((d) => d.acFanQuiet);
    const box = el('div', { class: 'fanrow' });
    const draw = () => {
      box.innerHTML = '';
      box.appendChild(el('span', { class: 'muted', text: `🌀 ${__('settings.plan.ac_fan')}` }));
      const chips = el('div', { class: 'chips' });
      const cur = value.fan;
      const curLevel = typeof cur === 'number' ? Math.round(cur * (n - 1)) + 1 : null;
      const opts = [[undefined, __('settings.plan.ac_fan_keep')], ['auto', __('settings.plan.ac_fan_auto')]];
      if (quiet) opts.push(['quiet', __('settings.plan.ac_fan_quiet')]);
      for (let i = 1; i <= n; i++) opts.push([(i - 1) / (n - 1), String(i), i]);
      opts.forEach(([v, label, lvl]) => {
        const sel = lvl ? curLevel === lvl : cur === v;
        chips.appendChild(el('button', {
          class: `chip small${sel ? ' sel' : ''}`,
          text: label,
          onclick: () => {
            if (v === undefined) delete value.fan;
            else value.fan = typeof v === 'number' ? Math.round(v * 100) / 100 : v;
            markDirty();
            draw();
            if (onChange) onChange();
          },
        }));
      });
      box.appendChild(chips);
    };
    draw();
    return box;
  }

  /** Heure « HH:MM » en deux listes (heures 00–23, minutes par 5). */
  function timePicker(value, onChange) {
    const [h, m] = String(value).split(':').map(Number);
    const hs = el('select', { class: 'tp', 'aria-label': 'h' });
    const ms = el('select', { class: 'tp', 'aria-label': 'min' });
    for (let i = 0; i < 24; i++) hs.appendChild(el('option', { value: i, text: String(i).padStart(2, '0') }));
    const mins = [...new Set([...Array(12).keys()].map((i) => i * 5).concat(m))].sort((a, b) => a - b);
    mins.forEach((i) => ms.appendChild(el('option', { value: i, text: String(i).padStart(2, '0') })));
    hs.value = String(h);
    ms.value = String(m);
    const fire = () => onChange(`${String(hs.value).padStart(2, '0')}:${String(ms.value).padStart(2, '0')}`);
    hs.addEventListener('change', fire);
    ms.addEventListener('change', fire);
    return el('span', { class: 'timepick' }, [hs, el('b', { text: ':' }), ms]);
  }

  function renderSlotsWarnings() {
    const p = state.plan;
    const overlapping = S.overlaps(p.slots);
    p.slots.forEach((slot, i) => {
      const card = $(`slot-${i}`);
      if (!card) return;
      let warn = card.querySelector('.warn');
      let msg = '';
      if (!slot.days.length) msg = `⚠️ ${__('settings.plan.no_day')}`;
      else if (overlapping.includes(i)) msg = `⚠️ ${__('settings.plan.overlap')}`;
      if (!warn && msg) { warn = el('p', { class: 'warn' }); card.appendChild(warn); }
      if (warn) warn.textContent = msg;
    });
  }

  function renderWeek() {
    const p = state.plan;
    const box = $('week');
    box.innerHTML = '';
    const runs = S.dayRuns(p.type, p.slots, p.base);
    const baseOn = p.type === 'fan' ? p.base.fanSpeed > 0 : !p.base.off;
    const s = state.status;
    S.DAY_ORDER.forEach((d) => {
      const today = s && s.localDay === d;
      box.appendChild(el('div', { class: `dl${today ? ' today' : ''}`, text: dayLabel(d) }));
      const track = el('div', { class: 'track' });
      runs.filter((r) => r.day === d).forEach((r) => {
        const width = ((r.end - r.start) / 1440) * 100;
        const full = describeValue(p.type, r.value);
        const label = describeValue(p.type, p.type === 'fan' ? r.value : { ...r.value, fan: undefined });
        const isOff = p.type === 'fan' ? !(r.value.fanSpeed > 0) : !!r.value.off;
        track.appendChild(el('div', {
          class: `seg${isOff ? ' dim' : ''}`,
          style: `left:${(r.start / 1440) * 100}%;width:${width}%`,
          title: `${S.fmt(r.start)}–${S.fmt(r.end)} · ${full}`,
          text: width >= 9 ? label : '',
          onclick: () => {
            const card = $(`slot-${r.slot}`);
            if (!card) return;
            card.scrollIntoView({ behavior: 'smooth', block: 'center' });
            card.classList.add('flash');
            setTimeout(() => card.classList.remove('flash'), 1200);
          },
        }));
      });
      if (today && typeof s.localMinutes === 'number') {
        track.appendChild(el('div', { class: 'now', style: `left:${(s.localMinutes / 1440) * 100}%` }));
      }
      box.appendChild(track);
    });
    box.appendChild(el('div'));
    const axis = el('div', { class: 'axis' });
    [0, 6, 12, 18, 24].forEach((h) => axis.appendChild(el('span', { style: `left:${(h / 24) * 100}%`, text: h === 0 ? '0h' : `${h}h` })));
    box.appendChild(axis);
    box.title = `${__('settings.plan.base')} : ${describeValue(p.type, p.base)}${baseOn ? '' : ''}`;
  }

  function addSlot() {
    const p = state.plan;
    if (p.slots.length >= S.MAX_SLOTS) return;
    const last = p.slots[p.slots.length - 1];
    const def = S.defaults(p.type).slots[0];
    const slot = last
      ? { days: [...last.days], start: last.end, end: S.fmt(S.toMin(last.end) + 120), value: { ...last.value } }
      : { ...def, days: [...def.days], value: { ...def.value } };
    p.slots.push(slot);
    markDirty();
    renderSlots();
    renderWeek();
    renderStatus();
    const card = $(`slot-${p.slots.length - 1}`);
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function changeType(type) {
    const p = state.plan;
    if (type === p.type) return;
    const from = p.type;
    p.slots.forEach((sl) => { sl.value = convertValue(sl.value, from, type, false); });
    p.base = convertValue(p.base, from, type, true);
    p.type = type;
    p.overrides = {};
    markDirty();
    renderEditor();
  }

  // ----------------------------------------------------------- Sonde de la pièce
  function renderRoom() {
    const p = state.plan;
    const sel = $('r-sensor');
    sel.innerHTML = '';
    sel.appendChild(el('option', { value: '', text: __('settings.plan.room_none') }));
    const list = [...(state.sensors || [])];
    const cur = p.room && p.room.sensor;
    if (cur && !list.some((s) => s.id === cur)) list.push({ id: cur, name: `? (${cur.slice(0, 8)})` });
    list.forEach((s) => {
      const extra = [s.zoneName, typeof s.temperature === 'number' ? fmtTemp(s.temperature) : ''].filter(Boolean).join(' · ');
      sel.appendChild(el('option', { value: s.id, text: extra ? `${s.name} (${extra})` : s.name }));
    });
    sel.value = cur || '';
    const sensor = list.find((s) => s.id === cur);
    $('r-now').textContent = sensor && typeof sensor.temperature === 'number' ? __('settings.plan.room_now', { value: fmtTemp(sensor.temperature) }) : '';
    $('r-body').classList.toggle('hidden', !cur);
    if (!cur) return;

    const room = p.room;
    const modes = $('r-mode');
    modes.innerHTML = '';
    const isFan = p.type === 'fan';
    [['display', 'room_display'], ['regulate', isFan ? 'room_regulate_fan' : 'room_regulate']].forEach(([m, label]) => {
      modes.appendChild(el('button', {
        class: `chip${(room.mode || 'display') === m ? ' sel' : ''}`,
        text: __(`settings.plan.${label}`),
        onclick: () => { room.mode = m; markDirty(); renderRoom(); },
      }));
    });
    const regulate = room.mode === 'regulate';
    $('r-mode-hint').textContent = regulate ? __(`settings.plan.room_hint_regulate_${p.type}`) : __('settings.plan.room_hint_display');
    $('r-h-row').classList.toggle('hidden', !regulate);
    $('r-th-row').classList.toggle('hidden', !regulate || !isFan);
    if (!regulate) return;

    if (isFan) {
      if (typeof room.threshold !== 'number') room.threshold = 26;
      const tbox = $('r-th');
      tbox.innerHTML = '';
      const stepT = (d) => {
        room.threshold = Math.round(Math.min(40, Math.max(15, room.threshold + d)) * 2) / 2;
        markDirty();
        renderRoom();
      };
      tbox.appendChild(el('div', { class: 'stepper' }, [
        el('button', { class: 'sbtn', text: '−', onclick: () => stepT(-0.5) }),
        el('span', { class: 'sval', text: fmtTemp(room.threshold) }),
        el('button', { class: 'sbtn', text: '+', onclick: () => stepT(0.5) }),
      ]));
    }

    if (typeof room.hysteresis !== 'number') room.hysteresis = 0.5;
    const box = $('r-h');
    box.innerHTML = '';
    const val = el('span', { class: 'sval', text: `± ${fmtTemp(room.hysteresis)}` });
    const step = (d) => {
      room.hysteresis = Math.round(Math.min(3, Math.max(0.1, room.hysteresis + d)) * 10) / 10;
      markDirty();
      renderRoom();
    };
    box.appendChild(el('div', { class: 'stepper' }, [
      el('button', { class: 'sbtn', text: '−', onclick: () => step(-0.1) }), val,
      el('button', { class: 'sbtn', text: '+', onclick: () => step(0.1) }),
    ]));
    const sample = (p.slots.find((s) => !s.value.off) || {}).value;
    const t = isFan ? room.threshold
      : (sample && typeof sample.targetTemperature === 'number' ? sample.targetTemperature : (p.type === 'cooling' ? 26 : 20));
    $('r-h-hint').textContent = __(`settings.plan.room_example_${p.type}`, {
      t: fmtTemp(t), low: fmtTemp(Math.round((t - room.hysteresis) * 10) / 10), high: fmtTemp(Math.round((t + room.hysteresis) * 10) / 10),
    });
  }

  /** Texte « pièce 19,6° · chauffe » pour l'état d'un programme. */
  function roomText(st, type) {
    if (!st || !st.room || typeof st.room.temperature !== 'number') return '';
    let s = __('settings.plan.room_status', { value: fmtTemp(Math.round(st.room.temperature * 10) / 10) });
    if (st.room.regulation === 'on') s += ` · ${__(`settings.plan.reg_on_${type === 'cooling' || type === 'fan' ? type : 'heating'}`)}`;
    if (st.room.regulation === 'idle') s += ` · ${__('settings.plan.reg_idle')}`;
    return s;
  }

  // ----------------------------------------------------------- Fenêtre ouverte
  function fmtDelay(sec) {
    if (sec < 60) return __('settings.plan.seconds', { n: sec });
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return s ? __('settings.plan.min_sec', { m, s }) : __('settings.plan.minutes', { m });
  }

  /** Appareils du programme en cours d'édition (sélection + zones). */
  function editedDevices() {
    const p = state.plan;
    return state.devices.filter((d) => supports(d, p.type) && ((p.devices || []).includes(d.id) || (p.zones || []).includes(d.zone)));
  }

  function renderWindow() {
    const p = state.plan;
    const card = $('window-card');
    card.classList.toggle('hidden', p.type === 'fan');
    if (p.type === 'fan') return;
    if (!p.window) p.window = { enabled: false, delay: 60, sensors: [] };
    const w = p.window;
    if (p.type === 'heating' && !w.value) w.value = { targetTemperature: 7 };
    $('w-enabled').checked = w.enabled === true;
    $('w-body').classList.toggle('hidden', !w.enabled);
    if (w.scope !== 'device') w.scope = 'plan';

    // ce qui s'arrête
    const scope = $('w-scope');
    scope.innerHTML = '';
    [['plan', 'window_scope_plan'], ['device', 'window_scope_device']].forEach(([v, label]) => scope.appendChild(el('button', {
      class: `chip${w.scope === v ? ' sel' : ''}`,
      text: __(`settings.plan.${label}`),
      onclick: () => { w.scope = v; markDirty(); renderWindow(); },
    })));
    $('w-scope-hint').textContent = __(`settings.plan.window_scope_${w.scope}_hint`);

    // délai : − / + par 15 s et raccourcis
    const box = $('w-delay');
    box.innerHTML = '';
    const val = el('span', { class: 'sval', text: fmtDelay(w.delay) });
    const step = (d) => {
      w.delay = Math.min(3600, Math.max(0, (Number(w.delay) || 0) + d));
      markDirty();
      renderWindow();
    };
    box.appendChild(el('div', { class: 'stepper' }, [
      el('button', { class: 'sbtn', text: '−', onclick: () => step(-15) }), val,
      el('button', { class: 'sbtn', text: '+', onclick: () => step(15) }),
    ]));
    const quick = el('div', { class: 'chips' });
    [0, 30, 60, 120, 300, 600].forEach((s) => quick.appendChild(el('button', {
      class: `chip${w.delay === s ? ' sel' : ''}`,
      text: fmtDelay(s),
      onclick: () => { w.delay = s; markDirty(); renderWindow(); },
    })));
    box.appendChild(quick);

    // valeur pendant l'ouverture
    const vbox = $('w-value');
    vbox.innerHTML = '';
    if (p.type === 'heating') {
      $('w-value-label').textContent = __('settings.plan.window_value_heating');
      vbox.appendChild(stepper(w.value, 'heating', null, true));
      $('w-value-hint').textContent = __('settings.plan.window_hint_heating');
    } else {
      $('w-value-label').textContent = '';
      $('w-value-hint').textContent = __('settings.plan.window_value_cooling');
    }

    // capteurs
    const contacts = state.contacts || [];
    const pick = (w.sensors || []).length > 0 || w.pick === true;
    const modes = $('w-mode');
    modes.innerHTML = '';
    modes.appendChild(el('button', {
      class: `chip${pick ? '' : ' sel'}`,
      text: __(w.scope === 'plan' ? 'settings.plan.window_auto_plan' : 'settings.plan.window_auto'),
      onclick: () => { w.sensors = []; w.pick = false; markDirty(); renderWindow(); },
    }));
    modes.appendChild(el('button', {
      class: `chip${pick ? ' sel' : ''}`,
      text: __('settings.plan.window_pick'),
      onclick: () => { w.pick = true; markDirty(); renderWindow(); },
    }));
    const list = $('w-sensors');
    list.innerHTML = '';
    const found = $('w-found');
    if (!contacts.length) {
      found.textContent = __('settings.plan.window_no_contacts');
      return;
    }
    const stateText = (c) => (c.open === true ? __('settings.plan.open') : (c.open === false ? __('settings.plan.closed') : '?'));
    if (pick) {
      found.textContent = '';
      contacts.forEach((c) => {
        const cb = el('input', { type: 'checkbox' });
        cb.checked = w.sensors.includes(c.id);
        cb.addEventListener('change', () => {
          w.sensors = w.sensors.filter((id) => id !== c.id);
          if (cb.checked) w.sensors.push(c.id);
          markDirty();
        });
        list.appendChild(el('label', {}, [cb, c.name, el('span', { class: 'zone-hint', text: `${c.zoneName || ''} · ${stateText(c)}` })]));
      });
    } else {
      const zones = new Set(editedDevices().map((d) => d.zone));
      if (w.scope === 'plan') (p.zones || []).forEach((z) => zones.add(z));
      const auto = contacts.filter((c) => zones.has(c.zone));
      found.textContent = auto.length
        ? __('settings.plan.window_auto_found', { names: auto.map((c) => `${c.name} (${c.zoneName}, ${stateText(c)})`).join(', ') })
        : __('settings.plan.window_auto_none');
    }
  }

  function renderOverrides() {
    const box = $('overrides');
    box.innerHTML = '';
    const p = state.plan;
    OVERRIDE_KEYS.forEach(([key, modeId]) => {
      if (key === 'OutOfSeason' && p.type !== 'heating') return; // hors saison : uniquement chauffage
      const enabled = el('input', { type: 'checkbox', class: 'switch' });
      enabled.checked = p.overrides[key] != null;
      const holder = el('div');
      const draw = () => {
        holder.innerHTML = '';
        if (p.overrides[key] != null) holder.appendChild(stepper(p.overrides[key], p.type, null, p.type === 'cooling'));
      };
      enabled.addEventListener('change', () => {
        if (enabled.checked) {
          p.overrides[key] = p.type === 'fan' ? { fanSpeed: 0 } : { targetTemperature: p.type === 'cooling' ? 28 : 16 };
        } else {
          delete p.overrides[key];
        }
        markDirty();
        draw();
      });
      draw();
      box.appendChild(el('div', { class: 'ov' }, [
        el('label', { class: 'name' }, [`${__(`modes.${modeId}`)}`]),
        enabled,
        holder,
      ]));
    });
  }

  function renderTargets() {
    const p = state.plan;
    const zbox = $('p-zones');
    zbox.innerHTML = '';
    const updateCount = () => {
      const n = (p.zones || []).length + (p.devices || []).length;
      $('targets-count').textContent = `(${n})`;
      $('targets-fold').open = $('targets-fold').open || n === 0;
    };
    if (!state.zones.length) zbox.appendChild(el('div', { class: 'muted', text: '–' }));
    state.zones.forEach((z) => {
      const count = state.devices.filter((d) => d.zone === z.id && supports(d, p.type)).length;
      const cb = el('input', { type: 'checkbox' });
      cb.checked = (p.zones || []).includes(z.id);
      cb.addEventListener('change', () => {
        p.zones = (p.zones || []).filter((id) => id !== z.id);
        if (cb.checked) p.zones.push(z.id);
        markDirty();
        updateCount();
        renderWindow();
      });
      zbox.appendChild(el('label', {}, [cb, z.name, el('span', { class: 'zone-hint', text: `(${count})` })]));
    });

    const dbox = $('p-devices');
    dbox.innerHTML = '';
    const compatible = state.devices.filter((d) => supports(d, p.type));
    if (!compatible.length) dbox.appendChild(el('div', { class: 'muted', text: __('settings.plan.no_compatible') }));
    compatible.forEach((d) => {
      const cb = el('input', { type: 'checkbox' });
      cb.checked = (p.devices || []).includes(d.id);
      cb.addEventListener('change', () => {
        p.devices = (p.devices || []).filter((id) => id !== d.id);
        if (cb.checked) p.devices.push(d.id);
        markDirty();
        updateCount();
        renderWindow();
      });
      dbox.appendChild(el('label', {}, [cb, d.name, el('span', { class: 'zone-hint', text: d.zoneName || '' })]));
    });
    updateCount();
  }

  function collectPlan() {
    const p = state.plan;
    p.name = $('p-name').value.trim() || p.name;
    p.enabled = $('p-enabled').checked;
    p.offOutOfSeason = $('p-off').checked;
    p.description = $('p-desc').value;
    const out = { ...p };
    delete out.schedule; // recalculé par l'application à partir des plages
    return out;
  }

  async function savePlan() {
    const p = collectPlan();
    try {
      const saved = await api('PUT', `/plans/${encodeURIComponent(p.id)}`, p);
      state.isNew = false;
      clearDirty();
      toast(__('settings.plans.saved'));
      await openEditor(saved, false);
    } catch (e) {
      toast(errorMessage(e), true);
    }
  }

  async function testValue(value) {
    const p = collectPlan();
    try {
      const r = await api('POST', `/plans/${encodeURIComponent(p.id)}/test`, { plan: p, value });
      const failed = r.devices.filter((d) => !d.ok);
      if (!r.devices.length) toast(__('settings.plan.test_none'), true);
      else if (failed.length) toast(__('settings.plan.test_failed', { names: failed.map((d) => d.name).join(', ') }), true);
      else toast(__('settings.plan.test_done', { count: r.devices.length }));
    } catch (e) {
      toast(errorMessage(e), true);
    }
  }

  async function backToSchedule() {
    if (state.isNew) {
      toast(__('settings.plan.back_unsaved'), true);
      return;
    }
    try {
      await api('POST', `/plans/${encodeURIComponent(state.plan.id)}/apply`);
      state.status = await api('GET', '/state');
      renderStatus();
      toast(__('settings.plan.back_done'));
    } catch (e) {
      toast(errorMessage(e), true);
    }
  }

  async function leaveEditor() {
    if (dirty && !(await confirmDialog(__('settings.plan.confirm_leave')))) return;
    clearDirty();
    showPlanList();
  }

  async function deletePlan() {
    const p = state.plan;
    const ok = await confirmDialog(__('settings.plans.confirm_delete', { name: p.name }));
    if (!ok) return;
    try {
      await api('DELETE', `/plans/${encodeURIComponent(p.id)}`);
      clearDirty();
      toast(__('settings.plans.deleted'));
      showPlanList();
    } catch (e) {
      toast(errorMessage(e), true);
    }
  }

  async function clonePlan() {
    const p = collectPlan();
    try {
      const fresh = await api('GET', `/new-plan?type=${p.type}`);
      const copy = {
        ...JSON.parse(JSON.stringify(p)), id: fresh.id, name: `${p.name} (${__('settings.plans.copy')})`, enabled: false,
      };
      delete copy.thermostatMode;
      await openEditor(copy, true);
    } catch (e) {
      toast(errorMessage(e), true);
    }
  }

  function confirmDialog(msg) {
    return new Promise((resolve) => {
      if (H && typeof H.confirm === 'function') {
        H.confirm(msg, 'warning', (err, ok) => resolve(!err && ok));
      } else {
        resolve(window.confirm(msg));
      }
    });
  }

  // ===================================================================== Réglages
  const OPTION_FIELDS = [
    ['o-cstart', 'cooling_start', '06-01', 'text'],
    ['o-cend', 'cooling_end', '09-15', 'text'],
    ['o-osensor', 'outdoor_sensor', '', 'text'],
    ['o-ocool', 'outdoor_cool_above', 22, 'number'],
    ['o-oheat', 'outdoor_heat_below', 15, 'number'],
    ['o-ohours', 'outdoor_hours', 24, 'number'],
    ['o-hconf', 'heating_conflict', 'max', 'text'],
    ['o-cconf', 'cooling_conflict', 'min', 'text'],
    ['o-nmode', 'notify_modechange', true, 'bool'],
    ['o-nseason', 'notify_seasonchange', true, 'bool'],
    ['o-nok', 'notify_settempsuccess', false, 'bool'],
    ['o-nerr', 'notify_settemperror', true, 'bool'],
    ['o-nwin', 'notify_window', true, 'bool'],
    ['o-naway', 'notify_away', true, 'bool'],
  ];

  function renderSensorSelect(current) {
    const sel = $('o-osensor');
    sel.innerHTML = '';
    sel.appendChild(el('option', { value: '', text: __('settings.options.outdoor_none') }));
    const list = [...state.sensors];
    // une sonde choisie mais disparue reste visible pour ne pas être effacée sans le vouloir
    if (current && !list.some((s) => s.id === current)) list.push({ id: current, name: `? (${current.slice(0, 8)})` });
    list.forEach((s) => {
      const extra = [s.zoneName, typeof s.temperature === 'number' ? `${s.temperature}°` : ''].filter(Boolean).join(' · ');
      sel.appendChild(el('option', { value: s.id, text: extra ? `${s.name} (${extra})` : s.name }));
    });
    sel.value = current || '';
  }

  // ----------------------------------------------------------- Personne à la maison
  let awayCfg = null;

  function renderAway() {
    const c = awayCfg;
    $('a-enabled').checked = c.enabled === true;
    $('a-body').classList.toggle('hidden', !c.enabled);
    // délai
    const box = $('a-delay');
    box.innerHTML = '';
    const step = (d) => { c.delay = Math.min(240, Math.max(0, (Number(c.delay) || 0) + d)); renderAway(); };
    box.appendChild(el('div', { class: 'stepper' }, [
      el('button', { class: 'sbtn', text: '−', onclick: () => step(-5) }),
      el('span', { class: 'sval', text: __('settings.options.minutes_short', { m: c.delay }) }),
      el('button', { class: 'sbtn', text: '+', onclick: () => step(5) }),
    ]));
    const quick = el('div', { class: 'chips' });
    [0, 5, 15, 30, 60].forEach((m) => quick.appendChild(el('button', {
      class: `chip small${c.delay === m ? ' sel' : ''}`,
      text: __('settings.options.minutes_short', { m }),
      onclick: () => { c.delay = m; renderAway(); },
    })));
    box.appendChild(quick);
    // chauffage pendant l'absence
    const hb = $('a-heating');
    hb.innerHTML = '';
    const chips = el('div', { class: 'chips' });
    [['off', 'away_heating_off'], ['eco', 'away_heating_eco']].forEach(([v, label]) => chips.appendChild(el('button', {
      class: `chip${c.heating === v ? ' sel' : ''}`,
      text: __(`settings.options.${label}`),
      onclick: () => { c.heating = v; renderAway(); },
    })));
    hb.appendChild(chips);
    if (c.heating === 'eco') {
      const t = { targetTemperature: c.ecoTemperature };
      hb.appendChild(stepper(t, 'heating', () => { c.ecoTemperature = t.targetTemperature; }, false));
    }
    // présence détectée
    const users = (state.status && state.status.away && state.status.away.users) || [];
    $('a-users').textContent = users.length
      ? __('settings.options.away_users', { list: users.map((u) => `${u.name} (${__(`settings.options.${u.present ? 'present' : 'absent'}`)})`).join(', ') })
      : __('settings.options.away_no_users');
  }

  async function loadAway() {
    const v = (await hget('away')) || {};
    awayCfg = {
      enabled: v.enabled === true,
      delay: Number.isFinite(Number(v.delay)) && v.delay !== '' && v.delay != null ? Number(v.delay) : 15,
      heating: v.heating === 'eco' ? 'eco' : 'off',
      ecoTemperature: Number(v.ecoTemperature) || 16,
    };
    if (!state.status) {
      try { state.status = await api('GET', '/state'); } catch (e) { /* état indisponible */ }
    }
    renderAway();
  }

  async function loadOptions() {
    try {
      try { await loadDevices(true); } catch (e) { /* liste des sondes indisponible */ }
      for (const [id, key, def, kind] of OPTION_FIELDS) {
        const v = await hget(key);
        if (id === 'o-osensor') renderSensorSelect(v || '');
        else if (kind === 'bool') $(id).checked = v == null ? def : v === true;
        else $(id).value = v == null || v === '' ? def : v;
      }
      await loadAway();
      await exportBackup();
    } catch (e) {
      toast(errorMessage(e), true);
    }
  }

  function readNumber(id) {
    return parseFloat(String($(id).value).replace(',', '.'));
  }

  async function saveOptions() {
    const re = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
    if (!re.test($('o-cstart').value) || !re.test($('o-cend').value)) {
      toast(__('settings.options.bad_date'), true);
      return;
    }
    const cool = readNumber('o-ocool');
    const heat = readNumber('o-oheat');
    const hours = parseInt($('o-ohours').value, 10);
    if (Number.isNaN(cool) || Number.isNaN(heat) || !(cool > heat) || !(hours >= 1 && hours <= 72)) {
      toast(__('settings.options.bad_outdoor'), true);
      return;
    }
    try {
      for (const [id, key, , kind] of OPTION_FIELDS) {
        let v;
        if (kind === 'bool') v = $(id).checked;
        else if (kind === 'number') v = id === 'o-ohours' ? hours : readNumber(id);
        else v = $(id).value;
        await hset(key, v);
      }
      if (awayCfg) await hset('away', { ...awayCfg });
      toast(__('settings.options.saved'));
    } catch (e) {
      toast(errorMessage(e), true);
    }
  }

  async function exportBackup() {
    const plans = await api('GET', '/plans');
    $('backup').value = JSON.stringify(plans, null, 2);
  }

  async function restoreBackup() {
    let list;
    try {
      list = JSON.parse($('backup').value);
      if (!Array.isArray(list)) throw new Error();
    } catch (e) {
      toast(__('settings.options.bad_backup'), true);
      return;
    }
    const ok = await confirmDialog(__('settings.options.confirm_restore', { count: list.length }));
    if (!ok) return;
    try {
      await api('PUT', '/plans', list);
      toast(__('settings.options.restored'));
      await exportBackup();
    } catch (e) {
      toast(errorMessage(e), true);
    }
  }

  // ===================================================================== Démarrage
  function bind() {
    document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));

    $('apply-all').addEventListener('click', async () => {
      try {
        await api('POST', '/apply');
        toast(__('settings.overview.applied'));
        setTimeout(loadOverview, 1500);
      } catch (e) { toast(errorMessage(e), true); }
    });

    document.querySelectorAll('[data-new]').forEach((b) => b.addEventListener('click', () => newPlan(b.dataset.new)));
    $('plan-back').addEventListener('click', leaveEditor);
    $('p-type').addEventListener('change', () => changeType($('p-type').value));
    ['p-name', 'p-desc'].forEach((id) => $(id).addEventListener('input', markDirty));
    ['p-enabled', 'p-off'].forEach((id) => $(id).addEventListener('change', markDirty));
    $('r-sensor').addEventListener('change', () => {
      const v = $('r-sensor').value;
      state.plan.room = v ? { mode: 'display', hysteresis: 0.5, ...(state.plan.room || {}), sensor: v } : null;
      markDirty();
      renderRoom();
    });
    $('a-enabled').addEventListener('change', () => { if (awayCfg) { awayCfg.enabled = $('a-enabled').checked; renderAway(); } });
    $('w-enabled').addEventListener('change', () => {
      state.plan.window = { ...(state.plan.window || { delay: 60, sensors: [] }), enabled: $('w-enabled').checked };
      markDirty();
      renderWindow();
    });
    $('slot-add').addEventListener('click', addSlot);
    $('plan-save').addEventListener('click', savePlan);
    $('plan-save2').addEventListener('click', savePlan);
    $('plan-delete').addEventListener('click', deletePlan);
    $('plan-clone').addEventListener('click', clonePlan);
    $('t-on').addEventListener('click', () => testValue(currentSlotValue() || (state.plan.slots[0] && state.plan.slots[0].value)));
    $('t-off').addEventListener('click', () => testValue(state.plan.base));
    $('t-back').addEventListener('click', backToSchedule);

    $('options-save').addEventListener('click', saveOptions);
    $('backup-refresh').addEventListener('click', () => exportBackup().catch((e) => toast(errorMessage(e), true)));
    $('backup-restore').addEventListener('click', restoreBackup);
  }

  /** Enveloppe chaque case « switch » pour la dessiner en interrupteur (voir style.css). */
  function enhanceSwitches(root) {
    (root || document).querySelectorAll('input.switch:not([data-sw])').forEach((inp) => {
      inp.setAttribute('data-sw', '1');
      const wrap = document.createElement('span');
      wrap.className = 'sw';
      inp.parentNode.insertBefore(wrap, inp);
      wrap.appendChild(inp);
      wrap.appendChild(document.createElement('i'));
    });
  }

  window.onHomeyReady = async function onHomeyReady(Homey) {
    H = Homey;
    enhanceSwitches(document);
    new MutationObserver(() => enhanceSwitches(document)).observe($('tp'), { childList: true, subtree: true });
    translatePage();
    bind();
    try {
      await loadDevices(false);
    } catch (e) { /* chargé plus tard */ }
    await loadOverview();
    Homey.ready();
  };
}());
