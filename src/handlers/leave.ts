import PostalMime, { type Attachment, type Header } from "postal-mime";
import type { LeaveRoute } from "../router";
import { uint8ArrayToBase64 } from "../lib/base64";

/**
 * 勤怠申請 (休暇申請書 PDF) 受信 handler。
 *
 * 宛先 `<mailbox>@leave.ippoan.org` の PDF 添付を rust-leave-worker の
 * `POST /internal/ingest` に 1 枚ずつ渡す。tenant 解決・送信元の許可リスト照合・
 * R2 保存は受け側の責務で、ここは **PDF を運ぶだけ**。
 *
 * 方針 (dtako handler と同じ): 受け付けない / 失敗したメールは silent drop。
 * bounce は From 偽装で第三者に届くため reject は絶対にしない
 * (そもそも message 全体ではなく必要な field しか受け取らない)。
 */

const MAILBOX_RE = /^[a-z0-9-]{3,64}$/;
const MAX_PDFS_PER_MAIL = 10;
const INGEST_URL = "https://rust-leave-worker/internal/ingest";

/** index.ts から渡される `ForwardableEmailMessage` の必要部分。 */
export type LeaveMessage = Pick<ForwardableEmailMessage, "to" | "from" | "raw">;

export interface LeaveHandleResult {
  /** 受け側へ送った PDF の数 (200 / 202 のみ数える)。 */
  sent: number;
  /** drop したときの理由 (log と同じ文言)。 */
  dropped?: string;
}

/**
 * 送信元認証の判定。**Cloudflare 自身が付けた結果だけ**を信じる。
 *
 * - `Authentication-Results` / `ARC-Authentication-Results` のうち、authserv-id が
 *   `mx.cloudflare.net` (または配下) のものだけを見る。送信元が付けた同名ヘッダは
 *   authserv-id が違う限り無視する。
 * - 受信 MTA は trace ヘッダを先頭に積むため、同名ヘッダが複数あるときは先頭の 1 つだけを
 *   見る (送信元が後ろに偽装行を足しても効かない)。
 * - 合格: `dmarc=pass`、または (`spf=pass` かつ `dkim=pass`)。
 * - fail-closed: Cloudflare 由来のヘッダが無ければ不合格 (`reason` が "no-cloudflare-result")。
 *
 * 未実測の前提: Cloudflare Email Routing が authserv-id `mx.cloudflare.net` で付ける。
 */
export type AuthVerdict =
  | { ok: true }
  | { ok: false; reason: "no-cloudflare-result" | "not-passed" };

const CLOUDFLARE_AUTHSERV = "mx.cloudflare.net";

function isCloudflareAuthserv(id: string): boolean {
  const v = id.toLowerCase();
  return v === CLOUDFLARE_AUTHSERV || v.endsWith(`.${CLOUDFLARE_AUTHSERV}`);
}

/** ヘッダ値の authserv-id と、それ以降の result 部を取り出す。ARC の `i=N;` は読み飛ばす。 */
function splitAuthResult(value: string): { authservId: string; results: string } {
  const parts = value.split(";");
  if (parts.length > 0 && /^\s*i\s*=\s*\d+\s*$/i.test(parts[0])) parts.shift();
  const head = (parts.shift() ?? "").trim();
  // `mx.cloudflare.net 1` のように version が続くことがあるので先頭 token だけ。
  const authservId = head.split(/\s+/)[0] ?? "";
  return { authservId, results: parts.join(";") };
}

function hasResult(results: string, method: string): boolean {
  return new RegExp(`(?:^|[\\s;])${method}\\s*=\\s*pass(?=[\\s;(]|$)`, "i").test(results);
}

export function verifySenderAuth(headers: Header[]): AuthVerdict {
  let found = false;
  for (const name of ["authentication-results", "arc-authentication-results"]) {
    const top = headers.find((h) => h.key.toLowerCase() === name);
    if (!top) continue;
    const { authservId, results } = splitAuthResult(top.value);
    if (!isCloudflareAuthserv(authservId)) continue;
    found = true;
    if (hasResult(results, "dmarc") || (hasResult(results, "spf") && hasResult(results, "dkim"))) {
      return { ok: true };
    }
  }
  return { ok: false, reason: found ? "not-passed" : "no-cloudflare-result" };
}

