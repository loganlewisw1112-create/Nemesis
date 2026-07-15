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

  it('launches evidence campaigns only from the exact passing soaked production artifact', () => {
    const script = fs.readFileSync(path.join(repoRoot, 'scripts', 'start-evidence-campaign.ps1'), 'utf8');

    expect(script).not.toContain('npm run build');
    expect(script).toContain("$env:NEMESIS_DEVTOOLS = 'false'");
    expect(script).toContain('dist-electron\\main.js');
    expect(script).toContain('Assert-PassingSoak');
    expect(script).toContain('productionArtifactHash');
    expect(script).toContain('Current production artifact differs from the exact artifact that passed the soak');
    expect(script).toContain('Assert-CleanR10Unlock');
    expect(script).toContain('restartOrdinal -ne 0');
    expect(script).toContain("-notmatch '(^|[-_.])r10($|[-_.])'");
    expect(script).toContain('NEMESIS_EVIDENCE_PREFLIGHT');
    expect(script).toContain('preflight-ready');
    expect(script).toContain('start-campaign');
    expect(script).toContain('closeout-ready');
    expect(script).toContain('Start-Process -FilePath $electronExe');
    expect(script).toContain('Stop-CapturedProcessTree');
    expect(script).toContain('Update-ProcessCapture');
    expect(script).toContain('Mark-UncleanShutdown');
    expect(script).toContain("$result.passed -ne $true");
    expect(script).not.toContain('npm run dev');
  });

  it('makes the production soak attest its artifact and calculate renderer slope from renderer timestamps', () => {
    const script = fs.readFileSync(path.join(repoRoot, 'scripts', 'run-production-soak.ps1'), 'utf8');

    expect(script).toContain("$env:NEMESIS_DEVTOOLS = 'false'");
    expect(script).toContain("$env:NEMESIS_DISCOVERY_MAX_TRACKED_TICKERS = '500'");
    expect(script).toContain('productionArtifactHash');
    expect(script).toContain('productionEntryHash');
    expect(script).toContain('Get-NormalizedSlopePerHour');
    expect(script).toContain('$latestAt - 1800000');
    expect(script).toContain("$null -ne $slopePerHour");
    expect(script).toContain('rendererSampleCoverage -ge 0.95');
    expect(script).toContain('geaSampleCoverage -ge 0.95');
    expect(script).toContain('NEMESIS_RUNTIME_STATUS_PATH');
    expect(script).toContain('externalStatusCoverage -ge 0.95');
    expect(script).toContain("latestExternalStatus.rendererStatus -eq 'stable'");
    expect(script).toContain("latestExternalStatus.runtimeState -eq 'healthy'");
    expect(script).toContain('remained unresponsive for at least ten seconds');
  });
});
