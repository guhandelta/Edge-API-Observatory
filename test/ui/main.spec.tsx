import ReactDOM from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-dom/client", () => ({
  default: { createRoot: vi.fn(() => ({ render: vi.fn() })) },
}));

describe("dashboard bootstrap", () => {
  it("applies the saved palette before mounting React", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    document.head.innerHTML = '<meta name="theme-color" content="#ffffff">';
    localStorage.setItem("edge-api-observatory-theme", "dark");
    await import("../../src/main");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe("#191c2e");
    expect(ReactDOM.createRoot).toHaveBeenCalledWith(document.getElementById("root"));
    const root = vi.mocked(ReactDOM.createRoot).mock.results[0].value;
    expect(root.render).toHaveBeenCalledOnce();
  });
});
