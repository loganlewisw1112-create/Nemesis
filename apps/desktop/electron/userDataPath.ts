import path from 'node:path';

export function resolveNemesisUserDataPath(env: NodeJS.ProcessEnv, appDataPath: string): string {
  const e2ePath = env.NEMESIS_E2E_USER_DATA?.trim();
  if (e2ePath) return e2ePath;
  return path.join(appDataPath, '@nemesis', 'desktop');
}
