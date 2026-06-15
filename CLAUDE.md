# CLAUDE.md

ippoan org の email 受信 → dispatch Worker。Cloudflare Email Routing 経由で
受信したメールを subject / from に応じて domain 固有 handler に振り分ける。

このリポジトリで Claude Code セッションを動かす時の作業ガイド。共通項は
[ippoan/claude-md](https://github.com/ippoan/claude-md) の `CLAUDE.md.template` に従う。

## まず読むもの

- [`README.md`](./README.md) — アーキテクチャ / handler 一覧 / env / secret
- [親 epic ippoan/email-receiver#1](https://github.com/ippoan/email-receiver/issues/1) — dtako pipeline の全体像と PR 分割
- `src/handlers/dtako.ts` — 既存 handler の参考実装
- `src/parsers/dtako-subject.ts` — subject parser の規約 (NFKC 正規化 + 正規表現)
- 参考: `ippoan/nuxt-notify` の `workers/email-receiver/` (PostalMime + setReject パターン)

## 設計上の要点 (触る前に)

- **dispatcher は 1 ファイル (`src/handlers/index.ts`)、handler は per-domain ファイル**。新規
  email 種別を増やす時は `src/handlers/<name>.ts` を追加し、index.ts に 1 行 dispatch
  追加するだけで済むように保つ。
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

## ビルド / テスト

PR を出す前に手元で green に:

```sh
npm install
npm run typecheck
npm test
```

CI (`.github/workflows/test.yml`) は `main` への PR ごとに ci-workflows の
`lib-ci.yml` で typecheck + test を回す (mcp-cf-workers と同規約)。

## 配布 (GitHub Packages)

`@ippoan/email-receiver` として GH Packages に publish する。pattern は
[`ippoan/mcp-cf-workers`](https://github.com/ippoan/mcp-cf-workers) の dev-release /
publish を踏襲:

- `.github/workflows/dev-release.yml` — `main` push で `dev-{patch}` tag 採番 +
  `dev` dist-tag publish。consumer は `"@ippoan/email-receiver": "dev"` で取得。
- `.github/workflows/publish.yml` — `v*` tag push で `latest` dist-tag publish。

`package.json` の `exports` map を編集する時は `README.md` の export 表も合わせて
更新する。Worker 本体 (`./` = `src/index.ts`) はそのまま deploy 用、それ以外の
subpath (`./handlers/dtako` 等) は consumer 用に切り出してある。

Worker 自体の Cloudflare account への deploy は後続 PR で wire する。

## GitHub 自動化 (重要)

- **`main` に直 push しない。** PR を作る。
- PR / commit は `Refs #N` を使う (`Closes/Fixes/Resolves` は禁止 — auto-close 防止)。
- `mcp__github__enable_pr_auto_merge` を reflex で呼ばない (user 明示指示時のみ)。
- PR 作成後は同じ turn で `mcp__github__subscribe_pr_activity` を呼び CI を watch する。

---

_共通項を直すときは [`ippoan/claude-md`](https://github.com/ippoan/claude-md) の
`CLAUDE.md.template` を更新すること。_
