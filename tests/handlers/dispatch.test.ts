import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchEmail } from "../../src/handlers";
import type { RouteTarget } from "../../src/router";

const route: RouteTarget = {
  env: "prod",
  alcApiBase: "https://alc-api.example.com",
  internalSharedSecret: "s",
  tenantId: "",
  scraperEndpoint: "https://scraper.example.com/scrape-vehicle-setting",
  scraperApiKey: "s",
  r2Prefix: "dtako-tickets",
};

describe("dispatchEmail", () => {
  beforeEach(() => {
    // tenantId が空でも createTicket は実行されるので、外向き fetch を完全に止める
    // (subject match まで verify できれば十分なので fetch は 500 で十分)。
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 500 }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns dtako handler for matching subject", async () => {
    // createTicket で例外が出ても matched は true 判定された時点で先に進むので、
    // dispatch は throw する (caller index.ts で setReject) のが正常 path。
    await expect(
      dispatchEmail(
        {
          from: "noreply@example.com",
          subject: "[web金星号] SDカードエラー通知メール … (16) 十勝800か16",
          bodyText: null,
          bodyHtml: null,
          messageId: null,
          receivedAt: new Date().toISOString(),
        },
        route,
      ),
    ).rejects.toThrow(/createTicket/);
  });

  it("returns null for unmatched subject", async () => {
    const r = await dispatchEmail(
      {
        from: "noreply@example.com",
        subject: "別のメール",
        bodyText: null,
        bodyHtml: null,
        messageId: null,
        receivedAt: new Date().toISOString(),
      },
      route,
    );
    expect(r.handler).toBeNull();
    expect(r.result).toBeNull();
  });
});
