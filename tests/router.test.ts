import { describe, expect, it } from "vitest";
import { pickRoute } from "../src/router";
import { resolveSecretBinding, type Env, type SecretsStoreSecret } from "../src/env";

const fullEnv: Env = {
  // shared
  INTERNAL_SHARED_SECRET: "shared-internal",
  SCRAPER_API_KEY: "shared-scraper",
  DTAKO_R2_PREFIX: "dtako-tickets",
  // prod
  ALC_API_BASE: "https://alc-api.example.com",
  DTAKO_TENANT_ID: "11111111-1111-1111-1111-111111111111",
  SCRAPER_ENDPOINT: "https://scraper.example.com/scrape-vehicle-setting",
  // staging
  ALC_API_BASE_STAGING: "https://alc-api-staging.example.com",
  DTAKO_TENANT_ID_STAGING: "22222222-2222-2222-2222-222222222222",
  SCRAPER_ENDPOINT_STAGING: "https://scraper-staging.example.com/scrape-vehicle-setting",
  // hosts
  PROD_HOST: "dtako.ippoan.org",
  STAGING_HOST: "dtako-staging.ippoan.org",
};

const storeBinding = (value: string): SecretsStoreSecret => ({
  get: () => Promise.resolve(value),
});

describe("pickRoute", () => {
  it("returns prod target for prod host", async () => {
    const r = await pickRoute("dtako.ippoan.org", fullEnv);
    expect(r).toEqual({
      env: "prod",
      alcApiBase: "https://alc-api.example.com",
      internalSharedSecret: "shared-internal",
      tenantId: "11111111-1111-1111-1111-111111111111",
      scraperEndpoint: "https://scraper.example.com/scrape-vehicle-setting",
      scraperApiKey: "shared-scraper",
      r2Prefix: "dtako-tickets",
    });
  });

  it("returns staging target reusing shared secrets but staging endpoint / tenant", async () => {
    const r = await pickRoute("dtako-staging.ippoan.org", fullEnv);
    expect(r?.env).toBe("staging");
    expect(r?.alcApiBase).toBe("https://alc-api-staging.example.com");
    expect(r?.tenantId).toBe("22222222-2222-2222-2222-222222222222");
    expect(r?.scraperEndpoint).toBe("https://scraper-staging.example.com/scrape-vehicle-setting");
    // secret は prod / staging で同一値 (Refs auth-worker CLAUDE.md "2026-05-24: 統合")
    expect(r?.internalSharedSecret).toBe("shared-internal");
    expect(r?.scraperApiKey).toBe("shared-scraper");
  });

  it("is case-insensitive on host", async () => {
    expect((await pickRoute("DTAKO.IPPOAN.ORG", fullEnv))?.env).toBe("prod");
    expect((await pickRoute("Dtako-Staging.Ippoan.Org", fullEnv))?.env).toBe("staging");
  });

  it("returns null for unknown host (silent drop)", async () => {
    expect(await pickRoute("evil.example.com", fullEnv)).toBeNull();
    expect(await pickRoute("ippoan.org", fullEnv)).toBeNull();
  });

  it("returns null when prod env is missing required values", async () => {
    const broken: Env = { ...fullEnv, DTAKO_TENANT_ID: "" };
    expect(await pickRoute("dtako.ippoan.org", broken)).toBeNull();
  });

  it("returns null when staging env is missing required values", async () => {
    const noStaging: Env = {
      INTERNAL_SHARED_SECRET: fullEnv.INTERNAL_SHARED_SECRET,
      SCRAPER_API_KEY: fullEnv.SCRAPER_API_KEY,
      DTAKO_R2_PREFIX: fullEnv.DTAKO_R2_PREFIX,
      ALC_API_BASE: fullEnv.ALC_API_BASE,
      DTAKO_TENANT_ID: fullEnv.DTAKO_TENANT_ID,
      SCRAPER_ENDPOINT: fullEnv.SCRAPER_ENDPOINT,
      PROD_HOST: fullEnv.PROD_HOST,
      STAGING_HOST: fullEnv.STAGING_HOST,
    };
    expect(await pickRoute("dtako-staging.ippoan.org", noStaging)).toBeNull();
  });

  it("falls back to default hosts when PROD_HOST / STAGING_HOST omitted", async () => {
    const noHosts: Env = { ...fullEnv };
    delete noHosts.PROD_HOST;
    delete noHosts.STAGING_HOST;
    expect((await pickRoute("dtako.ippoan.org", noHosts))?.env).toBe("prod");
    expect((await pickRoute("dtako-staging.ippoan.org", noHosts))?.env).toBe("staging");
  });

  it("uses DTAKO_R2_PREFIX for both prod and staging routes", async () => {
    expect((await pickRoute("dtako.ippoan.org", fullEnv))?.r2Prefix).toBe("dtako-tickets");
    expect((await pickRoute("dtako-staging.ippoan.org", fullEnv))?.r2Prefix).toBe("dtako-tickets");
  });

  it("defaults r2Prefix to empty string when DTAKO_R2_PREFIX absent", async () => {
    const noR2: Env = { ...fullEnv, DTAKO_R2_PREFIX: undefined as unknown as string };
    expect((await pickRoute("dtako.ippoan.org", noR2))?.r2Prefix).toBe("");
  });

  it("resolves Secrets Store binding via .get() (regression of epic 401 root cause)", async () => {
    const storeEnv: Env = {
      ...fullEnv,
      INTERNAL_SHARED_SECRET: storeBinding("resolved-internal-from-store"),
      SCRAPER_API_KEY: storeBinding("resolved-scraper-from-store"),
    };
    const r = await pickRoute("dtako.ippoan.org", storeEnv);
    expect(r?.internalSharedSecret).toBe("resolved-internal-from-store");
    expect(r?.scraperApiKey).toBe("resolved-scraper-from-store");
  });

  it("returns null when Secrets Store binding throws on .get()", async () => {
    const broken: Env = {
      ...fullEnv,
      INTERNAL_SHARED_SECRET: { get: () => Promise.reject(new Error("nope")) },
    };
    expect(await pickRoute("dtako.ippoan.org", broken)).toBeNull();
  });
});

describe("resolveSecretBinding", () => {
  it("returns the string as-is", async () => {
    expect(await resolveSecretBinding("plain")).toBe("plain");
  });

  it("returns null for empty / undefined binding", async () => {
    expect(await resolveSecretBinding(undefined)).toBeNull();
    expect(await resolveSecretBinding("")).toBeNull();
  });

  it("calls .get() on Secrets Store binding", async () => {
    expect(await resolveSecretBinding(storeBinding("xyz"))).toBe("xyz");
  });

  it("returns null when .get() throws", async () => {
    const bad: SecretsStoreSecret = { get: () => Promise.reject(new Error("boom")) };
    expect(await resolveSecretBinding(bad)).toBeNull();
  });

  it("returns null for object without .get()", async () => {
    // wrangler dev / mock 等で誤って object を渡された場合の防御
    expect(await resolveSecretBinding({ wrong: "shape" } as unknown as SecretsStoreSecret))
      .toBeNull();
  });
});
