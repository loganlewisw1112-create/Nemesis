export interface GeaSpawnPlan {
  command: string;
  args: string[];
  cwd: string;
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
    return { command: input.geaPath, args: [], cwd: input.repoRoot };
  }

  if (input.env.VITE_DEV_SERVER_URL) {
    if (input.platform === 'win32') {
      return {
        command: input.env.ComSpec || 'cmd.exe',
        args: ['/d', '/s', '/c', 'npm run dev'],
        cwd: input.geaRoot,
      };
    }

    return {
      command: 'npm',
      args: ['run', 'dev'],
      cwd: input.geaRoot,
    };
  }

  if (input.builtMainExists) {
    return {
      command: input.execPath ?? process.execPath,
      args: [input.builtMain],
      cwd: input.geaRoot,
    };
  }

  return null;
}
