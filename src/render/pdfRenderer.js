/**
 * src/render/pdfRenderer.js (Render-safe)
 * Renders HTML -> PDF buffer using Puppeteer with hardened flags.
 * Chrome resolution order:
 *  1) PUPPETEER_EXECUTABLE_PATH (env) — set by Render when we install system Chromium
 *  2) @sparticuz/chromium.executablePath() — MUST be awaited
 *  3) CHROME_EXECUTABLE_PATH / GOOGLE_CHROME_BIN (env) fallback
 *  4) Final static fallback: /usr/bin/chromium
 */

const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const { promisify } = require('util');
const { execFile } = require('child_process');
const execFileAsync = promisify(execFile);

async function resolveExecPath() {
  const envPath = (process.env.PUPPETEER_EXECUTABLE_PATH || '').trim();
  if (envPath) {
    if (fs.existsSync(envPath)) return envPath;
    console.warn('[pdfRenderer] env PUPPETEER_EXECUTABLE_PATH not found on disk:', envPath);
  }

  const tryWhich = async (bin) => {
    try {
      const { stdout } = await execFileAsync('which', [bin]);
      const p = stdout.trim();
      if (p && fs.existsSync(p)) return p;
    } catch {}
    return null;
  };
  const sysPath = (await tryWhich('chromium')) || (await tryWhich('chromium-browser'));
  if (sysPath) return sysPath;

  try {
    const p = await chromium.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch {}

  const alt = (process.env.CHROME_EXECUTABLE_PATH || process.env.GOOGLE_CHROME_BIN || '').trim();
  if (alt && fs.existsSync(alt)) return alt;

  return '/usr/bin/chromium';
}

async function htmlToPdf(html, options = {}) {
  let browser;
  const executablePath = await resolveExecPath(); // <- ensure string, not Promise

  const launchCommon = {
    executablePath,
    defaultViewport: chromium.defaultViewport,
    args: chromium.args,
    headless: chromium.headless,
    protocolTimeout: 90_000
  };

  try {
    console.log('[pdfRenderer] launching Chromium at', launchCommon.executablePath);
    browser = await puppeteer.launch(launchCommon);

    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 2 });

    // Load content and wait for network to settle
    await page.setContent(html, { waitUntil: ['domcontentloaded', 'networkidle0'] });

    // Ensure webfonts are ready (best-effort)
    try {
      await page.evaluate(async () => {
        if (document.fonts && document.fonts.ready) {
          await document.fonts.ready;
        }
      });
    } catch {}

    await page.emulateMediaType('screen');

    const pdfBuffer = await page.pdf({
      format: options.format || 'A4',
      printBackground: options.printBackground !== false,
      margin: options.margin || { top: '16mm', right: '14mm', bottom: '16mm', left: '14mm' },
      preferCSSPageSize: true
    });

    return pdfBuffer;
  } finally {
    if (browser) {
      try { await browser.close(); } catch {}
    }
  }
}

module.exports = { htmlToPdf };