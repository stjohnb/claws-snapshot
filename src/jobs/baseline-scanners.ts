/**
 * Every per-repo `ScannerSpec`, so `claws_create_repo` can check a seed tree
 * against the same `scan` functions the daily scanners run
 * (`validateSeedTree` in `repo-seed.ts`). A guard test fails when a module
 * under `src/jobs/` declares a `ScannerSpec` that is not listed here, so a new
 * scanner or contract rule fails that test instead of filing an issue against
 * the next created repo.
 */
import type { ScannerSpec } from "./scanner-runner.js";
import { SPEC as CACHE_ON_SELF_HOSTED } from "./cache-on-self-hosted-scanner.js";
import { MISSING_CONFIG_SPEC as CLAUDE_CONFIG } from "./claude-config-scanner.js";
import { SPEC as CONCURRENCY } from "./concurrency-scanner.js";
import { SPEC as DESIGN_GUIDELINES } from "./design-guidelines-scanner.js";
import { SPEC as HOST_POLICY } from "./host-policy-scanner.js";
import { SPEC as ISSUE_COMMENT_SPAM } from "./issue-comment-spam-scanner.js";
import { SPEC as MIGRATION } from "./migration-scanner.js";
import { SPEC as OBSERVABILITY_CONTRACT } from "./observability-contract-scanner.js";
import { SPEC as RUNNER_OS } from "./runner-os-scanner.js";
import { SPEC as SECURITY_CONTRACT } from "./security-contract-scanner.js";
import { SPEC as UBUNTU_LATEST } from "./ubuntu-latest-scanner.js";

export const BASELINE_SCANNER_SPECS: readonly ScannerSpec[] = [
  CACHE_ON_SELF_HOSTED,
  CLAUDE_CONFIG,
  CONCURRENCY,
  DESIGN_GUIDELINES,
  HOST_POLICY,
  ISSUE_COMMENT_SPAM,
  MIGRATION,
  OBSERVABILITY_CONTRACT,
  RUNNER_OS,
  SECURITY_CONTRACT,
  UBUNTU_LATEST,
];
