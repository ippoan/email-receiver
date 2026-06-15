import { describe, expect, it, vi } from "vitest";
import { dispatchEmail } from "../../src/handlers";
import type { Env } from "../../src/env";

const env: Env = {
  ALC_API_BASE: "https://alc-api.example.com",
  DTAKO_TENANT_ID: "",
  SCRAPER_ENDPOINT: "https://scraper.example.com/scrape-vehicle-setting",
  DTAKO_R2_PREFIX: "dtako-tickets",
  INTERNAL_SHARED_SECRET: "s",
  SCRAPER_API_KEY: "s",
};

describe("dispatchEmail", () => {
  it("returns dtako handler for matching subject", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await dispatchEmail(
      {
        from: "noreply@example.com",
        subject: "[web金星号] SDカードエラー通知メール … (16) 十勝800か16",
        bodyText: null,
        bodyHtml: null,
        messageId: null,
        receivedAt: new Date().toISOString(),
      },
      env,
    );
    expect(r.handler).toBe("dtako");
    expect(r.result?.matched).toBe(true);
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
      env,
    );
    expect(r.handler).toBeNull();
    expect(r.result).toBeNull();
  });
});
