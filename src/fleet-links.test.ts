import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Repo } from "./config.js";

const { state } = vi.hoisted(() => ({ state: { root: "", forgejo: new Set<string>() } }));

vi.mock("./config.js", () => {
  const webUrlForRepo = (fullName: string): string =>
    state.forgejo.has(fullName.toLowerCase()) ? `https://git.example/${fullName}` : `https://github.com/${fullName}`;
  return {
    webUrlForRepo,
    webUrlForRepoFile: (fullName: string, branch: string, filePath: string): string =>
      `${webUrlForRepo(fullName)}/${state.forgejo.has(fullName.toLowerCase()) ? "src/branch" : "blob"}/${branch}/${filePath}`,
  };
});
vi.mock("./log.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("./claude.js", () => ({
  repoDir: (repo: Repo) => path.join(state.root, repo.owner, repo.name),
  ensureClone: vi.fn(async () => undefined),
}));
const { mockGh, mockRepoConfig } = vi.hoisted(() => ({
  mockGh: { listRepos: vi.fn(), isRepoListDegraded: vi.fn(() => false) },
  mockRepoConfig: { getRepoConfig: vi.fn((_fullName: string): unknown => null) },
}));
vi.mock("./github.js", () => mockGh);
vi.mock("./repo-config.js", () => mockRepoConfig);

import {
  scanFleetLinks,
  renderRelatedRepositoriesSection,
  upsertRelatedRepositoriesSection,
  sectionDigest,
  getFleetLinks,
  _resetFleetLinksCacheForTests,
  type FleetLink,
} from "./fleet-links.js";
import * as log from "./log.js";

