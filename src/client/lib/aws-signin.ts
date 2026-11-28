// The AWS sign-in block shown while Claws waits for the operator to sign in
// for an approved `aws-*` capability (#clw_01M8426RTMG1TWE224NXW1V02S): a
// "Sign in to AWS" link opening in a new tab, the code on its own line in
// monospace, and the minutes left. Shared by the session page and the
// Sessions list. Values only ever reach the DOM through textContent and
// attributes; the link is accepted only over https.

import { safeSignInUrl, signInMinutesLeft } from "../../aws-signin-format.js";

export { safeSignInUrl, signInMinutesLeft };

export interface AwsSignIn {
  verificationUrl: string;
  userCode: string;
  expiresAt: number | null;
}

/** Build an empty, hidden sign-in block; fill it with `renderAwsSignIn`. */
export function createAwsSignInBlock(): HTMLElement {
  const block = document.createElement("div");
  block.className = "cap-signin";
  block.hidden = true;
  const link = document.createElement("a");
  link.className = "cap-signin-link";
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = "Sign in to AWS";
  const code = document.createElement("code");
  code.className = "cap-signin-code";
  const left = document.createElement("span");
  left.className = "cap-signin-left";
  block.append(link, code, left);
  return block;
}

/** Show `signIn` in `block`, or hide it when null (or when its link is not https). */
export function renderAwsSignIn(block: HTMLElement, signIn: AwsSignIn | null | undefined, now: number = Date.now()): void {
  const href = signIn ? safeSignInUrl(signIn.verificationUrl) : null;
  if (!signIn || !href) {
    block.hidden = true;
    return;
  }
  const link = block.querySelector<HTMLAnchorElement>(".cap-signin-link");
  const code = block.querySelector<HTMLElement>(".cap-signin-code");
  const left = block.querySelector<HTMLElement>(".cap-signin-left");
  if (link && link.getAttribute("href") !== href) link.setAttribute("href", href);
  if (code) code.textContent = "Code: " + signIn.userCode;
  if (left) left.textContent = signInMinutesLeft(signIn.expiresAt, now);
  block.hidden = false;
}
