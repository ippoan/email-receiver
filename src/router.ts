import { type Env, type ServiceBinding, resolveSecretBinding } from "./env";

/**
 * host (subdomain) を見て env を解決した「1 配送先分の設定束」。
 *
 * 現在は 1 社運用なので `tenantId` も env 固定だが、将来 multi-tenant 化する時は
 * `pickRoute()` 内で local-part / DB lookup を足して `tenantId` を解決する形に拡張する
 * (handler 側のシグネチャは変わらない)。
 *
 * shared secret (`INTERNAL_SHARED_SECRET` / `SCRAPER_API_KEY`) は prod / staging で
 * 同一値を共有する (auth-worker など既存 4 consumer も同方式、Refs auth-worker
 * CLAUDE.md "2026-05-24: prod/staging 統合 (旧 mcp-internal-shared-secret-{prod,staging})")。
 * 実環境の切り分けは endpoint と tenant_id だけで完結する。
 */
export interface RouteTarget {
  env: "prod" | "staging";
  /** auth-worker への service binding。`/alc-internal-proxy` 経由で rust-alc-api を叩く。 */
  authWorker: ServiceBinding;
  internalSharedSecret: string;
  tenantId: string;
  scraperEndpoint: string;
  scraperApiKey: string;
  r2Prefix: string;
}

const DEFAULT_PROD_HOST = "dtako.ippoan.org";
const DEFAULT_STAGING_HOST = "dtako-staging.ippoan.org";

function asTarget(
  envName: "prod" | "staging",
  authWorker: ServiceBinding | undefined,
  internalSharedSecret: string | undefined,
  tenantId: string | undefined,
  scraperEndpoint: string | undefined,
  scraperApiKey: string | undefined,
  r2Prefix: string | undefined,
): RouteTarget | null {
  if (
    !authWorker || !internalSharedSecret || !tenantId ||
    !scraperEndpoint || !scraperApiKey
  ) {
    return null;
  }
  return {
    env: envName,
    authWorker,
    internalSharedSecret,
    tenantId,
    scraperEndpoint,
    scraperApiKey,
    r2Prefix: r2Prefix ?? "",
  };
}

/**
 * `message.to` の host 部から prod / staging を分岐する。
 *
 * - prod host にマッチ → prod の env を使う
 * - staging host にマッチ → 同じ secret を使い、endpoint / tenant_id だけ staging 用に差し替える
 *   (どれか欠ければ null)
 * - それ以外 → null (silent drop)
 *
 * catch-all を 1 つの prod Worker で受けて中で分岐するため、staging Worker
 * (`email-receiver-staging`) は実受信しない設計 (nuxt-notify と同じ)。
 *
 * Secrets Store binding は `.get()` 経由で resolve しないと実値が取れない (string として
 * 直接 access すると object の toString 表現が流れる)。`resolveSecretBinding()` で
 * 必ず実値に変換する。これが漏れていたのが epic e2e 401 の root cause
 * (Refs ippoan/email-receiver#1)。
 */
export async function pickRoute(host: string, env: Env): Promise<RouteTarget | null> {
  const prodHost = (env.PROD_HOST ?? DEFAULT_PROD_HOST).toLowerCase();
  const stagingHost = (env.STAGING_HOST ?? DEFAULT_STAGING_HOST).toLowerCase();
  const h = host.toLowerCase();

  const internalSharedSecret = await resolveSecretBinding(env.INTERNAL_SHARED_SECRET);
  const scraperApiKey = await resolveSecretBinding(env.SCRAPER_API_KEY);

  if (h === prodHost) {
    return asTarget(
      "prod",
      env.AUTH_WORKER,
      internalSharedSecret ?? undefined,
      env.DTAKO_TENANT_ID,
      env.SCRAPER_ENDPOINT,
      scraperApiKey ?? undefined,
      env.DTAKO_R2_PREFIX,
    );
  }
  if (h === stagingHost) {
    return asTarget(
      "staging",
      env.AUTH_WORKER_STAGING,
      internalSharedSecret ?? undefined,
      env.DTAKO_TENANT_ID_STAGING,
      env.SCRAPER_ENDPOINT_STAGING,
      scraperApiKey ?? undefined,
      env.DTAKO_R2_PREFIX,
    );
  }
  return null;
}
