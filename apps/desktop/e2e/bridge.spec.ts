const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const WebSocket = require('ws');
const { test, expect, _electron: electron } = require('@playwright/test');
const electronPath = require('electron');

const desktopRoot = path.join(__dirname, '..');
const mainEntry = path.join(desktopRoot, 'dist-electron', 'main.js');

function recommendation(overrides = {}) {
  return {
    id: `rec-${Date.now()}`,
    brain_role: 'primary',
    model_version: 'alpha-v1',
    ticker: 'KXBRIDGE-26',
    classification: 'elite',
    alpha_score: 82,
    nemesis_probability: 0.61,
    confidence_band_low: 0.54,
    confidence_band_high: 0.68,
    net_ev: 0.05,
    raw_edge: 0.1,
    entry_zone_low: 0.42,
    entry_zone_high: 0.48,
    do_not_chase_level: 0.53,
    target_exit: 0.64,
    settlement_clarity_score: 0.75,
    hold_class: 'intraday',
    expires_at: Date.now() + 60_000,
    created_at: Date.now(),
    ...overrides,
  };
}

async function launchApp(port) {
  if (!fs.existsSync(mainEntry)) {
    throw new Error('Build required: run npm run build -w @nemesis/desktop before e2e tests');
  }
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nemesis-bridge-e2e-'));
  return electron.launch({
    executablePath: electronPath,
    cwd: desktopRoot,
    args: [mainEntry],
    env: {
      ...process.env,
      NEMESIS_E2E_USER_DATA: userData,
      NEMESIS_AUTO_SPAWN_GEA: 'false',
      NEMESIS_BRIDGE_PORT: String(port),
    },
  });
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

test.describe('NEMESIS bridge fail-closed behavior', () => {
  let app;
  let ws;

  test.afterEach(async () => {
    if (ws) ws.close();
    if (app) await app.close();
  });

  test('updates status for valid recommendations and rejects expired or forbidden packets', async () => {
    const port = 18_430 + Math.floor(Math.random() * 1_000);
    app = await launchApp(port);
    const page = await app.firstWindow({ timeout: 45_000 });
    await expect(page.getByRole('heading', { name: 'Edge Theater' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/STND\s*ALONE/i)).toBeVisible();

    ws = await connect(`ws://127.0.0.1:${port}`);
    await expect(page.getByText(/INTEL\s*ONLINE/i)).toBeVisible({ timeout: 5_000 });

    ws.send(JSON.stringify({ type: 'brain:recommendation', payload: recommendation(), seq: 1 }));
    await expect.poll(() => page.evaluate(() => window.nemesis.getBridgeStatus().then((s) => s.brainRole))).toBe('primary');

    ws.send(JSON.stringify({ type: 'brain:recommendation', payload: recommendation({ brain_role: 'standby-a', expires_at: 1 }), seq: 2 }));
    await page.waitForTimeout(200);
    await expect.poll(() => page.evaluate(() => window.nemesis.getBridgeStatus().then((s) => s.brainRole))).toBe('primary');

    ws.send(JSON.stringify({ type: 'brain:recommendation', payload: recommendation({ brain_role: 'shadow' }), seq: 3 }));
    await page.waitForTimeout(200);
    await expect.poll(() => page.evaluate(() => window.nemesis.getBridgeStatus().then((s) => s.brainRole))).toBe('primary');
  });
});
