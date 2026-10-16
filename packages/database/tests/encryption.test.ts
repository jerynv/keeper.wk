import { describe, expect, it } from "vitest";
import { decryptPassword, encryptPassword } from "../src";

// 32 zero bytes, base64: a fixed key so the test needs no secret.
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

describe("encryption at rest (workerd)", () => {
  it("round-trips a secret and never stores it in the clear", () => {
    const sealed = encryptPassword("app-specific-password", KEY);
    expect(sealed).not.toContain("app-specific-password");
    expect(decryptPassword(sealed, KEY)).toBe("app-specific-password");
  });

  it("uses a fresh nonce every time", () => {
    expect(encryptPassword("same", KEY)).not.toBe(encryptPassword("same", KEY));
  });

  it("refuses a tampered ciphertext", () => {
    const [nonce, body] = encryptPassword("secret", KEY).split(":");
    const tampered = `${nonce}:${(body ?? "").slice(0, -4)}AAA=`;
    expect(() => decryptPassword(tampered, KEY)).toThrow("Decryption failed");
  });
});
