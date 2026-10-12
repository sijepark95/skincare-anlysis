import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupSmokeMail,
  localMailOrigin,
  smokeMailCode,
  smokeMailMatches,
} from "../scripts/lib/supabase-smoke-mail.mjs";

const email = "senmiva-smoke-11111111-1111-4111-8111-111111111111@example.test";
const message = {
  ID: "fixture-message-only",
  To: [{ Address: email }],
  HTML: '<p data-senmiva-verification-code style="font-size:32px">123456</p>',
};

afterEach(() => vi.unstubAllGlobals());

describe("local signup captured-mail safety", () => {
  it("derives only an explicit loopback mail port from local config", () => {
    expect(
      localMailOrigin("[local_smtp]\nenabled = true\nport = 15434\n"),
    ).toBe("http://127.0.0.1:15434");
    expect(() => localMailOrigin("[local_smtp]\nport = 99999\n")).toThrow(
      /missing or invalid/,
    );
  });
  it("matches only exact generated recipients and bounded message IDs", () => {
    expect(smokeMailMatches(message, email)).toBe(true);
    expect(smokeMailMatches(message, "owner@real-retailer.com")).toBe(false);
    expect(smokeMailMatches({ ...message, ID: "../latest" }, email)).toBe(
      false,
    );
    expect(
      smokeMailMatches(
        {
          ...message,
          To: [...message.To, { Address: "owner@real-retailer.com" }],
        },
        email,
      ),
    ).toBe(false);
  });
  it("extracts only the explicitly tagged code from this recipient's template", () => {
    expect(smokeMailCode(message, email)).toBe("123456");
    expect(() =>
      smokeMailCode({ ...message, HTML: "Unrelated code: 123456" }, email),
    ).toThrow(/configured OTP template/);
    expect(() =>
      smokeMailCode(
        { ...message, To: [{ Address: "someone@real-retailer.com" }] },
        email,
      ),
    ).toThrow(/generated recipient/);
  });
  it("never issues Mailpit's destructive empty-ID delete", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain("/api/v1/search?");
      return new Response(JSON.stringify({ messages: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await cleanupSmokeMail("http://127.0.0.1:15434", [email]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toContain("/api/v1/search?");
  });
  it("deletes only exact fixture message IDs and preserves other mail", async () => {
    const fetchMock = vi.fn(async (_url, options) =>
      options?.method === "DELETE"
        ? new Response("OK", { status: 200 })
        : new Response(
            JSON.stringify({
              messages: [
                message,
                {
                  ...message,
                  ID: "unrelated",
                  To: [{ Address: "real@retailer.com" }],
                },
              ],
            }),
            { status: 200 },
          ),
    );
    vi.stubGlobal("fetch", fetchMock);
    await cleanupSmokeMail("http://127.0.0.1:15434", [email]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      IDs: [message.ID],
    });
  });
  it("refuses remote mail origins and real recipients before any network request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      cleanupSmokeMail("https://remote.example", [email]),
    ).rejects.toThrow(/loopback origin/);
    await expect(
      cleanupSmokeMail("http://127.0.0.1:15434", ["real@retailer.com"]),
    ).rejects.toThrow(/non-fixture/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
