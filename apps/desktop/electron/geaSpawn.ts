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
