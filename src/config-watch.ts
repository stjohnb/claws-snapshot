import { reloadConfig } from "./config.js";
import { knownConfigVersion, readStoredConfig, setKnownConfigVersion, withConfigLock, writeConfigFile } from "./config-store.js";
import * as log from "./log.js";

/**
 * Picks up config other processes published to the database store
 * (`src/config-store.ts`): when the stored version is newer than the one this
 * process last materialised or published, rewrites `CONFIG_PATH` and reloads,
 * which fires every `onConfigChange` listener. This process's own writes have
 * already bumped the known version, so they never trigger a second reload.
 */

let timer: ReturnType<typeof setInterval> | null = null;
let checking = false;

/**
 * One poll. Resolves true when it applied a newer stored version. Runs under
 * `withConfigLock`, so it never lands between this process's own publish and
 * its write of `CONFIG_PATH`.
 */
export async function checkStoredConfig(): Promise<boolean> {
  if (checking) return false;
  checking = true;
  try {
    return await withConfigLock(applyNewerStoredConfig);
  } finally {
    checking = false;
  }
}

async function applyNewerStoredConfig(): Promise<boolean> {
  try {
    const stored = await readStoredConfig();
    if (!stored || stored.version <= knownConfigVersion()) return false;
    writeConfigFile(stored.json);
    setKnownConfigVersion(stored.version);
    log.info(`[config-watch] Applied config version ${stored.version} published by another process`);
    reloadConfig();
    return true;
  } catch (err) {
    log.warn(`[config-watch] Config poll failed: ${err}`);
    return false;
  }
}

export function startConfigWatcher(intervalMs = 5000): void {
  if (timer) return;
  timer = setInterval(() => void checkStoredConfig(), intervalMs);
  timer.unref();
}

export function stopConfigWatcher(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
