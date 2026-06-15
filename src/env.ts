/**
 * Worker bindings + vars.
 *
 * 受信メールを domain 固有 handler に dispatch するための env 表。
 * 新しい handler を足すときは binding / vars を増やしてここに型を生やす。
 */
export interface Env {
  /** rust-alc-api ベース URL (e.g. `https://alc-api.ippoan.org`)。dtako handler 用。 */
  ALC_API_BASE: string;
  /** rust-alc-api に POST する時の tenant id (v1 は env 固定)。空文字なら dispatch しない。 */
  DTAKO_TENANT_ID: string;
  /** dtako-scraper の `POST /scrape-vehicle-setting` 完全 URL。 */
  SCRAPER_ENDPOINT: string;
  /** R2 保管時の key prefix (将来 R2 binding 追加時に使用)。 */
  DTAKO_R2_PREFIX: string;

  /** rust-alc-api との shared secret (Secrets Store binding)。 */
  INTERNAL_SHARED_SECRET: string;
  /** dtako-scraper との shared secret (Secrets Store binding)。 */
  SCRAPER_API_KEY: string;
}
