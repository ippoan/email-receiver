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

// auth-worker service binding の mock。createTicket / patchScraped は
// route.authWorker.fetch (= /alc-internal-proxy) を叩き、scrape のみ globalThis.fetch。
let authWorkerFetch: ReturnType<typeof vi.fn>;

function makeRoute(): RouteTarget {
  return {
    env: "prod",
    authWorker: { fetch: authWorkerFetch as unknown as typeof fetch },
    internalSharedSecret: "test-internal-secret",
    tenantId: "11111111-1111-1111-1111-111111111111",
    scraperEndpoint: "https://scraper.example.com/scrape-vehicle-setting",
    scraperApiKey: "test-scraper-key",
    r2Prefix: "dtako-tickets",
  };
}

describe("handleDtakoEmail", () => {
  beforeEach(() => {
    authWorkerFetch = vi.fn();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns matched:false for non-dtako subject", async () => {
    const result = await handleDtakoEmail(
      { ...baseEmail, subject: "spam" },
      makeRoute(),
    );
    expect(result).toEqual({ matched: false });
  });

  it("creates ticket → scrape → patch and returns scraped:true on full success", async () => {
    // ticket 起票 / patch は auth-worker service binding (/alc-internal-proxy) 経由
    authWorkerFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.endsWith("/alc-internal-proxy/api/dtako/tickets")) {
        return new Response(JSON.stringify({ id: "ticket-1" }), { status: 200 });
      }
      if (url.endsWith("/alc-internal-proxy/api/dtako/tickets/ticket-1/scraped")) {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected authWorker fetch: ${url}`);
    });
    // scrape のみ globalThis.fetch (dtako-scraper VPS 直)
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url === "https://scraper.example.com/scrape-vehicle-setting") {
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
      throw new Error(`unexpected fetch: ${url}`);
    });

    const route = makeRoute();
    const result = await handleDtakoEmail(baseEmail, route);
    expect(result).toMatchObject({
      matched: true,
      ticketId: "ticket-1",
      scraped: true,
      vehicleName: "(16) 十勝800か16",
      errorKind: "sd_card_error",
    });
    expect(authWorkerFetch).toHaveBeenCalledTimes(2); // create + patch
    expect(fetchSpy).toHaveBeenCalledTimes(1); // scrape

    // create は /alc-internal-proxy へ X-Alc-Proxy-Secret + X-Tenant-ID (X-Internal-Shared-Secret は付けない)
    const [createUrl, createInit] = authWorkerFetch.mock.calls[0] as [string, RequestInit];
    expect(createUrl).toContain("/alc-internal-proxy/api/dtako/tickets");
    expect(createInit.method).toBe("POST");
    const createHeaders = createInit.headers as Record<string, string>;
    expect(createHeaders["X-Alc-Proxy-Secret"]).toBe("test-internal-secret");
    expect(createHeaders["X-Tenant-ID"]).toBe(route.tenantId);
    expect(createHeaders["X-Internal-Shared-Secret"]).toBeUndefined();

    const scrapeInit = fetchSpy.mock.calls[0][1] as RequestInit;
    expect((scrapeInit.headers as Record<string, string>)["X-Scraper-API-Key"]).toBe(
      "test-scraper-key",
    );

    const [patchUrl, patchInit] = authWorkerFetch.mock.calls[1] as [string, RequestInit];
    expect(patchUrl).toContain("/alc-internal-proxy/api/dtako/tickets/ticket-1/scraped");
    expect(patchInit.method).toBe("PATCH");
  });

  it("throws when createTicket fails (so caller can setReject)", async () => {
    authWorkerFetch.mockResolvedValue(new Response("nope", { status: 500 }));
    await expect(handleDtakoEmail(baseEmail, makeRoute())).rejects.toThrow(/createTicket 500/);
  });

  it("returns scraped:false when scrape step fails (ticket is left open)", async () => {
    authWorkerFetch.mockResolvedValue(
      new Response(JSON.stringify({ id: "ticket-2" }), { status: 200 }),
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("upstream timeout", { status: 504 }),
    );

    const result = await handleDtakoEmail(baseEmail, makeRoute());
    expect(result).toMatchObject({
      matched: true,
      ticketId: "ticket-2",
      scraped: false,
    });
  });

  it("throws when createTicket response lacks id", async () => {
    authWorkerFetch.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    await expect(handleDtakoEmail(baseEmail, makeRoute())).rejects.toThrow(/missing id/);
  });
});
