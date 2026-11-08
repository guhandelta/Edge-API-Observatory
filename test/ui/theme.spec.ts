import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyTheme, getInitialTheme } from "../../src/theme";

beforeEach(() => {
  localStorage.clear();
  document.head.innerHTML = '<meta name="theme-color" content="#ffffff">';
  delete document.documentElement.dataset.theme;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("theme preference", () => {
  it("honors an explicit saved light or dark choice", () => {
    localStorage.setItem("edge-api-observatory-theme", "dark");
    expect(getInitialTheme()).toBe("dark");
    localStorage.setItem("edge-api-observatory-theme", "light");
    expect(getInitialTheme()).toBe("light");
  });

  it("falls back to the system preference when storage is empty or invalid", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    expect(getInitialTheme()).toBe("dark");
    localStorage.setItem("edge-api-observatory-theme", "other");
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
    expect(getInitialTheme()).toBe("light");
    vi.stubGlobal("matchMedia", undefined);
    expect(getInitialTheme()).toBe("light");
  });

  it("still selects a theme when storage cannot be read", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    expect(getInitialTheme()).toBe("dark");
  });

  it("updates the palette and meta color without saving the system default", () => {
    applyTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe("#191c2e");
    expect(localStorage.getItem("edge-api-observatory-theme")).toBeNull();
    applyTheme("light", true);
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe("#f0eff1");
    expect(localStorage.getItem("edge-api-observatory-theme")).toBe("light");
  });

  it("switches even when storage writes fail and the meta tag is absent", () => {
    document.head.innerHTML = "";
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(() => applyTheme("dark", true)).not.toThrow();
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});
