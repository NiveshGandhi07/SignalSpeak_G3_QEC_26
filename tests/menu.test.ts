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
    expect(r.action).toEqual({ kind: "speak", text: "My pain is 7 out of 10", goHome: true, notify: "plain" });
    expect(r.nav.stack).toEqual(["home"]);
  });

  it("assistance requests notify the caregiver; Yes/No and About me do not", () => {
    const care = selectItem(initialNav(), "care").nav;
    expect(selectItem(care, "call").action).toMatchObject({ kind: "speak", notify: "ack" });
    expect(selectItem(care, "water").action).toMatchObject({ kind: "speak", notify: "plain" });
    expect(selectItem(initialNav(), "yes").action).not.toHaveProperty("notify");
    const about = selectItem(initialNav(), "about").nav;
    expect(selectItem(about, "about-read").action).not.toHaveProperty("notify");
  });

  it("every caregiver need is reachable", () => {
    const care = selectItem(initialNav(), "care").nav;
    expect(ids(care)).toEqual([BACK_ID, "call", "pain", "water", "washroom", "reposition", "temp"]);
    const temp = selectItem(care, "temp").nav;
    expect(selectItem(temp, "hot").action).toMatchObject({ kind: "speak", text: "I am too hot" });
    expect(selectItem(temp, "cold").action).toMatchObject({ kind: "speak", text: "I am too cold" });
  });

  it("binds has one screen per bind, each showing the current gesture", () => {
    const nav = selectItem(initialNav(), "binds").nav;
    expect(ids(nav)).toEqual([BACK_ID, "binds-emergency", "binds-calibrate", "binds-painCheck"]);
    expect(visibleItems(nav).find((i) => i.id === "binds-emergency")?.sub).toBe("Two long blinks");
    expect(visibleItems(nav).find((i) => i.id === "binds-calibrate")?.sub).toBe("Two 3-second closes");
  });

  it("emergency bind screen lists the gestures with the current one checked", () => {
    let nav = selectItem(initialNav(), "binds").nav;
    nav = selectItem(nav, "binds-emergency").nav;
    expect(ids(nav)).toEqual([BACK_ID, "bind-twoLongBlinks", "bind-closedBrowRaises", "bind-twoLongCloses"]);
    const items = visibleItems(nav);
    expect(items.find((i) => i.id === "bind-twoLongBlinks")?.checked).toBe(true);
    expect(items.find((i) => i.id === "bind-closedBrowRaises")?.checked).toBe(false);
    const taken = items.find((i) => i.id === "bind-twoLongCloses")!;
    expect(taken.sub).toBe("In use for Recalibrate");
    expect(taken.disabled).toBe(true);
    expect(selectItem(nav, "bind-twoLongCloses")).toEqual({ nav, action: null }); // can't be picked
    expect(selectItem(nav, "bind-closedBrowRaises").action).toEqual({ kind: "setBind", key: "emergency", value: "closedBrowRaises" });
    const after = buildMenus(["youtube"], { emergency: "closedBrowRaises", calibrate: "twoLongCloses", painCheck: true });
    expect(visibleItems(nav, after).find((i) => i.id === "bind-closedBrowRaises")?.checked).toBe(true);
  });

  it("recalibrate bind screen offers the gestures plus Off, and flags the emergency one", () => {
    let nav = selectItem(initialNav(), "binds").nav;
    nav = selectItem(nav, "binds-calibrate").nav;
    expect(ids(nav)).toEqual([BACK_ID, "calbind-twoLongBlinks", "calbind-closedBrowRaises", "calbind-twoLongCloses", "calbind-off"]);
    const items = visibleItems(nav);
    expect(items.find((i) => i.id === "calbind-twoLongCloses")?.checked).toBe(true);
    expect(items.find((i) => i.id === "calbind-twoLongBlinks")?.sub).toBe("In use for Emergency");
    expect(items.find((i) => i.id === "calbind-twoLongBlinks")?.disabled).toBe(true);
    expect(selectItem(nav, "calbind-twoLongBlinks").action).toBeNull();
    expect(selectItem(nav, "calbind-closedBrowRaises").action).toEqual({ kind: "setBind", key: "calibrate", value: "closedBrowRaises" });
    expect(selectItem(nav, "calbind-off").action).toEqual({ kind: "setBind", key: "calibrate", value: "off" });
  });

  it("pain check: toggle under Binds; prompt screen offers Yes (pain scale) or No (home)", () => {
    const binds = selectItem(initialNav(), "binds").nav;
    expect(selectItem(binds, "binds-painCheck").action).toEqual({ kind: "togglePainCheck" });
    const check = { stack: ["home", "painCheck"] };
    expect(ids(check)).toEqual([BACK_ID, "painCheck-yes", "painCheck-no"]);
    expect(currentMenu(selectItem(check, "painCheck-yes").nav).id).toBe("pain");
    const no = selectItem(check, "painCheck-no");
    expect(no.action).toEqual({ kind: "home" });
    expect(no.nav.stack).toEqual(["home"]);
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
