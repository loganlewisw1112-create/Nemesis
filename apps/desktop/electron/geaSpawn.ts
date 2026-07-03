export interface GeaSpawnPlan {
  command: string;
  args: string[];
  cwd: string;
  windowsHide: boolean;
}

export interface GeaSpawnPlanInput {
  platform: NodeJS.Platform | string;
  env: NodeJS.ProcessEnv;
  repoRoot: string;
  geaRoot: string;
  builtMain: string;
  builtMainExists: boolean;
  geaPath?: string;
  geaPathExists?: boolean;
  execPath?: string;
}

function hostForUrl(host: string): string {
  const trimmed = host.trim();
  return trimmed.includes(':') && !trimmed.startsWith('[') ? `[${trimmed}]` : trimmed;
}

export function createGeaBridgeUrl(host: string, port: string | number): string {
  return `ws://${hostForUrl(host)}:${port}`;
}

export function createGeaChildEnv(
  env: NodeJS.ProcessEnv,
  bridgeUrl: string,
  bridgeToken: string,
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    NEMESIS_BRIDGE_URL: bridgeUrl,
    NEMESIS_BRIDGE_TOKEN: bridgeToken,
  };
  delete childEnv.VITE_DEV_SERVER_URL;
  return childEnv;
}

export function createGeaSpawnPlan(input: GeaSpawnPlanInput): GeaSpawnPlan | null {
  if (input.geaPath && input.geaPathExists) {
    return { command: input.geaPath, args: [], cwd: input.repoRoot, windowsHide: false };
  }

  if (input.env.VITE_DEV_SERVER_URL) {
    if (input.platform === 'win32') {
      return {
        command: input.env.ComSpec || 'cmd.exe',
        args: ['/d', '/s', '/c', 'npm run dev'],
        cwd: input.geaRoot,
        windowsHide: true,
      };
    }

    return {
      command: 'npm',
      args: ['run', 'dev'],
      cwd: input.geaRoot,
      windowsHide: false,
    };
  }

  if (input.builtMainExists) {
    return {
      command: input.execPath ?? process.execPath,
      args: [input.builtMain],
      cwd: input.geaRoot,
      windowsHide: false,
    };
  }

  return null;
}
