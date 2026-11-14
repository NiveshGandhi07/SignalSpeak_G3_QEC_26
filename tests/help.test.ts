// Tests for the Help card content. Test framework: Vitest (MIT) https://vitest.dev
// AI-assisted: written with help from Claude (Anthropic).
import { describe, expect, it } from "vitest";
import { helpItems } from "../src/ui/help";

describe("help card", () => {
  it("explains eyebrow selection when the user has a usable brow raise", () => {
    const select = helpItems({ usesBrow: true, emergency: "twoLongBlinks" }).find((i) => i.title === "Select")!;
    expect(select.text).toMatch(/eyebrows/i);
  });
  it("explains look-and-hold otherwise", () => {
    const select = helpItems({ usesBrow: false, emergency: "twoLongBlinks" }).find((i) => i.title === "Select")!;
    expect(select.text).toMatch(/keep looking/i);
  });
  it("names the emergency gesture the user chose under Binds", () => {
    const em = helpItems({ usesBrow: true, emergency: "closedBrowRaises" }).find((i) => i.title === "Emergency")!;
    expect(em.text).toMatch(/raise eyebrows three times/i);
  });
  it("stays short", () => {
    const items = helpItems({ usesBrow: true, emergency: "twoLongCloses" });
    expect(items.length).toBeLessThanOrEqual(6);
    for (const i of items) expect(i.text.length).toBeLessThan(130);
  });
});
