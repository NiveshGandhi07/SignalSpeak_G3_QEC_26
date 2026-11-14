// Tests for the menu navigation state machine. Test framework: Vitest (MIT) https://vitest.dev
// AI-assisted: written with help from Claude (Anthropic).
import { describe, expect, it } from "vitest";
import { BACK_ID, breadcrumb, currentMenu, initialNav, MENUS, selectItem, visibleItems } from "../src/ui/menu";

const ids = (nav = initialNav()) => visibleItems(nav).map((i) => i.id);

describe("menu", () => {
  it("home shows the six top-level tiles and no Back", () => {
    expect(ids()).toEqual(["care", "yes", "no", "emergency", "binds", "calibrate"]);
  });

  it("Yes / No speak without leaving home", () => {
    const r = selectItem(initialNav(), "yes");
    expect(r.action).toEqual({ kind: "speak", text: "Yes" });
    expect(currentMenu(r.nav).id).toBe("home");
  });

  it("Emergency and Calibrate trigger their actions", () => {
    expect(selectItem(initialNav(), "emergency").action?.kind).toBe("emergency");
    expect(selectItem(initialNav(), "calibrate").action?.kind).toBe("calibrate");
  });

  it("sub-menus always start with Back, and Back returns one level", () => {
    const care = selectItem(initialNav(), "care").nav;
    expect(ids(care)[0]).toBe(BACK_ID);
    expect(breadcrumb(care)).toBe("Home › Caregiver / Assistance");
    expect(currentMenu(selectItem(care, BACK_ID).nav).id).toBe("home");
  });

  it("Back at home is a no-op", () => {
    expect(selectItem(initialNav(), BACK_ID).nav.stack).toEqual(["home"]);
  });

  it("pain 1-10 is two levels deep, speaks the level, then returns home", () => {
    let nav = selectItem(initialNav(), "care").nav;
    nav = selectItem(nav, "pain").nav;
    expect(ids(nav)).toHaveLength(11); // Back + 1..10
    const r = selectItem(nav, "pain-7");
    expect(r.action).toEqual({ kind: "speak", text: "My pain is 7 out of 10", goHome: true });
    expect(r.nav.stack).toEqual(["home"]);
  });

  it("every caregiver need is reachable", () => {
    const care = selectItem(initialNav(), "care").nav;
    expect(ids(care)).toEqual([BACK_ID, "call", "pain", "water", "washroom", "reposition", "temp"]);
    const temp = selectItem(care, "temp").nav;
    expect(selectItem(temp, "hot").action).toMatchObject({ kind: "speak", text: "I am too hot" });
    expect(selectItem(temp, "cold").action).toMatchObject({ kind: "speak", text: "I am too cold" });
  });

  it("binds has scroll + click placeholders", () => {
    const binds = selectItem(initialNav(), "binds").nav;
    expect(ids(binds)).toEqual([BACK_ID, "bind-scroll", "bind-click"]);
    expect(selectItem(binds, "bind-click").action?.kind).toBe("placeholder");
  });

  it("unknown ids don't change state", () => {
    const nav = initialNav();
    expect(selectItem(nav, "nope")).toEqual({ nav, action: null });
  });

  it("every submenu reference points at a real menu", () => {
    for (const m of Object.values(MENUS))
      for (const i of m.items) if (i.submenu) expect(MENUS[i.submenu]).toBeDefined();
  });
});
