import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleDtakoEmail, type ParsedEmail } from "../../src/handlers/dtako";
import type { RouteTarget } from "../../src/router";

const baseEmail: ParsedEmail = {
  from: "noreply@theearth-np.com",
  subject: "[web金星号] SDカードエラー通知メール … (16) 十勝800か16",
  bodyText: "本文",
  bodyHtml: null,
  messageId: "<abc@theearth-np.com>",
  receivedAt: "2026-06-15T08:00:00.000Z",
};

const baseRoute: RouteTarget = {
  env: "prod",
  alcApiBase: "https://alc-api.example.com",
  internalSharedSecret: "test-internal-secret",
  tenantId: "11111111-1111-1111-1111-111111111111",
  scraperEndpoint: "https://scraper.example.com/scrape-vehicle-setting",
  scraperApiKey: "test-scraper-key",
  r2Prefix: "dtako-tickets",
};

describe("handleDtakoEmail", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns matched:false for non-dtako subject", async () => {
    const result = await handleDtakoEmail(
      { ...baseEmail, subject: "spam" },
      baseRoute,
    );
    expect(result).toEqual({ matched: false });
  });

  it("creates ticket → scrape → patch and returns scraped:true on full success", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.endsWith("/api/dtako/tickets")) {
        return new Response(JSON.stringify({ id: "ticket-1" }), { status: 200 });
      }
      if (url === baseRoute.scraperEndpoint) {
        return new Response(
          JSON.stringify({
            comp_id: "27324455",
            unko_no: "U001",
            operation_started_at: "2026-06-15T01:00:00Z",
            operation_ended_at: "2026-06-15T05:00:00Z",
            zip_path: "dtako-tickets/U001.zip",
            zip_size_bytes: 1024,
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/api/dtako/tickets/ticket-1/scraped")) {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await handleDtakoEmail(baseEmail, baseRoute);
    expect(result).toMatchObject({
      matched: true,
      ticketId: "ticket-1",
      scraped: true,
      vehicleName: "(16) 十勝800か16",
      errorKind: "sd_card_error",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    const createCall = fetchSpy.mock.calls[0];
    const createInit = createCall[1] as RequestInit;
    expect(createInit.method).toBe("POST");
    expect((createInit.headers as Record<string, string>)["X-Internal-Shared-Secret"]).toBe(
      "test-internal-secret",
    );
    expect((createInit.headers as Record<string, string>)["X-Tenant-ID"]).toBe(
      baseRoute.tenantId,
    );

    const scrapeCall = fetchSpy.mock.calls[1];
    const scrapeInit = scrapeCall[1] as RequestInit;
    expect((scrapeInit.headers as Record<string, string>)["X-Scraper-API-Key"]).toBe(
      "test-scraper-key",
    );
  });

  it("throws when createTicket fails (so caller can setReject)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("nope", { status: 500 }),
    );
    await expect(handleDtakoEmail(baseEmail, baseRoute)).rejects.toThrow(/createTicket 500/);
  });

  it("returns scraped:false when scrape step fails (ticket is left open)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.endsWith("/api/dtako/tickets")) {
        return new Response(JSON.stringify({ id: "ticket-2" }), { status: 200 });
      }
      return new Response("upstream timeout", { status: 504 });
    });

    const result = await handleDtakoEmail(baseEmail, baseRoute);
    expect(result).toMatchObject({
      matched: true,
      ticketId: "ticket-2",
      scraped: false,
    });
  });

  it("throws when createTicket response lacks id", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    );
    await expect(handleDtakoEmail(baseEmail, baseRoute)).rejects.toThrow(/missing id/);
  });
});
