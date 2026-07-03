import path from 'node:path';

export function resolveGeaUserDataPath(env: NodeJS.ProcessEnv, appDataPath: string): string {
  const e2ePath = env.GEA_E2E_USER_DATA?.trim();
  if (e2ePath) return e2ePath;
  return path.join(appDataPath, '@nemesis', 'global-event-alpha');
}
