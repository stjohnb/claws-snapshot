/**
 * Canonical automation-host execution policy: each agent runs in a worktree
 * inside its own Kubernetes agent pod, alongside the Claws helper processes
 * that record its run. This module is the single source of truth for both the
 * prompt-injected form (`HOST_EXECUTION_POLICY`) and the per-repo
 * documentation form (`HOST_POLICY_MARKDOWN`) that `host-policy-scanner`
 * checks for. Zero-dependency leaf module — do not import anything here.
 */

export const HOST_EXECUTION_POLICY = `<automation_host>
You are working in a git worktree inside your own Kubernetes agent pod (6 GiB memory limit, no CPU limit, 24 GiB ephemeral storage, on a 16-core / 32 GB node). The pod is yours: install dependencies (\`npm ci\` installs dev dependencies with no extra flags, but builds native modules only for packages the repo approves in \`package.json\` \`allowScripts\` — claws does), build, and run the checks the repo itself defines (its \`package.json\` scripts, Taskfile and flake checks) before you finish; never invent a check the repo lacks, such as a \`lint\` script in a \`package.json\` that has none. The image provides bash, node/npm, python3, jq, make/g++, git, rg and nix. Infra tools (\`task\`, \`kustomize\`, \`yq\`, \`yamllint\`, \`kubeconform\`, \`actionlint\`) exist only inside the repo's flake devShell, so run \`nix develop --command task validate\` (or \`nix develop --command <tool>\`), never bare \`task validate\`. CI stays the source of truth: leave end-to-end and browser tests, container image builds, and anything needing a live app or a cluster to CI. Do NOT start dev servers or other long-running processes (\`npm run dev\`, \`npm start\`, \`docker compose up\`, file watchers, tunnels, \`serve\`). Do NOT install system packages or browser binaries at runtime — no \`sudo\`, no \`apt-get install\`, no \`npx playwright install\`, no \`brew install\`, no \`nix profile install\`; a tool the repo's checks need belongs in that repo's \`flake.nix\` devShell, and a tool the pod image lacks is an issue for St-John-Software/claws. NEVER kill a process or free a port you do not own: \`lsof -ti:PORT | xargs kill\` and \`pkill -f node\` kill the Claws helper processes that record your run. If a port you want is busy, use a different one or stop and say so in your output. If the memory watchdog ends a build, report it rather than retrying.
</automation_host>`;

/** Which repo docs a planning/implementation agent should read, and in what order (#3082). */
export const REPO_DOCS_CONTEXT = `If \`docs/PRODUCT.md\` exists, read it first, then only the product area doc(s) under \`docs/product/\` relevant to this issue. If \`docs/OVERVIEW.md\` exists, read it too, and any linked docs that seem relevant. Don't read every doc.`;

export const HOST_POLICY_HEADING = "## Automation host policy";

export const HOST_POLICY_MARKDOWN = `${HOST_POLICY_HEADING}

Claws agents run in their own Kubernetes pod (6 GiB memory limit, no CPU limit, 24 GiB
ephemeral storage). When working on this repo as an agent:

- **Run the repo's local checks before pushing.** Install dependencies (\`npm ci\`), build,
  and run type-check, lint, unit tests, \`task validate\`, \`nix develop -c …\` with the repo's
  own flake devShell, and kustomize builds. CI stays the source of truth for end-to-end
  and browser tests, container image builds, and anything needing a live app or a cluster.
- **Do not start dev servers or other long-running processes** (\`npm run dev\`, \`npm start\`,
  \`docker compose up\`, watchers, tunnels).
- **Do not install system packages or browser binaries** at runtime: no \`sudo\`, no
  \`apt-get install\`, no \`npx playwright install\`, no \`brew install\`. A tool the checks need
  belongs in \`flake.nix\`; a tool the pod image lacks is an issue for St-John-Software/claws.
- **Never kill a process or free a port you do not own.** \`lsof -ti:PORT | xargs kill\` and
  \`pkill -f node\` kill the Claws helper processes that record your run.`;

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
 * Extracts the automation-host-policy section from an `AGENTS.md`-shaped
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
