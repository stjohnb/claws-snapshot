/**
 * Canonical automation-host execution policy: agents run in a worktree on
 * Claws' own shared, resource-constrained host, which also runs the Claws
 * service itself. This module is the single source of truth for both the
 * prompt-injected form (`HOST_EXECUTION_POLICY`) and the per-repo
 * documentation form (`HOST_POLICY_MARKDOWN`) that `host-policy-scanner`
 * checks for. Zero-dependency leaf module — do not import anything here.
 */

export const HOST_EXECUTION_POLICY = `<automation_host>
You are working in a git worktree on Claws' own automation host — a shared, resource-constrained machine (5 GB memory cap, disk at 80%) that also runs the Claws service itself. Do NOT start dev servers or other long-running processes (\`npm run dev\`, \`npm start\`, \`docker compose up\`, file watchers, tunnels, \`serve\`). Verify with fast one-shot checks — type-check, lint, unit tests; anything that needs a live app or an end-to-end browser is CI's job and CI is the source of truth for it. Do NOT install system packages or browser binaries on this host — no \`sudo\`, no \`apt-get install\`, no \`npx playwright install\`, no \`brew install\`. If CI is missing a tool, add it to that repo's \`flake.nix\` devShell in the same PR. NEVER kill a process or free a port you do not own: \`lsof -ti:3000 -sTCP:LISTEN | xargs -r kill\` and \`pkill -f node\` take down the Claws service itself, whose dashboard listens on port 3000. If a port you want is busy, use a different one or stop and say so in your output.
</automation_host>`;

export const HOST_POLICY_HEADING = "## Automation host policy";

export const HOST_POLICY_MARKDOWN = `${HOST_POLICY_HEADING}

Claws agents work on a shared, resource-constrained automation host that also runs the
Claws service itself. When working on this repo as an agent:

- **Do not start dev servers or other long-running processes** (\`npm run dev\`, \`npm start\`,
  \`docker compose up\`, watchers, tunnels). Verify with fast one-shot checks — type-check,
  lint, unit tests — and let CI run anything that needs a live app or an end-to-end browser.
- **Do not install system packages or browser binaries** on the host: no \`sudo\`, no
  \`apt-get install\`, no \`npx playwright install\`, no \`brew install\`. If CI needs a tool,
  add it to \`flake.nix\` in the same PR.
- **Never kill a process or free a port you do not own.** \`lsof -ti:PORT | xargs kill\` and
  \`pkill -f node\` will take down the Claws service, whose dashboard listens on port 3000.`;

export interface HostPolicyRule {
  id: string;
  label: string;
  detect: RegExp;
}

export const HOST_POLICY_RULES: readonly HostPolicyRule[] = [
  {
    id: "dev-servers",
    label: "No dev servers or long-running processes on the host",
    detect: /dev server|long-running|npm run dev|docker compose up/i,
  },
  {
    id: "installs",
    label: "No system-package or browser-binary installs on the host",
    detect: /apt-get|\bsudo\b|playwright install|brew install|system package/i,
  },
  {
    id: "ports",
    label: "Never kill processes / free ports you don't own",
    detect: /\bport\b|\bkill\b|lsof|\bpkill\b/i,
  },
];

const HOST_POLICY_SECTION_HEADING =
  /^(#{1,6})[ \t]*.*\b(automation host|agent host|host policy|claws host)\b.*$/im;

/**
 * Extracts the automation-host-policy section from a CLAUDE.md-shaped
 * document: from the matching heading up to (exclusive) the next
 * same-or-higher-level heading, or end of file. Returns null when no
 * heading matches, so callers never accidentally test rule regexes
 * against the whole file (a repo can mention `npm run dev` in an
 * unrelated CI paragraph and still lack any host policy).
 */
export function findHostPolicySection(text: string): string | null {
  const lines = text.split("\n");
  let startIndex = -1;
  let level = 0;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(HOST_POLICY_SECTION_HEADING);
    if (match) {
      startIndex = i;
      level = match[1].length;
      break;
    }
  }
  if (startIndex === -1) return null;

  let endIndex = lines.length;
  for (let i = startIndex + 1; i < lines.length; i++) {
    const headingMatch = lines[i].match(/^(#{1,6})[ \t]/);
    if (headingMatch && headingMatch[1].length <= level) {
      endIndex = i;
      break;
    }
  }

  return lines.slice(startIndex, endIndex).join("\n");
}

/** Rules from HOST_POLICY_RULES not covered by the document's host-policy section. */
export function missingHostPolicyRules(text: string): readonly HostPolicyRule[] {
  const section = findHostPolicySection(text);
  if (!section) return HOST_POLICY_RULES;
  return HOST_POLICY_RULES.filter((r) => !r.detect.test(section));
}
