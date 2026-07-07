# CLAUDE.md

ippoan org の email 受信 → dispatch Worker。Cloudflare Email Routing 経由で
受信したメールを subject / from に応じて domain 固有 handler に振り分ける。

詳細 (アーキテクチャ・経緯・gotcha) は email-receiver-map skill を参照。

## ビルド / テスト

```sh
npm install
npm run typecheck
npm test
```

## 実装上の制約 (必守)

- **マッチしない subject は silent drop** (`console.log` のみ、`setReject` しない)。
  bounce は from 偽装で第三者に届くため必ず silent。
- **handler 内で fetch するときは shared secret を header で渡す**。env binding を直接
  body に乗せない。
- **起票 (rust-alc-api) と scrape (dtako-scraper) は別ステップで try/catch を分ける**。
  起票後に scrape が落ちても ticket は open のまま残し、後追い retry を可能にする。
- **subject parser は NFKC 正規化してからマッチ**。全角 `（１６）` 等の表記揺れに耐える。
- **secret を会話 / log / tool param に出さない**。`secret-inject` skill で投入する。
- **wrangler secret put は使わない** — secrets-inventory の get_drift から見えなくなる。
  CF Secrets Store binding 経由で配布する (auth-worker / nuxt-notify と同規約)。

## GitHub 自動化

- **`main` に直 push しない。** PR を作る。
- PR / commit は `Refs #N` を使う (`Closes/Fixes/Resolves` は禁止 — auto-close 防止)。
- `mcp__github__enable_pr_auto_merge` を reflex で呼ばない (user 明示指示時のみ)。
- PR 作成後は同じ turn で `mcp__github__subscribe_pr_activity` を呼び CI を watch する。
