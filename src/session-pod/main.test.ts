import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The pod has no Claws config, database or logger: importing the runtime must
// never touch them, directly or transitively.
vi.mock("../config.js", () => { throw new Error("session-pod must not import config.js"); });
vi.mock("../log.js", () => { throw new Error("session-pod must not import log.js"); });
vi.mock("../db.js", () => { throw new Error("session-pod must not import db.js"); });

const startTerminalServer = vi.fn();
vi.mock("./terminal-server.js", () => ({
  startTerminalServer: (...args: unknown[]) => startTerminalServer(...args),
  TerminalServerStartError: class TerminalServerStartError extends Error {},
}));

import {
  prepare,
  serve,
  setupHome,
  secureHome,
  resolveInHome,
  redactUrl,
  SessionLaunchSpecSchema,
  loadLaunchSpec,
  type GitRunner,
  type PodPaths,
} from "./main.js";

describe("session-pod/main.js import", () => {
  it("imports while config.js, log.js and db.js throw on import", async () => {
    const mod = await import("./main.js");
    expect(typeof mod.main).toBe("function");
  });
});

describe("session pod runtime", () => {
  let root: string;
  let paths: PodPaths;

  function spec(over: Record<string, unknown> = {}) {
    return SessionLaunchSpecSchema.parse({
      sessionId: "abc123",
      cwd: "work/org/app",
      command: ["zsh"],
      uploadDir: ".claws/session-uploads/abc123",
      ...over,
    });
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "session-pod-test-"));
    paths = {
      home: path.join(root, "home"),
      runtimeDir: path.join(root, "run"),
      secretDir: path.join(root, "secret"),
      skelDir: path.join(root, "skel"),
      skillsScript: path.join(root, "no-such-script.sh"),
    };
    for (const dir of [paths.home, paths.secretDir, paths.skelDir]) fs.mkdirSync(dir, { recursive: true });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    startTerminalServer.mockReset();
    startTerminalServer.mockResolvedValue({ port: 0, shutdown: async () => {} });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe("loadLaunchSpec", () => {
    it("parses the mounted launch spec with defaults", () => {
      fs.writeFileSync(path.join(paths.secretDir, "launch.json"), JSON.stringify({ sessionId: "abc", cwd: ".", command: [], uploadDir: "u" }));
      expect(loadLaunchSpec(paths.secretDir)).toMatchObject({ sessionId: "abc", repos: [], files: [], ssh: [] });
    });

    it("rejects unsafe secret key names", () => {
      expect(() => spec({ envFileKey: "../clone-env.json" })).toThrow();
      expect(() => spec({ ssh: [{ key: "ssh-key", name: ".." }] })).toThrow();
    });
  });

  it("redactUrl strips the credentials of every URL in the text", () => {
    const stderr = "Cloning into 'https://u:tok1@github.com/a.git'...\nfatal: unable to access 'https://x-access-token:tok2@github.com/a.git/'";
    const redacted = redactUrl(stderr);
    expect(redacted).not.toContain("tok1");
    expect(redacted).not.toContain("tok2");
    expect(redacted).toContain("'https://github.com/a.git/'");
  });

  it("resolveInHome refuses paths outside HOME", () => {
    expect(resolveInHome("/home/claws", "work/a")).toBe("/home/claws/work/a");
    expect(resolveInHome("/home/claws", "/home/claws")).toBe("/home/claws");
    expect(() => resolveInHome("/home/claws", "../etc/passwd")).toThrow("escapes HOME");
    expect(() => resolveInHome("/home/claws", "/home/clawsx")).toThrow("escapes HOME");
  });

  describe("prepare", () => {
    function fakeGit(fail?: (args: string[]) => boolean) {
      const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
      const run: GitRunner = async (args, env) => {
        calls.push({ args, env });
        if (fail?.(args)) return { code: 128, stderr: "fatal: could not read Username" };
        if (args[0] === "clone") fs.mkdirSync(path.join(args[3], ".git"), { recursive: true });
        return { code: 0, stderr: "" };
      };
      return { calls, run };
    }

    it("skips a dir that already has a checkout, without fetching or creating the branch", async () => {
      const existing = path.join(paths.home, "work/org/app");
      fs.mkdirSync(path.join(existing, ".git"), { recursive: true });
      fs.writeFileSync(path.join(existing, "uncommitted.txt"), "keep me");
      const git = fakeGit();

      const code = await prepare(
        spec({ repos: [{ url: "https://github.com/org/app.git", dir: "work/org/app", branch: "claws-wt/abc123" }] }),
        { paths, runGit: git.run },
      );

      expect(code).toBe(0);
      expect(git.calls).toEqual([]);
      expect(fs.readFileSync(path.join(existing, "uncommitted.txt"), "utf8")).toBe("keep me");
    });

    it("leaves a non-empty dir without .git untouched instead of failing every start", async () => {
      const existing = path.join(paths.home, "work/org/app");
      fs.mkdirSync(existing, { recursive: true });
      fs.writeFileSync(path.join(existing, "notes.txt"), "keep me");
      const git = fakeGit();

      const code = await prepare(
        spec({ repos: [{ url: "https://github.com/org/app.git", dir: "work/org/app", branch: "claws-wt/abc123" }] }),
        { paths, runGit: git.run },
      );

      expect(code).toBe(0);
      expect(git.calls).toEqual([]);
      expect(fs.readdirSync(existing)).toEqual(["notes.txt"]);
      expect(vi.mocked(console.warn).mock.calls.flat().join("\n")).toContain("exists without a checkout");
    });

    it("clones a missing repo and creates the branch only on the fresh clone", async () => {
      fs.writeFileSync(path.join(paths.secretDir, "clone-env.json"), JSON.stringify({
        GH_TOKEN: "ghs_tok",
        CLAWS_GIT_CREDENTIAL_TOKEN: "ghs_tok",
        GIT_CONFIG_COUNT: "1",
        PATH: "/service/path",
        HOME: "/service/home",
      }));
      fs.mkdirSync(path.join(paths.home, "work/org/done/.git"), { recursive: true });
      const git = fakeGit();

      const code = await prepare(spec({
        repos: [
          { url: "https://github.com/org/app.git", dir: "work/org/app", branch: "claws-wt/abc123" },
          { url: "https://github.com/org/done.git", dir: "work/org/done", branch: "claws-wt/abc123" },
          { url: "https://github.com/org/plain.git", dir: "work/org/plain" },
        ],
      }), { paths, runGit: git.run });

      expect(code).toBe(0);
      const appTmp = path.join(paths.home, "work/org/app.claws-clone");
      const plainTmp = path.join(paths.home, "work/org/plain.claws-clone");
      expect(git.calls.map((c) => c.args)).toEqual([
        ["clone", "--", "https://github.com/org/app.git", appTmp],
        ["-C", appTmp, "checkout", "-b", "claws-wt/abc123"],
        ["clone", "--", "https://github.com/org/plain.git", plainTmp],
      ]);
      expect(fs.existsSync(path.join(paths.home, "work/org/app/.git"))).toBe(true);
      expect(fs.existsSync(appTmp)).toBe(false);
      expect(git.calls[0].env).toMatchObject({ GH_TOKEN: "ghs_tok", CLAWS_GIT_CREDENTIAL_TOKEN: "ghs_tok", GIT_CONFIG_COUNT: "1" });
      expect(git.calls[0].env.PATH).not.toBe("/service/path");
      expect(git.calls[0].env.HOME).not.toBe("/service/home");
    });

    it("passes both the GitHub and the Forgejo credential helper to every clone of a mixed set", async () => {
      const cloneEnv = {
        GH_TOKEN: "ghs_tok",
        CLAWS_GIT_CREDENTIAL_TOKEN: "ghs_tok",
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
        GIT_CONFIG_VALUE_0: "!github-helper",
        GIT_CONFIG_KEY_1: "credential.https://git.example.test.helper",
        GIT_CONFIG_VALUE_1: "!forgejo-helper",
        CLAWS_FORGEJO_GIT_TOKEN: "fj_tok",
      };
      fs.writeFileSync(path.join(paths.secretDir, "clone-env.json"), JSON.stringify(cloneEnv));
      const git = fakeGit();

      const code = await prepare(spec({
        repos: [
          { url: "https://github.com/org/app.git", dir: "work/org/app" },
          { url: "https://git.example.test/org/forge.git", dir: "work/org/forge" },
        ],
      }), { paths, runGit: git.run });

      expect(code).toBe(0);
      const clones = git.calls.filter((c) => c.args[0] === "clone");
      expect(clones.map((c) => c.args[2])).toEqual(["https://github.com/org/app.git", "https://git.example.test/org/forge.git"]);
      for (const clone of clones) expect(clone.env).toMatchObject(cloneEnv);
    });

    describe("HOME permissions", () => {
      const uid = () => process.getuid!();

      it("strips world access from a HOME it owns, keeping the group bits", async () => {
        fs.chmodSync(paths.home, 0o777);
        expect(await prepare(spec(), { paths, runGit: fakeGit().run, getuid: uid })).toBe(0);
        const mode = fs.statSync(paths.home).mode;
        expect(mode & 0o7777).toBe(0o770);
      });

      it("keeps the setgid bit when stripping world access", () => {
        vi.spyOn(fs, "lstatSync").mockReturnValue({ mode: fs.constants.S_IFDIR | 0o2777, uid: 1234 } as fs.Stats);
        const chmodSync = vi.spyOn(fs, "chmodSync").mockImplementation(() => {});

        secureHome(paths.home, () => 1234);

        expect(chmodSync).toHaveBeenCalledWith(paths.home, 0o2770);
        expect(vi.mocked(console.log).mock.calls.flat().join("\n")).toContain("Removed world access");
      });

      it("leaves a HOME without world access untouched and says nothing about it", async () => {
        fs.chmodSync(paths.home, 0o770);
        expect(await prepare(spec(), { paths, runGit: fakeGit().run, getuid: uid })).toBe(0);
        expect(fs.statSync(paths.home).mode & 0o777).toBe(0o770);
        const logged = [...vi.mocked(console.log).mock.calls, ...vi.mocked(console.warn).mock.calls].flat().join("\n");
        expect(logged).not.toContain(paths.home);
      });

      it("warns and carries on when HOME is world-accessible but owned by someone else", async () => {
        fs.chmodSync(paths.home, 0o777);
        expect(await prepare(spec(), { paths, runGit: fakeGit().run, getuid: () => uid() + 1 })).toBe(0);
        expect(fs.statSync(paths.home).mode & 0o777).toBe(0o777);
        expect(vi.mocked(console.warn).mock.calls.flat().join("\n")).toContain("world-accessible");
      });
    });

    it("exits non-zero when a clone fails and leaves nothing behind", async () => {
      const git = fakeGit((args) => args[0] === "clone");
      const code = await prepare(
        spec({ repos: [{ url: "https://x-access-token:secret@github.com/org/app.git", dir: "work/org/app" }] }),
        { paths, runGit: git.run },
      );
      expect(code).toBe(1);
      expect(fs.existsSync(path.join(paths.home, "work/org/app"))).toBe(false);
      expect(fs.existsSync(path.join(paths.home, "work/org/app.claws-clone"))).toBe(false);
      const logged = vi.mocked(console.error).mock.calls.flat().join("\n");
      expect(logged).not.toContain("secret");
    });

    it("exits non-zero when branch creation fails and redacts credentials from stderr", async () => {
      const run: GitRunner = async (args) => {
        if (args[0] === "clone") {
          fs.mkdirSync(path.join(args[3], ".git"), { recursive: true });
          return { code: 0, stderr: "" };
        }
        return { code: 128, stderr: "fatal: unable to access 'https://x-access-token:secret@github.com/org/app.git/'" };
      };
      const code = await prepare(
        spec({ repos: [{ url: "https://github.com/org/app.git", dir: "work/org/app", branch: "claws-wt/abc123" }] }),
        { paths, runGit: run },
      );
      expect(code).toBe(1);
      expect(fs.existsSync(path.join(paths.home, "work/org/app"))).toBe(false);
      expect(fs.existsSync(path.join(paths.home, "work/org/app.claws-clone"))).toBe(false);
      const logged = vi.mocked(console.error).mock.calls.flat().join("\n");
      expect(logged).not.toContain("secret");
    });

    it("exits non-zero for a repo dir outside HOME", async () => {
      const git = fakeGit();
      expect(await prepare(spec({ repos: [{ url: "u", dir: "../escape" }] }), { paths, runGit: git.run })).toBe(1);
      expect(git.calls).toEqual([]);
    });
  });

  describe("setupHome", () => {
    it("seeds /etc/skel dotfiles recursively only when absent", () => {
      fs.writeFileSync(path.join(paths.skelDir, ".bashrc"), "skel bashrc");
      fs.writeFileSync(path.join(paths.skelDir, ".profile"), "skel profile");
      fs.mkdirSync(path.join(paths.skelDir, ".ssh"), { recursive: true });
      fs.writeFileSync(path.join(paths.skelDir, ".ssh/config"), "Host nas\n");
      fs.mkdirSync(path.join(paths.home, ".ssh"), { recursive: true });
      fs.writeFileSync(path.join(paths.home, ".bashrc"), "mine");
      fs.writeFileSync(path.join(paths.home, ".ssh/id_rsa"), "mine");
      setupHome(spec(), paths);
      expect(fs.readFileSync(path.join(paths.home, ".bashrc"), "utf8")).toBe("mine");
      expect(fs.readFileSync(path.join(paths.home, ".profile"), "utf8")).toBe("skel profile");
      expect(fs.readFileSync(path.join(paths.home, ".ssh/config"), "utf8")).toBe("Host nas\n");
      expect(fs.readFileSync(path.join(paths.home, ".ssh/id_rsa"), "utf8")).toBe("mine");
      fs.writeFileSync(path.join(paths.home, ".profile"), "edited profile");
      fs.writeFileSync(path.join(paths.home, ".ssh/config"), "Host edited\n");
      setupHome(spec(), paths);
      expect(fs.readFileSync(path.join(paths.home, ".profile"), "utf8")).toBe("edited profile");
      expect(fs.readFileSync(path.join(paths.home, ".ssh/config"), "utf8")).toBe("Host edited\n");
    });

    it("writes launch files, honouring onlyIfAbsent", () => {
      fs.writeFileSync(path.join(paths.home, ".gitconfig"), "user edited");
      setupHome(spec({
        files: [
          { path: ".gitconfig", content: "generated", onlyIfAbsent: true },
          { path: ".codex/config.toml", content: "model = 'x'" },
        ],
      }), paths);
      expect(fs.readFileSync(path.join(paths.home, ".gitconfig"), "utf8")).toBe("user edited");
      const toml = path.join(paths.home, ".codex/config.toml");
      expect(fs.readFileSync(toml, "utf8")).toBe("model = 'x'");
      expect(fs.statSync(toml).mode & 0o777).toBe(0o600);
      expect(() => setupHome(spec({ files: [{ path: "../outside", content: "x" }] }), paths)).toThrow("escapes HOME");
    });

    it("copies the session env file into the runtime dir at 0600", () => {
      fs.writeFileSync(path.join(paths.secretDir, "session.env"), "export A='1'\n", { mode: 0o440 });
      setupHome(spec({ envFileKey: "session.env" }), paths);
      const copied = path.join(paths.runtimeDir, "session.env");
      expect(fs.readFileSync(copied, "utf8")).toBe("export A='1'\n");
      expect(fs.statSync(copied).mode & 0o777).toBe(0o600);
    });

    it("materialises SSH private keys as Claws-owned symlinks in a real ~/.ssh directory", () => {
      fs.mkdirSync(path.join(paths.skelDir, ".ssh"), { recursive: true });
      fs.writeFileSync(path.join(paths.skelDir, ".ssh/config"), "Host nas\n");
      fs.writeFileSync(path.join(paths.secretDir, "ssh-key"), "PRIVATE");
      setupHome(spec({ ssh: [{ key: "ssh-key", name: "id_ed25519" }] }), paths);

      const homeSsh = path.join(paths.home, ".ssh");
      expect(fs.lstatSync(homeSsh).isDirectory()).toBe(true);
      expect(fs.readFileSync(path.join(homeSsh, "config"), "utf8")).toBe("Host nas\n");
      expect(fs.lstatSync(path.join(homeSsh, "id_ed25519")).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(path.join(homeSsh, "id_ed25519"), "utf8")).toBe("PRIVATE");
      expect(fs.statSync(path.join(paths.runtimeDir, "ssh/id_ed25519")).mode & 0o777).toBe(0o600);

      // Resume without an SSH grant: the owned key symlink goes, user config remains.
      setupHome(spec(), paths);
      expect(fs.existsSync(path.join(homeSsh, "id_ed25519"))).toBe(false);
      expect(fs.readFileSync(path.join(homeSsh, "config"), "utf8")).toBe("Host nas\n");
    });

    it("does not overwrite user-owned SSH key files when SSH is granted", () => {
      const homeSsh = path.join(paths.home, ".ssh");
      fs.mkdirSync(homeSsh);
      fs.writeFileSync(path.join(homeSsh, "id_rsa"), "user key");
      setupHome(spec(), paths);
      fs.writeFileSync(path.join(paths.secretDir, "ssh-key"), "PRIVATE");
      setupHome(spec({ ssh: [{ key: "ssh-key", name: "id_ed25519" }] }), paths);
      expect(fs.lstatSync(homeSsh).isDirectory()).toBe(true);
      expect(fs.readFileSync(path.join(homeSsh, "id_rsa"), "utf8")).toBe("user key");
      expect(fs.lstatSync(path.join(homeSsh, "id_ed25519")).isSymbolicLink()).toBe(true);
    });

    it.each(["dangling symlink", "directory symlink", "file"])("preserves user-owned ~/.ssh %s with SSH granted", (kind) => {
      const homeSsh = path.join(paths.home, ".ssh");
      const target = path.join(root, "user-ssh");
      if (kind === "file") {
        fs.writeFileSync(homeSsh, "user data", { mode: 0o644 });
      } else {
        if (kind === "directory symlink") {
          fs.mkdirSync(target, { mode: 0o755 });
          fs.writeFileSync(path.join(target, "config"), "user config");
        }
        fs.symlinkSync(target, homeSsh);
      }
      fs.mkdirSync(path.join(paths.skelDir, ".ssh"));
      fs.writeFileSync(path.join(paths.skelDir, ".ssh/config"), "default config");
      fs.writeFileSync(path.join(paths.secretDir, "ssh-key"), "PRIVATE");

      setupHome(spec({ ssh: [{ key: "ssh-key", name: "id_ed25519" }] }), paths);

      const runtimeKey = path.join(paths.runtimeDir, "ssh/id_ed25519");
      expect(fs.readFileSync(runtimeKey, "utf8")).toBe("PRIVATE");
      expect(fs.statSync(runtimeKey).mode & 0o777).toBe(0o600);
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(`granted SSH keys are in ${path.join(paths.runtimeDir, "ssh")}`));
      setupHome(spec(), paths);
      if (kind === "file") {
        expect(fs.readFileSync(homeSsh, "utf8")).toBe("user data");
        expect(fs.statSync(homeSsh).mode & 0o777).toBe(0o644);
      } else {
        expect(fs.readlinkSync(homeSsh)).toBe(target);
        if (kind === "directory symlink") {
          expect(fs.statSync(target).mode & 0o777).toBe(0o755);
          expect(fs.readdirSync(target)).toEqual(["config"]);
          expect(fs.readFileSync(path.join(target, "config"), "utf8")).toBe("user config");
        } else {
          expect(fs.existsSync(target)).toBe(false);
        }
      }
    });

    it.each([true, false])("migrates a dangling Claws-owned ~/.ssh link (SSH grant: %s)", (granted) => {
      fs.mkdirSync(path.join(paths.skelDir, ".ssh"), { recursive: true });
      fs.writeFileSync(path.join(paths.skelDir, ".ssh/config"), "Host nas\n");
      const oldRuntimeSsh = path.join(paths.runtimeDir, "ssh");
      fs.symlinkSync(oldRuntimeSsh, path.join(paths.home, ".ssh"));
      fs.writeFileSync(path.join(paths.secretDir, "ssh-key"), "PRIVATE");

      setupHome(spec({ ssh: granted ? [{ key: "ssh-key", name: "id_ed25519" }] : [] }), paths);

      const homeSsh = path.join(paths.home, ".ssh");
      expect(fs.lstatSync(homeSsh).isDirectory()).toBe(true);
      expect(fs.readFileSync(path.join(homeSsh, "config"), "utf8")).toBe("Host nas\n");
      expect(fs.existsSync(path.join(homeSsh, "id_ed25519"))).toBe(granted);
    });

    it.each([true, false])("preserves user directory symlinks during seeding (dangling: %s)", (dangling) => {
      const target = path.join(root, "user-config");
      if (!dangling) fs.mkdirSync(target);
      fs.symlinkSync(target, path.join(paths.home, ".config"));
      fs.mkdirSync(path.join(paths.skelDir, ".config"));
      fs.writeFileSync(path.join(paths.skelDir, ".config/default"), "default");
      setupHome(spec(), paths);
      expect(fs.readlinkSync(path.join(paths.home, ".config"))).toBe(target);
      expect(fs.existsSync(path.join(target, "default"))).toBe(false);
      expect(fs.existsSync(target)).toBe(!dangling);
    });

    it("copies the granted Codex auth.json only when absent", () => {
      fs.writeFileSync(path.join(paths.secretDir, "codex-auth.json"), '{"v":1}');
      const result = setupHome(spec({ codexHome: ".codex-session", codexAuthKey: "codex-auth.json" }), paths);
      const dest = path.join(paths.home, ".codex-session/auth.json");
      expect(result.codexHome).toBe(path.join(paths.home, ".codex-session"));
      expect(fs.readFileSync(dest, "utf8")).toBe('{"v":1}');
      expect(fs.statSync(dest).mode & 0o777).toBe(0o600);

      // Rotated inside the session; the next start must not overwrite it.
      fs.writeFileSync(dest, '{"v":2}');
      fs.writeFileSync(path.join(paths.secretDir, "codex-auth.json"), '{"v":3}');
      setupHome(spec({ codexHome: ".codex-session", codexAuthKey: "codex-auth.json" }), paths);
      expect(fs.readFileSync(dest, "utf8")).toBe('{"v":2}');
    });

    it("installs a gh shim that reads the mounted token and puts it first on PATH", () => {
      const { pathEnv } = setupHome(spec(), paths);
      const shimDir = path.join(paths.runtimeDir, "bin");
      expect(pathEnv.startsWith(`${shimDir}:`)).toBe(true);
      const shim = fs.readFileSync(path.join(shimDir, "gh"), "utf8");
      expect(shim).toContain(`'${path.join(paths.secretDir, "github-token")}'`);
      expect(shim).toContain("export GH_TOKEN");
      // The slot is empty until github-auth is granted (#3131): an empty file must not export GH_TOKEN.
      expect(shim).toContain(`if [ -s '${path.join(paths.secretDir, "github-token")}' ]; then`);
      expect(shim).toMatch(/exec '[^']*gh' "\$@"/);
      expect(fs.statSync(path.join(shimDir, "gh")).mode & 0o777).toBe(0o755);
    });
  });

  describe("pre-#3131 gitconfig (#3131)", () => {
    it("rewrites the old readable-token check so an empty slot is not a credential", () => {
      const gitconfig = path.join(paths.home, ".gitconfig");
      const old = `[credential "https://github.com"]\n\thelper = "!f() { test \\"$1\\" = get || exit 0; test -r /etc/claws-workload/github-token || exit 0; echo username=x-access-token; }; f"\n[user]\n\tname = "Me"\n`;
      fs.writeFileSync(gitconfig, old);
      setupHome(spec(), paths);
      const updated = fs.readFileSync(gitconfig, "utf8");
      expect(updated).toBe(old.replace("test -r /etc/claws-workload/github-token", "test -s /etc/claws-workload/github-token"));
      setupHome(spec(), paths);
      expect(fs.readFileSync(gitconfig, "utf8")).toBe(updated);
    });

    it("leaves a user's own gitconfig alone", () => {
      const gitconfig = path.join(paths.home, ".gitconfig");
      fs.writeFileSync(gitconfig, "[user]\n\tname = Me\n\t# test -r somewhere-else\n");
      setupHome(spec(), paths);
      expect(fs.readFileSync(gitconfig, "utf8")).toBe("[user]\n\tname = Me\n\t# test -r somewhere-else\n");
    });
  });

  describe("Claude Code first-run state (#3131)", () => {
    const readJson = (p: string) => JSON.parse(fs.readFileSync(p, "utf8"));

    it("marks onboarding done, trusts the checkouts and skips the bypass warning in a fresh HOME", () => {
      setupHome(spec({ claudeSetup: { theme: "auto", trustDirs: ["work/org/app"] } }), paths);
      const global = readJson(path.join(paths.home, ".claude.json"));
      expect(global).toEqual({
        hasCompletedOnboarding: true,
        projects: { [path.join(paths.home, "work/org/app")]: { hasTrustDialogAccepted: true } },
      });
      expect(fs.statSync(path.join(paths.home, ".claude.json")).mode & 0o777).toBe(0o600);
      expect(readJson(path.join(paths.home, ".claude", "settings.json"))).toEqual({ theme: "auto", skipDangerousModePermissionPrompt: true });
      expect(fs.existsSync(path.join(paths.home, ".claude.json.claws-tmp"))).toBe(false);
    });

    it("merges into what Claude Code already wrote and keeps the user's theme on resume", () => {
      const abs = path.join(paths.home, "work/org/app");
      fs.writeFileSync(path.join(paths.home, ".claude.json"), JSON.stringify({
        userID: "u1", numStartups: 4, projects: { [abs]: { allowedTools: ["Bash"] }, "/other": { hasTrustDialogAccepted: false } },
      }));
      fs.mkdirSync(path.join(paths.home, ".claude"));
      fs.writeFileSync(path.join(paths.home, ".claude", "settings.json"), JSON.stringify({ theme: "dark", model: "opus" }));

      setupHome(spec({ claudeSetup: { theme: "auto", trustDirs: ["work/org/app"] } }), paths);

      expect(readJson(path.join(paths.home, ".claude.json"))).toEqual({
        userID: "u1", numStartups: 4, hasCompletedOnboarding: true,
        projects: { [abs]: { allowedTools: ["Bash"], hasTrustDialogAccepted: true }, "/other": { hasTrustDialogAccepted: false } },
      });
      expect(readJson(path.join(paths.home, ".claude", "settings.json"))).toEqual({ theme: "dark", model: "opus", skipDangerousModePermissionPrompt: true });
    });

    it("leaves a file that is not a JSON object untouched", () => {
      fs.writeFileSync(path.join(paths.home, ".claude.json"), "{ not json");
      fs.mkdirSync(path.join(paths.home, ".claude"));
      fs.writeFileSync(path.join(paths.home, ".claude", "settings.json"), "[]");

      setupHome(spec({ claudeSetup: { theme: "auto", trustDirs: ["work/org/app"] } }), paths);

      expect(fs.readFileSync(path.join(paths.home, ".claude.json"), "utf8")).toBe("{ not json");
      expect(fs.readFileSync(path.join(paths.home, ".claude", "settings.json"), "utf8")).toBe("[]");
      expect(console.warn).toHaveBeenCalledTimes(2);
    });

    it("writes through a symlinked .claude.json instead of replacing the symlink (#3136)", () => {
      const elsewhere = path.join(root, "elsewhere.json");
      fs.writeFileSync(elsewhere, JSON.stringify({ userID: "u1" }));
      const linkPath = path.join(paths.home, ".claude.json");
      fs.symlinkSync(elsewhere, linkPath);
      fs.mkdirSync(path.join(paths.home, ".claude"));
      fs.writeFileSync(path.join(paths.home, ".claude", "settings.json"), "{}");

      setupHome(spec({ claudeSetup: { theme: "auto", trustDirs: ["work/org/app"] } }), paths);

      expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(linkPath)).toBe(elsewhere);
      expect(readJson(elsewhere)).toEqual({
        userID: "u1", hasCompletedOnboarding: true,
        projects: { [path.join(paths.home, "work/org/app")]: { hasTrustDialogAccepted: true } },
      });
      expect(fs.existsSync(`${elsewhere}.claws-tmp`)).toBe(false);
    });

    it("writes through a dangling symlinked .claude.json, creating the target instead of replacing the link (#3136)", () => {
      const elsewhere = path.join(root, "elsewhere.json");
      const linkPath = path.join(paths.home, ".claude.json");
      fs.symlinkSync(elsewhere, linkPath);
      fs.mkdirSync(path.join(paths.home, ".claude"));
      fs.writeFileSync(path.join(paths.home, ".claude", "settings.json"), "{}");

      setupHome(spec({ claudeSetup: { theme: "auto", trustDirs: ["work/org/app"] } }), paths);

      expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(linkPath)).toBe(elsewhere);
      expect(readJson(elsewhere)).toEqual({
        hasCompletedOnboarding: true,
        projects: { [path.join(paths.home, "work/org/app")]: { hasTrustDialogAccepted: true } },
      });
      expect(fs.existsSync(`${elsewhere}.claws-tmp`)).toBe(false);
    });

    it("only warns when seeding fails, and does nothing without claudeSetup", () => {
      expect(() => setupHome(spec({ claudeSetup: { theme: "auto", trustDirs: ["../escape"] } }), paths)).not.toThrow();
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("escapes HOME"));
      fs.mkdirSync(path.join(paths.home, ".claude.json"));
      expect(() => setupHome(spec({ claudeSetup: { theme: "auto", trustDirs: ["work/org/app"] } }), paths)).not.toThrow();
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Could not seed Claude Code state"));
      fs.rmSync(path.join(paths.home, ".claude.json"), { recursive: true });
      fs.rmSync(path.join(paths.home, ".claude.json"), { force: true });
      setupHome(spec(), paths);
      expect(fs.existsSync(path.join(paths.home, ".claude.json"))).toBe(false);
      expect(fs.existsSync(path.join(paths.home, ".claude", "settings.json"))).toBe(false);
    });
  });

  describe("serve", () => {
    it("passes CODEX_HOME from setupHome's custom codexHome to the terminal server env", async () => {
      await serve(spec({ codexHome: ".codex-session" }), paths);

      expect(startTerminalServer).toHaveBeenCalledTimes(1);
      const opts = startTerminalServer.mock.calls[0][0];
      expect(opts.env.CODEX_HOME).toBe(path.join(paths.home, ".codex-session"));
    });

    it("passes autoCompact only when the spec enables it (#3090)", async () => {
      await serve(spec({ autoCompactIdleMs: 1_800_000 }), paths);
      expect(startTerminalServer.mock.calls[0][0].autoCompact).toEqual({ idleMs: 1_800_000, claudeHome: paths.home });

      startTerminalServer.mockClear();
      await serve(spec({ autoCompactIdleMs: 0 }), paths);
      expect(startTerminalServer.mock.calls[0][0]).not.toHaveProperty("autoCompact");
    });
  });
});