function isPdf(a: Attachment): boolean {
  if (a.mimeType?.toLowerCase().split(";")[0].trim() === "application/pdf") return true;
  return a.filename?.toLowerCase().endsWith(".pdf") ?? false;
}

function toBase64(a: Attachment): string {
  const c = a.content;
  if (typeof c === "string") {
    return a.encoding === "base64" ? c : uint8ArrayToBase64(new TextEncoder().encode(c));
  }
  return uint8ArrayToBase64(c instanceof Uint8Array ? c : new Uint8Array(c));
}

function drop(reason: string, mailbox: string): LeaveHandleResult {
  console.log(`email-receiver: leave dropped (mailbox=${mailbox} reason=${reason})`);
  return { sent: 0, dropped: reason };
}

export async function handleLeaveEmail(
  message: LeaveMessage,
  route: LeaveRoute,
  receivedAt: string = new Date().toISOString(),
): Promise<LeaveHandleResult> {
  const mailbox = (message.to.split("@")[0] ?? "").toLowerCase();
  if (!MAILBOX_RE.test(mailbox)) return drop("invalid local-part", "<invalid>");

  let parsed: Awaited<ReturnType<typeof PostalMime.parse>>;
  try {
    parsed = await PostalMime.parse(message.raw);
  } catch (e) {
    // reject はしない (bounce が From 偽装で第三者に飛ぶ)。実エラーだけ残す。
    console.error(`email-receiver: leave MIME parse failed (mailbox=${mailbox}) ${(e as Error).message}`);
    return { sent: 0, dropped: "mime parse failed" };
  }

  const verdict = verifySenderAuth(parsed.headers ?? []);
  if (!verdict.ok) {
    return drop(
      verdict.reason === "no-cloudflare-result"
        ? "leave: no cloudflare auth result"
        : "leave: sender auth not passed",
      mailbox,
    );
  }

  const headerFrom = parsed.from?.address;
  if (!headerFrom) return drop("no From address", mailbox);

  const pdfs = (parsed.attachments ?? []).filter(isPdf);
  if (pdfs.length === 0) return drop("no pdf attachment", mailbox);
  if (pdfs.length > MAX_PDFS_PER_MAIL) {
    console.log(
      `email-receiver: leave pdf over limit, extra dropped (mailbox=${mailbox} ` +
        `count=${pdfs.length} limit=${MAX_PDFS_PER_MAIL})`,
    );
  }

  let sent = 0;
  for (const pdf of pdfs.slice(0, MAX_PDFS_PER_MAIL)) {
    try {
      // secret は header のみ。body には載せない。
      const res = await route.leaveWorker.fetch(
        new Request(INGEST_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-Shared-Secret": route.internalSharedSecret,
          },
          body: JSON.stringify({
            mailbox,
            header_from: headerFrom,
            envelope_from: message.from,
            subject: parsed.subject ?? null,
            message_id: parsed.messageId ?? null,
            received_at: receivedAt,
            filename: pdf.filename ?? null,
            pdf_base64: toBase64(pdf),
          }),
        }),
      );
      if (res.status === 200) {
        sent++;
        console.log(`email-receiver: leave ingested (env=${route.env} mailbox=${mailbox})`);
      } else if (res.status === 202) {
        // 受け側が意図して捨てた (mailbox 不明・送信元不許可など)。正常扱い。
        sent++;
        console.log(`email-receiver: leave dropped by receiver (env=${route.env} mailbox=${mailbox})`);
      } else {
        console.error(
          `email-receiver: leave ingest failed (env=${route.env} mailbox=${mailbox} status=${res.status})`,
        );
      }
    } catch (e) {
      console.error(
        `email-receiver: leave ingest threw (env=${route.env} mailbox=${mailbox}) ${(e as Error).message}`,
      );
    }
  }
  return { sent };
}
