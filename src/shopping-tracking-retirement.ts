/**
 * One-off close of the retired `[shopping]` tracking issue
 * (#clw_01M533FKWN23CRBXXRTDABBHAH). The central shopping sourcer and its
 * comment processor are gone; each repo now publishes its own shopping lists.
 * Idempotent: an issue that is already closed, or missing, is left alone. This
 * file can be deleted once production has booted on it.
 */
import * as config from "./config.js";
import * as clawsIssues from "./claws-issues.js";
import * as gh from "./github.js";
import * as log from "./log.js";

export const RETIRED_SHOPPING_TRACKING_ISSUE = "clw_01M34R5RF8KCQAY9KWT9NV0FYA";

export const RETIRED_SHOPPING_TRACKING_NOTE = `Claws' central shopping feature is retired (#clw_01M533FKWN23CRBXXRTDABBHAH): no daily sourcer, no comment processing, and this issue is no longer maintained. Each repo now publishes its own shopping lists, with purchase options sourced while each issue is delivered:

- electronics: https://pages.home.bstjohn.net/electronics/docs/main/ (Shopping in the site nav)
- nixos-config: https://pages.home.bstjohn.net/nixos-config/docs/main/
- astro: https://pages.home.bstjohn.net/astro/docs/main/

To change a list, open an ordinary issue in that repo.`;

/** Comment on and close the retired tracking issue if it is still open. */
export async function closeRetiredShoppingTrackingIssue(): Promise<void> {
  const issue = await clawsIssues.getIssue(RETIRED_SHOPPING_TRACKING_ISSUE);
  if (!issue || issue.state !== "open") return;
  await gh.commentOnIssue(config.SELF_REPO, RETIRED_SHOPPING_TRACKING_ISSUE, RETIRED_SHOPPING_TRACKING_NOTE);
  await gh.closeIssue(config.SELF_REPO, RETIRED_SHOPPING_TRACKING_ISSUE, "completed");
  log.info(`[shopping-retirement] Closed retired [shopping] tracking issue #${RETIRED_SHOPPING_TRACKING_ISSUE}`);
}
