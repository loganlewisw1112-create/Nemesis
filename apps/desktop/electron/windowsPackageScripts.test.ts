import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '../../..');

describe('Windows package staging scripts', () => {
  it('exposes one local-signed command that stages the standardized release artifact', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(pkg.scripts?.['package:local-signed']).toContain('stage-windows-package.ps1');
  });

  it('requires signatures, hashes, and the standard WINDOWS PACKAGE output name', () => {
    const script = fs.readFileSync(path.join(repoRoot, 'scripts', 'stage-windows-package.ps1'), 'utf8');

    expect(script).toContain('WINDOWS PACKAGE');
    expect(script).toContain('NEMESIS-Windows-v$Version-Setup.exe');
    expect(script).toContain('Get-AuthenticodeSignature');
    expect(script).toContain('Get-FileHash');
    expect(script).toContain('signatures.txt');
    expect(script).toContain('NEMESIS-Windows-v*-Setup.exe*');
    expect(script).toContain('apps\\desktop\\release\\win-unpacked\\NEMESIS.exe');
    expect(script).toContain('apps\\desktop\\release\\win-unpacked\\resources\\gea-app\\Global Event Alpha.exe');
    expect(script).toContain('apps\\global-event-alpha\\release\\win-unpacked\\Global Event Alpha.exe');
  });

  it('launches smoke Electron directly so cleanup can kill the process tree', () => {
    const script = fs.readFileSync(path.join(repoRoot, 'scripts', 'verify-desktop-pair.ps1'), 'utf8');

    expect(script).toContain("node_modules\\electron\\dist\\electron.exe");
    expect(script).not.toContain("node_modules\\.bin\\electron.cmd");
  });

  it('quotes the smoke main-entry argument because the repo path contains spaces', () => {
    const script = fs.readFileSync(path.join(repoRoot, 'scripts', 'verify-desktop-pair.ps1'), 'utf8');

    expect(script).toContain('$MainEntryArg = \'"\' + $MainEntry + \'"\'');
    expect(script).toContain('-ArgumentList @($MainEntryArg)');
  });

  it('launches evidence campaigns from a frozen production build with DevTools disabled', () => {
    const script = fs.readFileSync(path.join(repoRoot, 'scripts', 'start-evidence-campaign.ps1'), 'utf8');

    expect(script).toContain('npm run build');
    expect(script).toContain("$env:NEMESIS_DEVTOOLS = 'false'");
    expect(script).toContain('dist-electron\\main.js');
    expect(script).toContain('& $electronExe $mainEntry');
    expect(script).not.toContain('npm run dev');
  });
});
