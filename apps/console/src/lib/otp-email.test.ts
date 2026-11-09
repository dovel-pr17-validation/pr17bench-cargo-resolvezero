import { describe, expect, test } from "vitest";

import { otpEmail } from "./otp-email";

describe("otpEmail", () => {
  test("puts the code in the subject so it previews in the inbox", () => {
    expect(otpEmail("123456", "sign-in").subject).toContain("123456");
  });

  test("includes the code, expiry, and a no-action line in the text part", () => {
    const { text } = otpEmail("987654", "sign-in", 10);
    expect(text).toContain("987654");
    expect(text).toContain("10 minutes");
    expect(text).toContain("ignore this email");
  });

  test("includes the code and expiry in the html part", () => {
    const { html } = otpEmail("111222", "email-verification", 5);
    expect(html).toContain("111222");
    expect(html).toContain("5 minutes");
    expect(html).toContain("Confirm your email");
  });

  test("uses a specific heading per type", () => {
    expect(otpEmail("1", "forget-password").text).toContain("Reset your access");
    expect(otpEmail("1", "change-email").text).toContain("Confirm your new email");
  });

  test("escapes nothing risky (digits only) and keeps the brand line", () => {
    const { text } = otpEmail("424242", "sign-in");
    expect(text).toContain("ResolveZero");
  });
});

describe("otpEmail (precision template)", () => {
  test("carries the configured expiry into both parts", () => {
    const { text, html } = otpEmail("555111", "sign-in", 3);
    expect(text).toContain("3 minutes");
    expect(html).toContain("3 minutes");
  });

  test("includes the anti-phishing line", () => {
    expect(otpEmail("1", "sign-in").text).toContain("Never share this code");
    expect(otpEmail("1", "sign-in").html).toContain("Never share this code");
  });

  test("uses the current palette instead of the old orange accent", () => {
    const { html } = otpEmail("1", "sign-in");
    expect(html).toContain("#faf9f7");
    expect(html).not.toContain("#ff4d00");
    expect(html).not.toContain("#fffdf8");
  });
});

describe("otpEmail brand mark", () => {
  test("renders the mark as text, not a remote/inline image", () => {
    const { html } = otpEmail("1", "sign-in");
    expect(html).toContain("R&Oslash;");
    expect(html).not.toContain("<img");
  });
});
