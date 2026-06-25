const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { test, expect, _electron: electron } = require('@playwright/test');
const electronPath = require('electron');

const desktopRoot = path.join(__dirname, '..');
const mainEntry = path.join(desktopRoot, 'dist-electron', 'main.js');

async function launchApp() {
  if (!fs.existsSync(mainEntry)) {
    throw new Error('Build required: run npm run build -w @nemesis/desktop before e2e tests');
  }
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nemesis-e2e-'));
  const bridgePort = 19_430 + Math.floor(Math.random() * 1_000);
  return electron.launch({
    executablePath: electronPath,
    cwd: desktopRoot,
    args: [mainEntry],
    env: {
      ...process.env,
      NEMESIS_E2E_USER_DATA: userData,
      NEMESIS_AUTO_SPAWN_GEA: 'false',
      NEMESIS_BRIDGE_PORT: String(bridgePort),
    },
  });
}

async function waitForShell(page) {
  await expect(page.getByRole('heading', { name: 'Edge Theater' })).toBeVisible({ timeout: 30_000 });
}

test.describe('NEMESIS Electron smoke', () => {
  /** @type {import('@playwright/test').ElectronApplication | undefined} */
  let app;

  test.afterEach(async () => {
    if (app) await app.close();
  });

  test('app boot shows Edge Theater', async () => {
    app = await launchApp();
    const page = await app.firstWindow({ timeout: 45_000 });
    await waitForShell(page);
    await expect(page.getByText(/\d+ scout · \d+ solid · \d+ whale/i)).toBeVisible();
  });

  test('refresh loads thesis cards or empty state', async () => {
    app = await launchApp();
    const page = await app.firstWindow({ timeout: 45_000 });
    await waitForShell(page);
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(page.getByText(/\d+ scout · \d+ solid · \d+ whale · \d+ total/i)).toBeVisible({ timeout: 15_000 });
  });

  test('paper tab renders desk stats', async () => {
    app = await launchApp();
    const page = await app.firstWindow({ timeout: 45_000 });
    await waitForShell(page);
    await page.getByRole('button', { name: 'pap' }).click();
    await expect(page.getByRole('heading', { name: 'Paper Command Desk' })).toBeVisible();
    await expect(page.getByText(/Paper equity/i)).toBeVisible();
  });

  test('kill switch activates from settings', async () => {
    app = await launchApp();
    const page = await app.firstWindow({ timeout: 45_000 });
    await waitForShell(page);
    await page.getByRole('button', { name: 'set' }).click();
    await page.getByRole('button', { name: /Kill Switch/i }).click();
    await expect(page.getByText(/KILL-SWITCH ACTIVE/i)).toBeVisible({ timeout: 10_000 });
  });
});
