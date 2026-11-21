import * as config from "./config.js";
import * as log from "./log.js";
import * as slack from "./slack.js";
import { getOpencodeAnthropicSpendUsd, getSpendWarningThreshold, recordSpendWarning } from "./db.js";

/** The `spend_warnings` key for OpenCode-on-Anthropic API spend. */
export const OPENCODE_SPEND_WARNING_KEY = "opencode-anthropic";

/**
 * Warn once in Slack when reported OpenCode-on-Anthropic spend reaches
 * `opencodeSpendWarnUsd` (0 disables it). It fires once per threshold value:
 * it warns again only when the operator raises the threshold and spend passes
 * the new one. Returns whether it warned. Never throws.
 */
export async function checkOpencodeSpend(): Promise<boolean> {
  try {
    const threshold = config.OPENCODE_SPEND_WARN_USD;
    if (!(threshold > 0)) return false;
    const spend = await getOpencodeAnthropicSpendUsd();
    if (spend < threshold) return false;
    const warnedAt = await getSpendWarningThreshold(OPENCODE_SPEND_WARNING_KEY);
    if (warnedAt !== null && warnedAt >= threshold) return false;
    await slack.notify(`:warning: OpenCode Anthropic API spend $${spend.toFixed(2)} has passed the $${threshold.toFixed(2)} warning threshold; see /usage`);
    await recordSpendWarning(OPENCODE_SPEND_WARNING_KEY, threshold);
    log.warn(`[opencode-spend] Reported OpenCode Anthropic API spend $${spend.toFixed(2)} passed the $${threshold.toFixed(2)} warning threshold`);
    return true;
  } catch (err) {
    log.warn(`[opencode-spend] OpenCode spend check failed: ${err}`);
    return false;
  }
}
