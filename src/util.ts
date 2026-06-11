import os from "node:os";

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Expand a leading `~/` in a path to the user's home directory. */
export function resolveIdentityFile(filePath: string): string {
  if (filePath.startsWith("~/")) {
    return os.homedir() + filePath.slice(1);
  }
  return filePath;
}
