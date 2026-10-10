import fs from "node:fs";

export function isContainer(): boolean {
  const explicit = process.env["CLAWS_RUNTIME"];
  if (explicit === "container") return true;
  if (explicit === "host") return false;
  if (process.env["KUBERNETES_SERVICE_HOST"]) return true;
  try {
    return fs.existsSync("/.dockerenv");
  } catch {
    return false;
  }
}
