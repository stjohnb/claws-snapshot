# CI/dev environment for claws.
#
# The org's CI runs on self-hosted NixOS runners (`ryzen`, `beefy-actions`),
# and the runners deliberately provide almost nothing beyond `nix`, `git` and
# docker. Every tool a workflow shells out to comes from THIS file, entered
# via `nix develop` — that is what keeps repos with conflicting toolchains
# able to share the same runner machines: each repo's dependencies live in
# the nix store keyed by hash, isolated by construction, instead of being
# installed globally on the runner.
#
# So: if CI needs a new tool, add it to the matching devShell below. Never
# `sudo apt-get install` (NixOS runners have no apt or sudo), never
# `actions/setup-node` (its prebuilt tarball hardcodes /lib64/ld-linux and
# only works on NixOS through the nix-ld shim), never ask for the tool to be
# added to the runner's own package set.
{
  description = "claws — dev and CI toolchain";

  # nixpkgs-unstable: the same channel the runner hosts are built from
  # (see nixos-config's flake.nix for why the runners track unstable).
  # The pin here is independent — flake.lock in this repo decides what CI
  # actually gets, and bumping it is this repo's own decision.
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems
        (system: f nixpkgs.legacyPackages.${system});
    in
    {
      devShells = forAllSystems (pkgs: {
        # Everything `npm ci && npm run build && npm test` needs. mkShell's
        # stdenv already puts a C compiler, make, and the usual coreutils/
        # grep/sed/awk on PATH — those cover node-gyp's native builds
        # (better-sqlite3, node-pty) except for python3, which node-gyp
        # invokes explicitly.
        default = pkgs.mkShell {
          packages = with pkgs; [
            nodejs_24 # keep the major in sync with the systemd unit on the deploy host
            python3
          ];
        };

        # Small shell for the maintenance/notification workflows that never
        # touch node: notify-failures.yml (gh) and history-cleanup.yml
        # (git-filter-repo). Separate from `default` so those jobs don't pay
        # for the node toolchain closure.
        scripts = pkgs.mkShell {
          packages = with pkgs; [
            gh
            git-filter-repo
          ];
        };
      });
    };
}
