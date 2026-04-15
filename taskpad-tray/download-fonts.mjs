/**
 * Run once: node download-fonts.mjs
 * Downloads Lora and DM Mono from Google Fonts into src/fonts/
 * After running, fonts work offline in the Tauri app.
 * Requires Node.js 18+
 */
import { mkdir, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FONTS_DIR = join(__dirname, 'src', 'fonts');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function fetchText(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.text();
}

async function fetchBuf(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return Buffer.from(await r.arrayBuffer());
}

const REQUESTS = [
  { family: 'Lora:ital,wght@0,400;0,500;0,600;1,400' },
  { family: 'DM+Mono:wght@400;500' },
];

await mkdir(FONTS_DIR, { recursive: true });

const allCss = [];

for (const { family } of REQUESTS) {
  const cssUrl = `https://fonts.googleapis.com/css2?family=${family}&display=swap`;
  console.log('Fetching CSS:', cssUrl);
  const css = await fetchText(cssUrl);

  // Find all font file URLs
  const urls = [...css.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)]
    .map(m => m[1]);

  let patchedCss = css;
  for (const url of urls) {
    const filename = url.split('/').pop().split('?')[0] + '.woff2';
    const dest = join(FONTS_DIR, filename);
    console.log('  Downloading', filename);
    const buf = await fetchBuf(url);
    await writeFile(dest, buf);
    patchedCss = patchedCss.replaceAll(url, `fonts/${filename}`);
  }
  allCss.push(patchedCss);
}

await writeFile(join(__dirname, 'src', 'fonts.css'), allCss.join('\n'));
console.log('\n✓ Done. Fonts saved to src/fonts/ and src/fonts.css');
console.log('  Replace the Google Fonts <link> in index.html with:');
console.log('  <link rel="stylesheet" href="fonts.css">');
