import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { createGeaBridgeUrl, createGeaChildEnv, createGeaSpawnPlan } from './geaSpawn.js';

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

  it('passes the bridge URL and token to spawned GEA without putting the secret in args', () => {
    const bridgeUrl = createGeaBridgeUrl('127.0.0.1', '7430');
    const env = createGeaChildEnv({
      PATH: 'C:\\Windows\\System32',
      VITE_DEV_SERVER_URL: 'http://localhost:5173',
    }, bridgeUrl, 'spawn-secret');

    expect(env.NEMESIS_BRIDGE_URL).toBe('ws://127.0.0.1:7430');
    expect(env.NEMESIS_BRIDGE_TOKEN).toBe('spawn-secret');
    expect(env.GEA_COORDINATE_TAPE_WITH_NEMESIS).toBe('true');
    expect(env.VITE_DEV_SERVER_URL).toBeUndefined();

    const plan = createGeaSpawnPlan({
      platform: 'win32',
      env: {},
      repoRoot: 'D:\\repo',
      geaRoot: 'D:\\repo\\apps\\global-event-alpha',
      builtMain: 'D:\\repo\\apps\\global-event-alpha\\dist-electron\\main.js',
      builtMainExists: true,
      execPath: 'C:\\Program Files\\NEMESIS\\NEMESIS.exe',
    });

    expect(JSON.stringify(plan)).not.toContain('spawn-secret');
  });
});
