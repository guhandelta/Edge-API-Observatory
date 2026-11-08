import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProbeRun } from "../../shared/contracts";
import App from "../../src/App";

/** Match the persisted API shape so dashboard tests exercise the real contract. */
function run(id: string, overrides: Partial<ProbeRun> = {}): ProbeRun {
  return {
    id,
    requestId: id,
    targetId: "sample-post",
    createdAt: "2026-11-08T12:00:00.000Z",
    directDurationMs: 10,
    browserPostRoundTripMs: null,
    directStatus: 200,
    directError: null,
    workerFetchDurationMs: 8,
    workerHandlerDurationMs: 9,
    workerStatus: 200,
    workerError: null,
    workerErrorCategory: "none",
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("dashboard integration", () => {
  it("runs three and five same-target pairs and switches the saved theme", async () => {
    let nextId = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/probes" && !init) return Response.json([]);
      if (url === "/api/demo/success") return Response.json({ ok: true });
      if (url === "/api/probes" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { targetId: string; directStatus: number };
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        nextId += 1;
        return Response.json(run(String(nextId), {
          targetId: body.targetId, directStatus: body.directStatus,
        }), { status: 201 });
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App initialTheme="light" />);
    expect(await screen.findByText("No Worker results for this endpoint yet.")).toBeTruthy();
    expect(screen.getByText("No measurements yet.")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Switch to dark mode" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(screen.getByRole("button", { name: "Switch to light mode" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Switch to light mode" }));
    expect(document.documentElement.dataset.theme).toBe("light");

    await user.selectOptions(screen.getByRole("combobox", { name: "Target API" }), "demo-success");
    expect(screen.getByText(/Controlled demo: both paths/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Run 3 pairs →" }));
    expect(await screen.findByRole("heading", { name: /Demo · success · 3\/3 pairs/ })).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Last batch median comparison" }))
      .getByText(/Small sample/)).toBeTruthy();
    const batch = screen.getByRole("region", { name: "Last batch median comparison" });
    expect(within(batch).getByText("Worker handler median").parentElement?.querySelector("strong")?.textContent)
      .toBe("9 ms");
    expect(within(batch).getByText("Browser POST round trip median").parentElement?.querySelector("strong")?.textContent)
      .toMatch(/^[1-9]\d* ms$/);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(3);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")
      .every(([, init]) => !Object.hasOwn(JSON.parse(String(init?.body)) as object, "browserPostRoundTripMs"))).toBe(true);

    await user.selectOptions(screen.getByRole("combobox", { name: "Pairs to run" }), "5");
    await user.click(screen.getByRole("button", { name: "Run 5 pairs →" }));
    expect(await screen.findByRole("heading", { name: /Demo · success · 5\/5 pairs/ })).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(8);
  });

  it("renders stored status families, missing measurements, and target-specific history", async () => {
    const rows = [
      run("success"),
      run("redirect", { workerStatus: 302, directStatus: 302 }),
      run("client-error", { workerStatus: 404, workerErrorCategory: "http_error", directStatus: 404 }),
      run("server-error", { workerStatus: 503, workerErrorCategory: "http_error", directStatus: 503 }),
      run("transport", {
        directDurationMs: null, directStatus: null, directError: "cors_or_network_error",
        workerFetchDurationMs: null, workerStatus: null, workerError: "network_error",
        workerErrorCategory: "network_error",
      }),
      ...Array.from({ length: 6 }, (_, index) => run(`extra-${index}`, {
        directDurationMs: index === 0 ? 0 : 10 + index,
      })),
      run("other-target", { targetId: "demo-error", workerStatus: 503, workerErrorCategory: "http_error" }),
    ];
    let releaseHistory: ((response: Response) => void) | undefined;
    const pendingHistory = new Promise<Response>((resolve) => { releaseHistory = resolve; });
    vi.stubGlobal("fetch", vi.fn(() => pendingHistory));
    render(<App initialTheme="dark" />);
    expect(screen.getByText("Loading history…")).toBeTruthy();
    releaseHistory!(Response.json(rows));
    expect(await screen.findByRole("img", { name: /2xx: 7, 3xx: 1, 4xx: 1, 5xx: 1, Fetch error: 1/ })).toBeTruthy();
    expect(screen.queryByText(/Small sample: fewer than 10/)).toBeNull();
    expect(screen.getAllByRole("row")).toHaveLength(9);
    expect(screen.getByLabelText("Recent direct and Worker upstream durations")).toBeTruthy();

    const user = userEvent.setup();
    await user.selectOptions(screen.getByRole("combobox", { name: "Target API" }), "demo-error");
    expect(screen.getByRole("img", { name: /5xx: 1/ })).toBeTruthy();
    expect(screen.getByText(/Small sample: fewer than 10/)).toBeTruthy();
    expect(screen.getAllByRole("row")).toHaveLength(2);
  });

  it.each([
    [Response.json({ error: "D1 unavailable" }, { status: 500 }), "D1 unavailable"],
    [Response.json({}, { status: 500 }), "HTTP 500"],
  ])("shows a readable history error from an unsuccessful API response", async (response, message) => {
    vi.stubGlobal("fetch", vi.fn(async () => response));
    render(<App initialTheme="light" />);
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining(message));
  });

  it("handles non-Error history failures without hiding the empty dashboard", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw "offline"; }));
    render(<App initialTheme="light" />);
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("Could not load history"));
    expect(screen.getByText("No measurements yet.")).toBeTruthy();
  });

  it("shows an unknown status as unavailable rather than inventing a result", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json([
      run("unknown", {
        directDurationMs: null, directStatus: null, directError: null,
        workerFetchDurationMs: null, workerHandlerDurationMs: null,
        workerStatus: null, workerError: null,
        workerErrorCategory: "network_error",
      }),
    ])));
    render(<App initialTheme="light" />);
    await screen.findAllByText("Unavailable");
    const rows = await screen.findAllByRole("row");
    expect(rows).toHaveLength(2);
    expect(within(rows[1]).getAllByText("—")).toHaveLength(2);
    expect(within(rows[1]).getAllByText("Unavailable")).toHaveLength(4);
  });

  it("keeps completed pairs when a later API request fails", async () => {
    let postCount = 0;
    const directBodies: Array<{ directStatus: number | null; directError: string | null }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/probes" && !init) return Response.json([]);
      if (url === "/api/demo/error") {
        if (postCount === 0) {
          const timeout = new Error("timed out");
          timeout.name = "TimeoutError";
          throw timeout;
        }
        throw "browser network failure";
      }
      if (url === "/api/probes" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { directStatus: number | null; directError: string | null };
        directBodies.push(body);
        postCount += 1;
        return postCount === 1
          ? Response.json(run("first", { targetId: "demo-error", directDurationMs: null,
            directStatus: null, directError: body.directError }))
          : Response.json({ error: "Probe budget reached" }, { status: 429 });
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App initialTheme="light" />);
    await screen.findByText("No Worker results for this endpoint yet.");
    await user.selectOptions(screen.getByRole("combobox", { name: "Target API" }), "demo-error");
    await user.click(screen.getByRole("button", { name: "Run 3 pairs →" }));
    expect(await screen.findByRole("heading", { name: /Demo · HTTP 503 · 1\/3 pairs/ })).toBeTruthy();
    expect(screen.getByRole("alert")).toHaveProperty("textContent", expect.stringContaining("1 of 3 comparisons completed"));
    expect(directBodies.map((body) => body.directError)).toEqual(["timeout", "cors_or_network_error"]);
  });

  it("reports a non-Error failure before the first pair without showing a batch", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/probes" && !init) return Response.json([]);
      throw "browser offline";
    }));
    const user = userEvent.setup();
    render(<App initialTheme="light" />);
    await screen.findByText("No Worker results for this endpoint yet.");
    await user.click(screen.getByRole("button", { name: "Run 3 pairs →" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("Comparison failed. 0 of 3"));
    expect(screen.queryByRole("region", { name: "Last batch median comparison" })).toBeNull();
  });
});