const OWNER = "St-John-Software";
function repo(name: string, defaultBranch = "main"): Repo {
  return { owner: OWNER, name, fullName: `${OWNER}/${name}`, defaultBranch };
}
function write(name: string, rel: string, content: string): void {
  const p = path.join(state.root, OWNER, name, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}
function clone(name: string): void {
  fs.mkdirSync(path.join(state.root, OWNER, name), { recursive: true });
}

beforeEach(() => {
  state.root = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-links-"));
  state.forgejo = new Set();
  mockRepoConfig.getRepoConfig.mockReturnValue(null);
  mockGh.isRepoListDegraded.mockReturnValue(false);
  vi.mocked(log.warn).mockClear();
  _resetFleetLinksCacheForTests();
});

afterEach(() => {
  fs.rmSync(state.root, { recursive: true, force: true });
});

describe("scanFleetLinks", () => {
  it("links an app to the infra workflow it dispatches via the Forgejo API", async () => {
    write("whyrr", ".forgejo/workflows/ci.yml", "run: curl -X POST $URL/api/v1/repos/St-John-Software/fleet-infra/actions/workflows/update-whyrr.yml/dispatches\n");
    write("fleet-infra", ".forgejo/workflows/update-whyrr.yml", "on: workflow_dispatch\n");

    const links = await scanFleetLinks([repo("whyrr"), repo("fleet-infra")]);

    expect(links).toEqual([{
      target: `${OWNER}/whyrr`, source: `${OWNER}/fleet-infra`, relation: "deploys",
      sourcePath: ".forgejo/workflows/update-whyrr.yml", targetPath: ".forgejo/workflows/ci.yml", evidence: "dispatch",
    }]);
  });

  it("links a gh workflow run dispatch on GitHub, in either argument order", async () => {
    write("namey", ".github/workflows/deploy.yml", [
      "run: gh workflow run deploy-namey.yml --repo St-John-Software/production-infra -f tag=1",
      "run: gh workflow run -R St-John-Software/production-infra other.yml",
    ].join("\n"));
    write("production-infra", ".github/workflows/deploy-namey.yml", "on: workflow_dispatch\n");
    write("production-infra", ".github/workflows/other.yml", "on: workflow_dispatch\n");

    const links = await scanFleetLinks([repo("namey"), repo("production-infra")]);

    expect(links.map((l) => l.sourcePath)).toEqual([".github/workflows/deploy-namey.yml", ".github/workflows/other.yml"]);
    expect(links.every((l) => l.evidence === "dispatch" && l.target === `${OWNER}/namey`)).toBe(true);
  });

  it("drops a dispatch whose workflow does not exist in the dispatched repo's clone", async () => {
    write("whyrr", ".forgejo/workflows/ci.yml", "repos/St-John-Software/fleet-infra/actions/workflows/gone.yml/dispatches\n");
    clone("fleet-infra");

    expect(await scanFleetLinks([repo("whyrr"), repo("fleet-infra")])).toEqual([]);
  });

  it("links manifest image references, including registry.bstjohn.net and a -migrate suffix", async () => {
    clone("bonkus");
    clone("whyrr");
    write("production-infra", "k8s/bonkus/deployment.yaml", [
      "        image: registry.bstjohn.net/st-john-software/bonkus:abc",
      "        - image: \"registry.bstjohn.net/st-john-software/bonkus-migrate:abc\"",
    ].join("\n"));
    write("production-infra", "k8s/whyrr/kustomization.yml", "  newName: ghcr.io/St-John-Software/whyrr@sha256:1\n");
    write("production-infra", "k8s/other/deployment.yaml", "image: registry.home.bstjohn.net/st-john-software/whyrr-migrate:1\n");
    write("production-infra", "docs/example.yaml", "image: registry.bstjohn.net/st-john-software/bonkus:1\n");

    const links = await scanFleetLinks([repo("bonkus"), repo("whyrr"), repo("production-infra")]);

    expect(links.map((l) => [l.target, l.sourcePath, l.evidence])).toEqual([
      [`${OWNER}/bonkus`, "k8s/bonkus/deployment.yaml", "image"],
      [`${OWNER}/whyrr`, "k8s/other/deployment.yaml", "image"],
      [`${OWNER}/whyrr`, "k8s/whyrr/kustomization.yml", "image"],
    ]);
  });

  it("ignores a -suffix image when the scanning repo has no exact image for that name", async () => {
    clone("bonkus");
    write("production-infra", "k8s/deployment.yaml", "image: registry.bstjohn.net/st-john-software/bonkus-migrate:abc\n");

    expect(await scanFleetLinks([repo("bonkus"), repo("production-infra")])).toEqual([]);
  });

  it("links an OIDC trust-policy subject as provisions and ignores comments", async () => {
    clone("3d-models");
    clone("fleet-infra");
    write("bstjohn-blog", "tofu/3d-models-deploy-role.tf", [
      "# see St-John-Software/fleet-infra#899 and \"repo:St-John-Software/fleet-infra:ref\"",
      "  values = [\"repo:St-John-Software/3d-models:pull_request\"]",
    ].join("\n"));

    const links = await scanFleetLinks([repo("bstjohn-blog"), repo("3d-models"), repo("fleet-infra")]);

    expect(links).toEqual([{
      target: `${OWNER}/3d-models`, source: `${OWNER}/bstjohn-blog`, relation: "provisions",
      sourcePath: "tofu/3d-models-deploy-role.tf", evidence: "oidc",
    }]);
  });

  it("takes declared claws.json entries, dropping one whose path is missing or whose target is unmanaged", async () => {
    clone("production-infra");
    write("bstjohn-blog", "tofu/zone.tf", "resource {}\n");
    mockRepoConfig.getRepoConfig.mockImplementation((fullName: string) => fullName === `${OWNER}/bstjohn-blog`
      ? { deploys: [
        { repo: `${OWNER}/production-infra`, path: "tofu/zone.tf", relation: "provisions" },
        { repo: `${OWNER}/production-infra`, path: "tofu/missing.tf" },
        { repo: `${OWNER}/unmanaged`, path: "tofu/zone.tf" },
      ] }
      : null);

    const links = await scanFleetLinks([repo("bstjohn-blog"), repo("production-infra")]);

    expect(links).toEqual([{
      target: `${OWNER}/production-infra`, source: `${OWNER}/bstjohn-blog`, relation: "provisions",
      sourcePath: "tofu/zone.tf", evidence: "declared",
    }]);
    expect(vi.mocked(log.warn)).toHaveBeenCalledTimes(2);
  });

  it("excludes self-references, unmanaged targets and uncloned repos", async () => {
    write("whyrr", "docker-compose.yml", "image: registry.bstjohn.net/st-john-software/whyrr:1\n");
    write("whyrr", "k8s/app.yaml", "image: ghcr.io/st-john-software/not-managed:1\n");
    write("whyrr", ".forgejo/workflows/ci.yml", "repos/St-John-Software/fleet-infra/actions/workflows/update-whyrr.yml/dispatches\n");

    expect(await scanFleetLinks([repo("whyrr"), repo("fleet-infra")])).toEqual([]);
  });

  it("keeps the most authoritative evidence for a duplicate link", async () => {
    clone("whyrr");
    write("fleet-infra", "apps/whyrr/deployment.yaml", "image: registry.home.bstjohn.net/st-john-software/whyrr:1\n");
    mockRepoConfig.getRepoConfig.mockImplementation((fullName: string) => fullName === `${OWNER}/fleet-infra`
      ? { deploys: [{ repo: `${OWNER}/whyrr`, path: "apps/whyrr/deployment.yaml" }] }
      : null);

    const links = await scanFleetLinks([repo("whyrr"), repo("fleet-infra")]);

    expect(links).toHaveLength(1);
    expect(links[0].evidence).toBe("declared");
  });
});

describe("renderRelatedRepositoriesSection", () => {
  const repos = [repo("whyrr"), repo("fleet-infra", "master"), repo("legacy")];
  const links: FleetLink[] = [
    { target: `${OWNER}/whyrr`, source: `${OWNER}/fleet-infra`, relation: "deploys", sourcePath: ".forgejo/workflows/update-whyrr.yml", targetPath: ".forgejo/workflows/ci.yml", evidence: "dispatch" },
    { target: `${OWNER}/whyrr`, source: `${OWNER}/fleet-infra`, relation: "deploys", sourcePath: "apps/whyrr/deployment.yaml", evidence: "image" },
    { target: `${OWNER}/legacy`, source: `${OWNER}/fleet-infra`, relation: "configures", sourcePath: "apps/legacy/config.yaml", evidence: "declared" },
  ];

  it("links each side on the forge that hosts it", () => {
    state.forgejo = new Set([`${OWNER}/whyrr`.toLowerCase(), `${OWNER}/fleet-infra`.toLowerCase()]);

    const section = renderRelatedRepositoriesSection(`${OWNER}/whyrr`, links, repos);

    expect(section).toContain("## Related repositories");
    expect(section).toContain("**Deployed, configured or provisioned by:**");
    expect(section).not.toContain("**Deploys, configures or provisions:**");
    expect(section).toContain(`[${OWNER}/fleet-infra](https://git.example/${OWNER}/fleet-infra)`);
    expect(section).toContain(`(https://git.example/${OWNER}/fleet-infra/src/branch/master/.forgejo/workflows/update-whyrr.yml) (deploys, dispatch from`);
    expect(section).toContain(`(https://git.example/${OWNER}/whyrr/src/branch/main/.forgejo/workflows/ci.yml)`);
    expect(section).not.toContain("github.com");
    // One bullet per related repo.
    expect(section.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(1);
  });

  it("lists outbound links and uses GitHub URLs for a GitHub-hosted repo", () => {
    state.forgejo = new Set([`${OWNER}/fleet-infra`.toLowerCase()]);

    const section = renderRelatedRepositoriesSection(`${OWNER}/fleet-infra`, links, repos);

    expect(section).toContain("**Deploys, configures or provisions:**");
    expect(section).toContain(`- [${OWNER}/legacy](https://github.com/${OWNER}/legacy): `);
    expect(section).toContain("(configures, declared)");
    expect(section.indexOf(`${OWNER}/legacy`)).toBeLessThan(section.indexOf(`[${OWNER}/whyrr]`));
  });

  it("states that no relationship was found rather than guessing", () => {
    const section = renderRelatedRepositoriesSection(`${OWNER}/lonely`, links, repos);

    expect(section).toContain("No deployment, configuration or provisioning relationship");
    expect(section).not.toContain("- [");
  });

  it("is deterministic regardless of input order and duplicates", () => {
    const a = renderRelatedRepositoriesSection(`${OWNER}/whyrr`, links, repos);
    const b = renderRelatedRepositoriesSection(`${OWNER}/whyrr`, [...links].reverse().concat(links), repos);
    expect(b).toBe(a);
    expect(sectionDigest(b)).toBe(sectionDigest(a));
  });
});

describe("upsertRelatedRepositoriesSection", () => {
  const section = "## Related repositories\n\nNew content.\n";

  it("appends the section when absent", () => {
    expect(upsertRelatedRepositoriesSection("# Overview\n\nText.\n", section))
      .toBe("# Overview\n\nText.\n\n## Related repositories\n\nNew content.\n");
  });

  it("replaces only the section, up to the next ## heading", () => {
    const md = "# Overview\n\n## Related repositories\n\n- old link\n\n### Sub\n\nold\n\n## Configuration\n\nKeep.\n";
    expect(upsertRelatedRepositoriesSection(md, section))
      .toBe("# Overview\n\n## Related repositories\n\nNew content.\n\n## Configuration\n\nKeep.\n");
  });

  it("is idempotent", () => {
    const once = upsertRelatedRepositoriesSection("# Overview\n\n## Related repositories\n\nold\n\n## Next\n", section);
    expect(upsertRelatedRepositoriesSection(once, section)).toBe(once);
    const atEnd = upsertRelatedRepositoriesSection("# Overview\n", section);
    expect(upsertRelatedRepositoriesSection(atEnd, section)).toBe(atEnd);
  });
});

describe("getFleetLinks", () => {
  it("caches the scan and dedupes concurrent calls", async () => {
    mockGh.listRepos.mockResolvedValue([repo("whyrr")]);

    const [a, b] = await Promise.all([getFleetLinks(), getFleetLinks()]);
    await getFleetLinks();

    expect(a).toBe(b);
    expect(mockGh.listRepos).toHaveBeenCalledTimes(1);
  });

  it("refuses to scan a degraded repo list", async () => {
    mockGh.listRepos.mockResolvedValue([repo("whyrr")]);
    mockGh.isRepoListDegraded.mockReturnValue(true);

    await expect(getFleetLinks()).rejects.toThrow("degraded");
  });
});
