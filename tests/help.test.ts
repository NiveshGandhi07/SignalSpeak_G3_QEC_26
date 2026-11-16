// Tests for the Help card content. Test framework: Vitest (MIT) https://vitest.dev
// AI-assisted: written with help from Claude (Anthropic).
import { describe, expect, it } from "vitest";
import { controlLines, helpItems } from "../src/ui/help";

describe("help card", () => {
  it("explains eyebrow selection when the user has a usable brow raise", () => {
    const select = helpItems({ usesBrow: true, emergency: "twoLongBlinks", calibrate: "off", painCheck: true }).find((i) => i.title === "Select")!;
    expect(select.text).toMatch(/eyebrows/i);
  });
  it("explains look-and-hold otherwise", () => {
    const select = helpItems({ usesBrow: false, emergency: "twoLongBlinks", calibrate: "off", painCheck: true }).find((i) => i.title === "Select")!;
    expect(select.text).toMatch(/keep looking/i);
  });
  it("names the emergency gesture the user chose under Binds", () => {
    const em = helpItems({ usesBrow: true, emergency: "closedBrowRaises", calibrate: "off", painCheck: true }).find((i) => i.title === "Emergency")!;
    expect(em.text).toMatch(/raise eyebrows three times/i);
  });
  it("names the recalibrate gesture, and leaves it out when it is off", () => {
    const on = helpItems({ usesBrow: true, emergency: "twoLongBlinks", calibrate: "twoLongCloses", painCheck: true });
    expect(on.find((i) => i.title === "Recalibrate")?.text).toMatch(/close eyes 3 s/i);
    const off = helpItems({ usesBrow: true, emergency: "twoLongBlinks", calibrate: "off", painCheck: true });
    expect(off.find((i) => i.title === "Recalibrate")).toBeUndefined();
  });
  it("stays short", () => {
    const items = helpItems({ usesBrow: true, emergency: "twoLongCloses", calibrate: "twoLongBlinks", painCheck: true });
    expect(items.length).toBeLessThanOrEqual(7);
    for (const i of items) expect(i.text.length).toBeLessThan(130);
  });
  it("About me card lists this user's current controls", () => {
    const lines = controlLines({ usesBrow: false, emergency: "twoLongCloses", calibrate: "off", painCheck: false });
    expect(lines.map((l) => l.name)).toEqual(["Point", "Select", "Emergency", "Recalibrate", "Pain check"]);
    expect(lines[1].detail).toBe("Look and hold");
    expect(lines[2].detail).toMatch(/close eyes 3 s/i);
    expect(lines[3].detail).toBe("Calibrate tile only");
    expect(lines[4].detail).toBe("Off");
    expect(controlLines({ usesBrow: true, emergency: "twoLongBlinks", calibrate: "closedBrowRaises", painCheck: true })[3].detail).toMatch(/brow/i);
  });
});
