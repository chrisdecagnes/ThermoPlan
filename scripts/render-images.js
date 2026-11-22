// Génère les images PNG de l’app et du driver (nécessite playwright + chromium) : node scripts/render-images.js
const { chromium } = require('playwright');
const fs = require('fs');
const appArt = (w, h) => `<html><body style="margin:0"><div style="width:${w}px;height:${h}px;position:relative;overflow:hidden;
background:linear-gradient(115deg,#FF8A3D 0%,#E8590C 38%,#1C7ED6 62%,#4DABF7 100%)">
<svg viewBox="0 0 1000 700" width="${w}" height="${h}" style="position:absolute;inset:0">
 <circle cx="140" cy="600" r="260" fill="#fff" opacity=".07"/><circle cx="880" cy="90" r="220" fill="#fff" opacity=".07"/>
 <g transform="translate(260 110) scale(0.5)">
  <g fill="none" stroke="#fff" stroke-width="48" stroke-linecap="round" stroke-linejoin="round">
   <path d="M295 800A370 370 0 0 1 295 160"/><path d="M205 140L295 160L270 250"/>
   <path d="M665 160A370 370 0 0 1 665 800"/><path d="M755 820L665 800L690 710"/>
   <path d="M425 300a55 55 0 0 1 110 0v260a100 100 0 1 1-110 0z"/>
  </g>
  <circle cx="480" cy="642" r="52" fill="#fff"/><rect x="462" y="420" width="36" height="220" rx="18" fill="#fff"/>
 </g>
</svg></div></body></html>`;
const drvArt = (s) => `<html><body style="margin:0"><div style="width:${s}px;height:${s}px;background:#fff;display:flex;align-items:center;justify-content:center">
<svg viewBox="0 0 500 500" width="${s*0.8}" height="${s*0.8}">
 <rect x="60" y="60" width="380" height="380" rx="70" fill="#F8F9FA" stroke="#343A40" stroke-width="14"/>
 <circle cx="250" cy="250" r="130" fill="none" stroke="#E8590C" stroke-width="22" stroke-dasharray="500 400" transform="rotate(130 250 250)"/>
 <circle cx="250" cy="250" r="130" fill="none" stroke="#1C7ED6" stroke-width="22" stroke-dasharray="150 900" transform="rotate(10 250 250)"/>
 <text x="250" y="275" text-anchor="middle" font-family="Arial, sans-serif" font-size="78" font-weight="700" fill="#343A40">21°</text>
</svg></div></body></html>`;
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ deviceScaleFactor: 1 });
  const out = process.argv[2] || require('path').resolve(__dirname, '..');
  const jobs = [
    [appArt(250,175), 250,175, `${out}/assets/images/small.png`],
    [appArt(500,350), 500,350, `${out}/assets/images/large.png`],
    [appArt(1000,700), 1000,700, `${out}/assets/images/xlarge.png`],
    [drvArt(75), 75,75, `${out}/drivers/virtual-thermostat/assets/images/small.png`],
    [drvArt(500), 500,500, `${out}/drivers/virtual-thermostat/assets/images/large.png`],
    [drvArt(1000), 1000,1000, `${out}/drivers/virtual-thermostat/assets/images/xlarge.png`],
  ];
  for (const [html,w,h,f] of jobs) {
    fs.mkdirSync(require('path').dirname(f), { recursive: true });
    await p.setViewportSize({ width: w, height: h });
    await p.setContent(html);
    await p.screenshot({ path: f, clip: { x:0,y:0,width:w,height:h } });
  }
  await b.close();
})();
