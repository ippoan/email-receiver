/**
 * Worker bindings + vars.
 *
 * 1 つの prod Worker が `*@ippoan.org` の catch-all を受け、`message.to` の host
 * (subdomain) で prod / staging を分岐するため、両環境の endpoint / secret /
 * tenant id を同居させる (nuxt-notify workers/email-receiver と同パターン)。
 *
 * 新しい handler を足すときは binding / vars を増やしてここに型を生やす。
 */
export interface Env {
  // ---- prod (default) ----
  /** rust-alc-api ベース URL (e.g. `https://alc-api.ippoan.org`)。 */
  ALC_API_BASE: string;
  /** 起票時に渡す `X-Tenant-ID`。v1 は env 固定 (multi-tenant 化までは 1 社想定)。 */
  DTAKO_TENANT_ID: string;
  /** dtako-scraper の `POST /scrape-vehicle-setting` 完全 URL。 */
  SCRAPER_ENDPOINT: string;
  /** R2 保管時の key prefix (将来 R2 binding 追加時に使用)。 */
  DTAKO_R2_PREFIX: string;
  /** rust-alc-api との shared secret (Secrets Store binding)。 */
  INTERNAL_SHARED_SECRET: string;
  /** dtako-scraper との shared secret (Secrets Store binding)。 */
  SCRAPER_API_KEY: string;

  // ---- staging (任意) ----
  // staging route を有効化するには 5 つすべて埋める必要がある (どれか欠ければ
  // pickRoute が null を返し silent drop)。
  ALC_API_BASE_STAGING?: string;
  DTAKO_TENANT_ID_STAGING?: string;
  SCRAPER_ENDPOINT_STAGING?: string;
  INTERNAL_SHARED_SECRET_STAGING?: string;
  SCRAPER_API_KEY_STAGING?: string;

  // ---- host 分岐の subdomain (省略時のデフォルトは router.ts) ----
  /** prod を受ける subdomain (e.g. `dtako.ippoan.org`)。 */
  PROD_HOST?: string;
  /** staging を受ける subdomain (e.g. `dtako-staging.ippoan.org`)。 */
  STAGING_HOST?: string;
}
