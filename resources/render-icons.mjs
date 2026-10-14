// Rasterizes resources/icon.svg into every launcher / PWA icon with a headless Chromium browser
// (Edge ships with Windows), so no image dependency is needed in package.json.
//
//   node resources/render-icons.mjs            write the Android + PWA icons into the repo
//   node resources/render-icons.mjs preview    write a legibility contact sheet to the temp dir
//
// Set CHROME=/path/to/chrome-or-edge when the browser is not at the default Windows Edge path.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const browser = process.env.CHROME || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'csr-icons-'));
const svgSrc = fs.readFileSync(path.join(repo, 'resources/icon.svg'), 'utf8');

// Variants of the one master:
//  full    the 1024 design as-is (maskable PWA icon: full bleed, art inside the safe zone)
//  fg      adaptive foreground layer: the navy #bg rect removed, transparent around the art
//  square  legacy launcher / PWA "any": art zoomed to fill, rounded-square cut
//  round   legacy round launcher: art zoomed, circle cut
function svgFor(variant) {
  let s = svgSrc.replace(/<svg([^>]*)>/, (m, a) => `<svg${a.replace(/\s(width|height)="[^"]*"/g, '')} width="100%" height="100%">`);
  if (variant === 'fg') s = s.replace(/<rect id="bg"[^>]*\/>/, '');
  if (variant === 'square' || variant === 'round') s = s.replace(/viewBox="[^"]*"/, 'viewBox="132 132 760 760"');
  return s;
}

function pageFor(variant, size) {
  const radius = variant === 'round' ? '50%' : variant === 'square' ? '18%' : '0';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:transparent;overflow:hidden;width:${size}px;height:${size}px}
#c{width:${size}px;height:${size}px;border-radius:${radius};overflow:hidden}
svg{display:block}
</style></head><body><div id="c">${svgFor(variant)}</div></body></html>`;
}

// Screenshots the page at exactly w x h and checks the PNG header (size, 8-bit, RGBA unless opaque).
function shoot(html, outPath, w, h, alpha) {
  const htmlPath = path.join(work, `page-${w}x${h}.html`);
  fs.writeFileSync(htmlPath, html);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  execFileSync(browser, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${path.join(work, 'profile')}`, '--force-device-scale-factor=1',
    '--default-background-color=00000000', `--window-size=${w},${h}`, `--screenshot=${outPath}`,
    'file:///' + htmlPath.replace(/\\/g, '/'),
  ], { stdio: 'pipe' });
  const b = fs.readFileSync(outPath);
  const pw = b.readUInt32BE(16), ph = b.readUInt32BE(20), depth = b[24], ctype = b[25];
  if (b.toString('latin1', 12, 16) !== 'IHDR' || pw !== w || ph !== h || depth !== 8 || (alpha && ctype !== 6)) {
    throw new Error(`${outPath}: got ${pw}x${ph}, depth ${depth}, colour type ${ctype}`);
  }
  console.log(`${path.relative(repo, outPath).replace(/\\/g, '/')}  ${pw}x${ph}`);
}

const render = (variant, size, rel) => shoot(pageFor(variant, size), path.join(repo, rel), size, size, variant !== 'full');

if (process.argv[2] === 'preview') {
  // Adaptive icon under circle / squircle / square masks, then the legacy cuts, at 48/72/192 px
  // on a dark and a light wallpaper. The 48 px row is the legibility test.
  const fg = svgFor('fg'), sq = svgFor('square'), rd = svgFor('round');
  const adaptive = (px, r) => `<div class="a" style="width:${px}px;height:${px}px;border-radius:${r}">
    <div style="position:absolute;left:${-px / 4}px;top:${-px / 4}px;width:${px * 1.5}px;height:${px * 1.5}px">${fg}</div></div>`;
  const cut = (px, r, svg) => `<div class="a" style="width:${px}px;height:${px}px;border-radius:${r}">${svg}</div>`;
  const row = (px) => [adaptive(px, '50%'), adaptive(px, '30%'), adaptive(px, '0'), cut(px, '18%', sq), cut(px, '50%', rd)]
    .map((c) => `<div class="cell">${c}</div>`).join('');
  const block = (bg) => `<div class="blk" style="background:${bg}">${[48, 72, 192].map((s) => `<div class="row">${row(s)}</div>`).join('')}</div>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:#444}
.blk{display:inline-block;padding:16px;vertical-align:top}
.row{display:flex;gap:16px;align-items:center;margin-bottom:16px}
.cell{display:flex;align-items:center;justify-content:center}
.a{position:relative;overflow:hidden;background:#0a0e1a}
svg{display:block}
</style></head><body>${block('#2b3b2f')}${block('#e8e4da')}</body></html>`;
  const out = path.join(os.tmpdir(), 'csr-icon-preview.png');
  shoot(html, out, 2 * (5 * 192 + 4 * 16 + 32), 48 + 72 + 192 + 3 * 16 + 32, false);
  console.log(`preview: ${out}`);
} else {
  // Android: legacy square + round launchers (48 dp) and the adaptive foreground (108 dp) per density.
  const densities = [['mdpi', 48, 108], ['hdpi', 72, 162], ['xhdpi', 96, 216], ['xxhdpi', 144, 324], ['xxxhdpi', 192, 432]];
  for (const [d, legacy, fg] of densities) {
    const dir = `android/app/src/main/res/mipmap-${d}`;
    render('square', legacy, `${dir}/ic_launcher.png`);
    render('round', legacy, `${dir}/ic_launcher_round.png`);
    render('fg', fg, `${dir}/ic_launcher_foreground.png`);
  }
  render('square', 192, 'public/icons/icon-192.png');
  render('square', 512, 'public/icons/icon-512.png');
  render('full', 512, 'public/icons/maskable-512.png');
}
fs.rmSync(work, { recursive: true, force: true, maxRetries: 3 });
