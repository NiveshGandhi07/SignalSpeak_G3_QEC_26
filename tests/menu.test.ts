// Tests for the menu navigation state machine. Test framework: Vitest (MIT) https://vitest.dev
// AI-assisted: written with help from Claude (Anthropic).
import { describe, expect, it } from "vitest";
import { BACK_ID, breadcrumb, buildMenus, currentMenu, initialNav, MENUS, selectItem, visibleItems } from "../src/ui/menu";
import { parseEnabled, toggleMacro } from "../src/macros/catalog";

const ids = (nav = initialNav()) => visibleItems(nav).map((i) => i.id);

describe("menu", () => {
  it("home shows the eight top-level tiles and no Back", () => {
    expect(ids()).toEqual(["care", "yes", "no", "emergency", "about", "macros", "binds", "calibrate"]);
  });

  it("Yes / No speak without leaving home", () => {
    const r = selectItem(initialNav(), "yes");
    expect(r.action).toEqual({ kind: "speak", text: "Yes", quick: true });
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

describe("about me", () => {
  it("opens a card screen with Back and Read aloud", () => {
    const nav = selectItem(initialNav(), "about").nav;
    expect(currentMenu(nav).view).toBe("about");
    expect(ids(nav)).toEqual([BACK_ID, "about-read"]);
    expect(selectItem(nav, "about-read").action?.kind).toBe("speak");
  });
});

describe("macros", () => {
  it("shows the enabled shortcuts plus Edit", () => {
    const menus = buildMenus(["youtube", "calculator"]);
    const nav = selectItem(initialNav(), "macros", menus).nav;
    expect(visibleItems(nav, menus).map((i) => i.id)).toEqual([BACK_ID, "macro-youtube", "macro-calculator", "macro-edit"]);
    expect(selectItem(nav, "macro-youtube", menus).action).toEqual({ kind: "openMacro", macroId: "youtube" });
  });

  it("edit screen marks enabled shortcuts and toggles them", () => {
    const menus = buildMenus(["youtube"]);
    let nav = selectItem(initialNav(), "macros", menus).nav;
    nav = selectItem(nav, "macro-edit", menus).nav;
    const items = visibleItems(nav, menus);
    expect(items.find((i) => i.id === "toggle-youtube")?.checked).toBe(true);
    expect(items.find((i) => i.id === "toggle-netflix")?.checked).toBe(false);
    expect(selectItem(nav, "toggle-netflix", menus).action).toEqual({ kind: "toggleMacro", macroId: "netflix" });
  });

  it("toggleMacro adds/removes and keeps catalogue order", () => {
    expect(toggleMacro(["calculator"], "youtube")).toEqual(["youtube", "calculator"]);
    expect(toggleMacro(["youtube", "calculator"], "youtube")).toEqual(["calculator"]);
    expect(toggleMacro(["youtube"], "not-a-macro")).toEqual(["youtube"]);
  });

  it("parseEnabled sanitises stored data", () => {
    expect(parseEnabled(["netflix", "evil", 3])).toEqual(["netflix"]);
    expect(parseEnabled("garbage")).toContain("youtube"); // falls back to defaults
  });
});
