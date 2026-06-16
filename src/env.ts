/**
 * Cloudflare Secrets Store binding の runtime 型。
 *
 * `wrangler.toml` の `[[secrets_store_secrets]]` で宣言した binding は **string ではなく**
 * `.get(): Promise<string>` を持つ object として attach される。string として直接 access
 * すると `String(obj)` の toString 表現 (= secret 値とは無関係) が流れ込むため、必ず
 * `resolveSecretBinding()` 経由で `.get()` を呼んで値を取り出す。
 *
 * 2026-06-16: この扱い漏れが root cause で `INTERNAL_SHARED_SECRET` を rotate しても
 * Worker fingerprint が `ad24cc83` のまま固定し epic e2e が 401 を踏み続けた
 * (Refs ippoan/email-receiver#1)。同じ罠を踏まないため型を分離して resolve を強制する。
 */
export type SecretsStoreSecret = { get(): Promise<string> };
export type SecretBinding = SecretsStoreSecret | string | undefined;

/**
 * Worker bindings + vars.
 *
 * 1 つの prod Worker が `*@ippoan.org` の catch-all を受け、`message.to` の host
 * (subdomain) で prod / staging を分岐するため、両環境の endpoint / tenant id を
 * 同居させる (nuxt-notify workers/email-receiver と同パターン)。
 *
 * shared secret (`INTERNAL_SHARED_SECRET` / `SCRAPER_API_KEY`) は prod / staging で
 * **同一値を共有**する (= binding は 1 つだけ)。auth-worker など既存 4 consumer も同方式
 * (Refs auth-worker CLAUDE.md "2026-05-24: prod/staging 統合")。
 *
 * 新しい handler を足すときは binding / vars を増やしてここに型を生やす。
 */
export interface Env {
  // ---- shared (prod / staging 共通) ----
  /** rust-alc-api との shared secret (Secrets Store binding)。`.get()` 経由でのみ実値を取れる。 */
  INTERNAL_SHARED_SECRET: SecretBinding;
  /** dtako-scraper との shared secret (Secrets Store binding)。`.get()` 経由でのみ実値を取れる。 */
  SCRAPER_API_KEY: SecretBinding;
  /** R2 保管時の key prefix (将来 R2 binding 追加時に使用)。 */
  DTAKO_R2_PREFIX: string;

  // ---- prod (default) ----
  /** rust-alc-api ベース URL (e.g. `https://alc-api.ippoan.org`)。 */
  ALC_API_BASE: string;
  /** 起票時に渡す `X-Tenant-ID`。v1 は env 固定 (multi-tenant 化までは 1 社想定)。 */
  DTAKO_TENANT_ID: string;
  /** dtako-scraper の `POST /scrape-vehicle-setting` 完全 URL。 */
  SCRAPER_ENDPOINT: string;

  // ---- staging (任意) ----
  // staging route を有効化するには 3 つすべて埋める必要がある (どれか欠ければ
  // pickRoute が null を返し silent drop)。
  ALC_API_BASE_STAGING?: string;
  DTAKO_TENANT_ID_STAGING?: string;
  SCRAPER_ENDPOINT_STAGING?: string;

  // ---- host 分岐の subdomain (省略時のデフォルトは router.ts) ----
  /** prod を受ける subdomain (e.g. `dtako.ippoan.org`)。 */
  PROD_HOST?: string;
  /** staging を受ける subdomain (e.g. `dtako-staging.ippoan.org`)。 */
  STAGING_HOST?: string;
}

/**
 * Secrets Store binding か legacy plain string かを問わず実値を取り出す。
 *
 * - `string` → そのまま返す (wrangler dev / mock env / 将来の plain secret 用)
 * - `SecretsStoreSecret` (`.get()` を持つ object) → `await binding.get()` で resolve
 * - その他 (undefined / null / 取得失敗) → `null`
 *
 * auth-worker `src/handlers/mcp-introspect.ts::resolveSecretBinding` と同実装。
 */
export async function resolveSecretBinding(
  binding: SecretBinding,
): Promise<string | null> {
  if (!binding) return null;
  if (typeof binding === "string") return binding;
  if (
    typeof binding === "object" && binding !== null &&
    typeof (binding as { get?: unknown }).get === "function"
  ) {
    try {
      return await (binding as SecretsStoreSecret).get();
    } catch {
      return null;
    }
  }
  return null;
}
