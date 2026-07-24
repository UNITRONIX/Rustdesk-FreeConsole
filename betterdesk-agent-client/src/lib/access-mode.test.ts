import { describe, expect, it } from "vitest";

/** Access mode contract mirrored from Rust AccessMode enum. */
type AccessMode = "supervised" | "unattended" | "disabled";

function requiresConsent(mode: AccessMode): boolean {
  return mode === "supervised";
}

function isDisabled(mode: AccessMode): boolean {
  return mode === "disabled";
}

describe("access_mode contract", () => {
  it("supervised requires consent", () => {
    expect(requiresConsent("supervised")).toBe(true);
    expect(requiresConsent("unattended")).toBe(false);
  });

  it("disabled blocks sessions", () => {
    expect(isDisabled("disabled")).toBe(true);
    expect(isDisabled("unattended")).toBe(false);
  });
});
