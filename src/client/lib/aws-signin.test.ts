// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createAwsSignInBlock, renderAwsSignIn, safeSignInUrl, signInMinutesLeft } from "./aws-signin.js";

describe("AWS sign-in block (#clw_01M8426RTMG1TWE224NXW1V02S)", () => {
  it("counts whole minutes left, and says expired once the code has expired", () => {
    expect(signInMinutesLeft(10 * 60_000, 0)).toBe("10 min left");
    expect(signInMinutesLeft(30_000, 0)).toBe("under a minute left");
    expect(signInMinutesLeft(0, 0)).toBe("expired");
    expect(signInMinutesLeft(-5, 0)).toBe("expired");
    expect(signInMinutesLeft(null, 0)).toBe("");
  });

  it("accepts only an https link", () => {
    expect(safeSignInUrl("https://device.sso.example/?user_code=A")).toBe("https://device.sso.example/?user_code=A");
    expect(safeSignInUrl("javascript:alert(1)")).toBeNull();
    expect(safeSignInUrl("http://device.sso.example/")).toBeNull();
    expect(safeSignInUrl("not a url")).toBeNull();
  });

  it("shows a new-tab link, the code on its own line and the minutes left, and hides without a sign-in", () => {
    const block = createAwsSignInBlock();
    expect(block.hidden).toBe(true);
    renderAwsSignIn(block, { verificationUrl: "https://device.sso.example/?user_code=A", userCode: "<b>ABCD</b>", expiresAt: 5 * 60_000 }, 0);
    const link = block.querySelector("a")!;
    expect(block.hidden).toBe(false);
    expect(link.textContent).toBe("Sign in to AWS");
    expect(link.getAttribute("href")).toBe("https://device.sso.example/?user_code=A");
    expect(link.target).toBe("_blank");
    expect(link.rel).toBe("noopener noreferrer");
    // The code goes in as text, never markup.
    expect(block.querySelector("code")!.textContent).toBe("Code: <b>ABCD</b>");
    expect(block.querySelector("b")).toBeNull();
    expect(block.querySelector(".cap-signin-left")!.textContent).toBe("5 min left");
    renderAwsSignIn(block, null);
    expect(block.hidden).toBe(true);
    renderAwsSignIn(block, { verificationUrl: "javascript:alert(1)", userCode: "X", expiresAt: null });
    expect(block.hidden).toBe(true);
  });
});
