import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { createGeaSpawnPlan } from './geaSpawn.js';

describe('GEA spawn planning', () => {
  it('uses cmd.exe for Windows npm dev spawn so .cmd launch does not throw EINVAL', () => {
    const plan = createGeaSpawnPlan({
      platform: 'win32',
      env: {
        ComSpec: 'C:\\Windows\\System32\\cmd.exe',
        VITE_DEV_SERVER_URL: 'http://localhost:5173',
      },
      repoRoot: 'D:\\repo',
      geaRoot: 'D:\\repo\\apps\\global-event-alpha',
      builtMain: 'D:\\repo\\apps\\global-event-alpha\\dist-electron\\main.js',
      builtMainExists: false,
    });

    expect(plan).toEqual({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', 'npm run dev'],
      cwd: 'D:\\repo\\apps\\global-event-alpha',
      windowsHide: true,
    });
  });

  it('uses built GEA main when no dev server is active', () => {
    const builtMain = path.join('D:\\repo', 'apps', 'global-event-alpha', 'dist-electron', 'main.js');
    const plan = createGeaSpawnPlan({
      platform: 'win32',
      env: {},
      repoRoot: 'D:\\repo',
      geaRoot: 'D:\\repo\\apps\\global-event-alpha',
      builtMain,
      builtMainExists: true,
    });

    expect(plan).toEqual({
      command: process.execPath,
      args: [builtMain],
      cwd: 'D:\\repo\\apps\\global-event-alpha',
      windowsHide: false,
    });
  });

  it('keeps bundled GEA executables visible when NEMESIS auto-spawns them', () => {
    const plan = createGeaSpawnPlan({
      platform: 'win32',
      env: {},
      repoRoot: 'D:\\repo',
      geaRoot: 'D:\\repo\\apps\\global-event-alpha',
      builtMain: 'D:\\repo\\apps\\global-event-alpha\\dist-electron\\main.js',
      builtMainExists: true,
      geaPath: 'D:\\repo\\resources\\gea-app\\Global Event Alpha.exe',
      geaPathExists: true,
    });

    expect(plan).toEqual({
      command: 'D:\\repo\\resources\\gea-app\\Global Event Alpha.exe',
      args: [],
      cwd: 'D:\\repo',
      windowsHide: false,
    });
  });
});
