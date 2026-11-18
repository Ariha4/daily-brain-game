import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { isCorrectSecret, prepareUpcomingChallenges } from "../src/index.js";

const env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-key",
  ADMIN_SECRET: "correct horse battery staple",
};

function runRequest(headers = {}, path = "/run") {
  return worker.fetch(new Request(`https://worker.test${path}`, { headers }), env);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isCorrectSecret", () => {
  it("accepts only an exact match", () => {
    expect(isCorrectSecret("abc", "abc")).toBe(true);
    expect(isCorrectSecret("abd", "abc")).toBe(false);
    expect(isCorrectSecret("ab", "abc")).toBe(false);
    expect(isCorrectSecret("abcd", "abc")).toBe(false);
  });

  it("is disabled when no secret is configured", () => {
    expect(isCorrectSecret("", "")).toBe(false);
    expect(isCorrectSecret("anything", undefined)).toBe(false);
    expect(isCorrectSecret(null, undefined)).toBe(false);
  });
});

describe("fetch handler", () => {
  it("returns 404 without the secret, for the wrong secret, and on other paths", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    expect((await runRequest()).status).toBe(404);
    expect((await runRequest({ "x-admin-secret": "wrong" })).status).toBe(404);
    expect((await runRequest({ "x-admin-secret": env.ADMIN_SECRET }, "/other")).status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("inserts 7 rows with ignore-duplicates when the secret matches", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchSpy);

    const response = await runRequest({ "x-admin-secret": env.ADMIN_SECRET });
    expect(response.status).toBe(200);
    const summary = await response.json();
    expect(summary.ok).toBe(true);
    expect(summary.datesChecked).toHaveLength(7);

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://example.supabase.co/rest/v1/daily_challenges");
    expect(init.headers.Prefer).toContain("resolution=ignore-duplicates");
    expect(JSON.parse(init.body)).toHaveLength(7);
  });
});

describe("prepareUpcomingChallenges", () => {
  it("fails fast with a clear message when secrets are missing", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(prepareUpcomingChallenges({ SUPABASE_URL: "x" })).rejects.toThrow(
      "Missing Worker secrets: SUPABASE_SERVICE_ROLE_KEY",
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("surfaces the Supabase error body when the insert fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("bad jwt", { status: 401 })));
    await expect(prepareUpcomingChallenges(env)).rejects.toThrow(
      "Supabase insert failed (401): bad jwt",
    );
  });
});
