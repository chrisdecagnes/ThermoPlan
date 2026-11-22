'use strict';

/**
 * Vérification de l'interface sous Chromium (Playwright) avec la vraie application
 * sur un Homey simulé : page de réglages (Aperçu, Programmes, éditeur, Réglages)
 * et widget (clair / sombre), dans les 4 langues. Échoue si une erreur JS apparaît
 * ou si une clé de traduction s'affiche telle quelle.
 *
 *   node bench/check.js [dossier-captures] [--langs fr,en] [--previews]
 *
 * --previews : régénère widgets/thermoplan/preview-light.png et preview-dark.png
 * (widget en anglais, 1024 × 1024, fond transparent).
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { startServer } = require('./server');
const { ROOT } = require('./sim');

const args = process.argv.slice(2);
const outDir = path.resolve(args.find((a) => !a.startsWith('--') && !/^[a-z]{2}(,[a-z]{2})*$/.test(a)) || path.join(ROOT, 'bench', 'out'));
const li = args.indexOf('--langs');
const LANGS = li >= 0 ? args[li + 1].split(',') : ['fr', 'en', 'nl', 'de'];
const PREVIEWS = args.includes('--previews');

// une clé non traduite ressemble à « settings.plan.xxx »
const RAW_KEY = /\b(settings|widget|modes|seasons|types|errors)\.[a-z_]+(\.[a-z_]+)?\b/;

async function visibleRawKeys(page) {
  const text = await page.evaluate(() => document.body.innerText);
  return text.split('\n').filter((l) => RAW_KEY.test(l)).slice(0, 5);
}

async function checkLang(browser, lang, problems) {
  const srv = await startServer({ lang });
  const shot = (n) => path.join(outDir, `${lang}-${n}.png`);
  try {
    // ---------------------------------------------------------------- réglages
    const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && errs.push(`console: ${m.text()}`));
    await page.goto(`${srv.base}/settings/`);
    await page.waitForFunction(() => window.__benchReady === true, null, { timeout: 15000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: shot('1-apercu'), fullPage: true });
    const steps = [['plans', '2-programmes'], ['options', '4-reglages']];
    for (const [tab, name] of steps) {
      await page.click(`.tab[data-tab="${tab}"]`);
      await page.waitForTimeout(300);
      await page.screenshot({ path: shot(name), fullPage: true });
      if (tab === 'plans') {
        await page.click('#plan-list .pcard >> nth=0');
        await page.waitForSelector('#plan-edit-view:not(.hidden)', { timeout: 5000 });
        await page.waitForTimeout(300);
        await page.screenshot({ path: shot('3-editeur'), fullPage: true });
        await page.click('#plan-back');
        await page.waitForTimeout(200);
      }
    }
    const raw = await visibleRawKeys(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    if (overflow) problems.push(`${lang} réglages : débordement horizontal`);
    if (raw.length) problems.push(`${lang} réglages : clés non traduites → ${raw.join(' | ')}`);
    errs.forEach((e) => problems.push(`${lang} réglages : ${e}`));
    await ctx.close();

    // ---------------------------------------------------------------- widget
    for (const scheme of ['light', 'dark']) {
      const wctx = await browser.newContext({ viewport: { width: 360, height: 700 }, deviceScaleFactor: 2, colorScheme: scheme });
      const w = await wctx.newPage();
      const werrs = [];
      w.on('pageerror', (e) => werrs.push(`pageerror: ${e.message}`));
      w.on('console', (m) => m.type() === 'error' && werrs.push(`console: ${m.text()}`));
      await w.goto(`${srv.base}/widget/`);
      await w.waitForFunction(() => window.__benchReady === true, null, { timeout: 15000 });
      await w.waitForTimeout(300);
      await w.screenshot({ path: shot(`5-widget-${scheme}`), fullPage: true });
      const wraw = await visibleRawKeys(w);
      if (wraw.length) problems.push(`${lang} widget : clés non traduites → ${wraw.join(' | ')}`);
      werrs.forEach((e) => problems.push(`${lang} widget ${scheme} : ${e}`));
      await wctx.close();
    }
  } finally {
    await srv.close();
  }
}

/** Aperçus du store : le widget (un programme, en anglais) centré sur 1024 × 1024 transparent. */
async function renderPreviews(browser) {
  const srv = await startServer({ lang: 'en' });
  try {
    for (const scheme of ['light', 'dark']) {
      const ctx = await browser.newContext({ viewport: { width: 340, height: 600 }, deviceScaleFactor: 2, colorScheme: scheme });
      const p = await ctx.newPage();
      await p.goto(`${srv.base}/widget/?plan=p-salon`);
      await p.waitForFunction(() => window.__benchReady === true, null, { timeout: 15000 });
      await p.waitForTimeout(300);
      const h = await p.evaluate(() => Math.ceil(document.body.scrollHeight));
      const png = await p.screenshot({ clip: { x: 0, y: 0, width: 340, height: h } });
      // composition : carte arrondie avec ombre, centrée
      const canvas = await ctx.newPage();
      await canvas.setViewportSize({ width: 1024, height: 1024 });
      const shadow = scheme === 'dark' ? 'rgba(0,0,0,.55)' : 'rgba(0,0,0,.18)';
      await canvas.setContent(`<html><body style="margin:0;background:transparent;width:1024px;height:1024px;display:flex;align-items:center;justify-content:center">
        <img src="data:image/png;base64,${png.toString('base64')}" style="width:680px;border-radius:36px;box-shadow:0 18px 60px ${shadow}"></body></html>`);
      await canvas.waitForTimeout(100);
      const file = path.join(ROOT, 'widgets', 'thermoplan', `preview-${scheme}.png`);
      await canvas.screenshot({ path: file, omitBackground: true });
      console.log('aperçu écrit :', path.relative(ROOT, file));
      await ctx.close();
    }
  } finally {
    await srv.close();
  }
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  const problems = [];
  try {
    for (const lang of LANGS) {
      await checkLang(browser, lang, problems);
      console.log(`${lang} : vérifié`);
    }
    if (PREVIEWS) await renderPreviews(browser);
  } finally {
    await browser.close();
  }
  console.log(`captures : ${outDir}`);
  if (problems.length) {
    console.log('PROBLÈMES :');
    problems.forEach((p) => console.log(' -', p));
    process.exit(1);
  }
  console.log('aucune erreur JS, aucune clé non traduite');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });
