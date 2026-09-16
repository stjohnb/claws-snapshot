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
    it("seeds /etc/skel dotfiles only when absent", () => {
      fs.writeFileSync(path.join(paths.skelDir, ".bashrc"), "skel bashrc");
      fs.writeFileSync(path.join(paths.skelDir, ".profile"), "skel profile");
      fs.writeFileSync(path.join(paths.home, ".bashrc"), "mine");
      setupHome(spec(), paths);
      expect(fs.readFileSync(path.join(paths.home, ".bashrc"), "utf8")).toBe("mine");
      expect(fs.readFileSync(path.join(paths.home, ".profile"), "utf8")).toBe("skel profile");
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

    it("materialises SSH files behind a ~/.ssh symlink and removes it when SSH is no longer granted", () => {
      fs.writeFileSync(path.join(paths.secretDir, "ssh-key"), "PRIVATE");
      fs.writeFileSync(path.join(paths.secretDir, "ssh-known-hosts"), "host key");
      setupHome(spec({ ssh: [{ key: "ssh-key", name: "id_ed25519" }, { key: "ssh-known-hosts", name: "known_hosts" }, { key: "ssh-config", name: "config" }] }), paths);

      const homeSsh = path.join(paths.home, ".ssh");
      expect(fs.lstatSync(homeSsh).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(path.join(homeSsh, "id_ed25519"), "utf8")).toBe("PRIVATE");
      expect(fs.statSync(path.join(homeSsh, "id_ed25519")).mode & 0o777).toBe(0o600);
      expect(fs.existsSync(path.join(homeSsh, "config"))).toBe(false);

      // Resume without an SSH grant: the stale symlink goes.
      setupHome(spec(), paths);
      expect(fs.existsSync(homeSsh)).toBe(false);
    });

    it("leaves a real ~/.ssh directory alone", () => {
      const homeSsh = path.join(paths.home, ".ssh");
      fs.mkdirSync(homeSsh);
      fs.writeFileSync(path.join(homeSsh, "id_rsa"), "user key");
      setupHome(spec(), paths);
      fs.writeFileSync(path.join(paths.secretDir, "ssh-key"), "PRIVATE");
      setupHome(spec({ ssh: [{ key: "ssh-key", name: "id_ed25519" }] }), paths);
      expect(fs.lstatSync(homeSsh).isDirectory()).toBe(true);
      expect(fs.readFileSync(path.join(homeSsh, "id_rsa"), "utf8")).toBe("user key");
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
      expect(shim).toMatch(/exec '[^']*gh' "\$@"/);
      expect(fs.statSync(path.join(shimDir, "gh")).mode & 0o777).toBe(0o755);
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
