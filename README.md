# email-receiver

ippoan org の Cloudflare Email Routing 経由で受信したメールを、subject / from に応じて
domain 固有 handler に dispatch する Worker。

現状の handler:

| handler | 受信対象 | 処理 |
|---|---|---|
| `dtako` | `[web金星号] SDカードエラー通知メール … (XX) 車両名` | rust-alc-api で起票 → dtako-scraper で F-VOS3020 設定 ZIP DL → PATCH で結果反映 |

新しい email 種別を増やす場合は `src/handlers/<name>.ts` を追加し、
`src/handlers/index.ts` の dispatcher に 1 行追加するだけで良い設計。

## アーキテクチャ

```
[Cloudflare Email Routing]
  ↓ catch-all route
[email-receiver Worker]
  ├ PostalMime で MIME parse
  └ dispatchEmail()
      └ handleDtakoEmail()
          ├ subject parser で vehicle_name 抽出
          ├ POST  ${ALC_API_BASE}/api/dtako/tickets        (X-Internal-Shared-Secret)
          ├ POST  ${SCRAPER_ENDPOINT}                       (X-Scraper-API-Key)
          └ PATCH ${ALC_API_BASE}/api/dtako/tickets/{id}/scraped
```

依存先 API は別 PR で進行中:

- 起票 / 取得 / close: `ippoan/rust-alc-api#414` (alc-dtako crate)
- 設定 ZIP DL: `ohishi-exp/dtako-scraper#5`
- UI / 印刷 / QR: `ohishi-exp/nuxt_dtako_logs#15`

親 epic: `ippoan/email-receiver#1`

## 開発

```sh
npm install
npm run typecheck
npm test
```

### ローカルで Worker を起動

```sh
npx wrangler dev
```

Email event はローカル不可なので、handler を直接叩く統合テストは vitest で完結させる。

## デプロイ

CI が PR merge / tag push で wrangler deploy するように後続 PR で wire する予定。
現時点では `has_deploy: false` で typecheck + test のみ。手動 deploy を試す場合:

```sh
npx wrangler deploy            # production
npx wrangler deploy --env staging
```

## Secrets

- `INTERNAL_SHARED_SECRET` — rust-alc-api との shared secret。CF Secrets Store + GCP Secret
  Manager (`secrets-inventory` MCP) 経由で配布。auth-worker 等と同 binding 名で揃える。
- `SCRAPER_API_KEY` — dtako-scraper との shared secret。同様に Secrets Store 経由。

`wrangler secret put` は使わない (secrets-inventory get_drift から見えないため)。

## Vars (`wrangler.toml [vars]`)

| key | 用途 |
|---|---|
| `ALC_API_BASE` | rust-alc-api のベース URL |
| `DTAKO_TENANT_ID` | 起票時に渡す `X-Tenant-ID` (v1 は env 固定) |
| `SCRAPER_ENDPOINT` | dtako-scraper `POST /scrape-vehicle-setting` の完全 URL |
| `DTAKO_R2_PREFIX` | R2 保管時の key prefix (将来 R2 binding 追加時) |

## subject parser (v1)

`src/parsers/dtako-subject.ts` 参照。

- `SD カードエラー` (全角/半角・スペース揺れ NFKC 正規化後にマッチ)
- `(<digits>) <非空白>` を vehicle_name として抽出
- マッチしない subject は silent drop (`console.log` のみ)
