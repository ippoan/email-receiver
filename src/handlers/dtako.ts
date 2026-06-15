import type { Env } from "../env";
import { parseDtakoSubject } from "../parsers/dtako-subject";

/**
 * dtako SD カードエラー通知メール用 handler。
 *
 * pipeline:
 *   1. subject から vehicle_name + error_kind を抽出
 *   2. rust-alc-api POST /api/dtako/tickets で起票 (id を受け取る)
 *   3. dtako-scraper POST /scrape-vehicle-setting で F-VOS3020 設定 ZIP DL
 *   4. rust-alc-api PATCH /api/dtako/tickets/{id}/scraped で結果反映
 *
 * 失敗時の方針:
 *   - ステップ 1 でマッチしなければ `{ matched: false }` を返す (= silent drop)
 *   - ステップ 2 で失敗したら例外を投げて caller (index.ts) で setReject
 *   - ステップ 3-4 で失敗したら起票は完了している (= "open" の ticket が残る) ので
 *     例外は投げず、ticket status は "open" のまま log を残す。後追いで manual rescrape 可能。
 *
 * 依存先 API は ippoan/rust-alc-api#414 と ohishi-exp/dtako-scraper#5 で実装中。
 * 仕様確定までは 404/501 が返る可能性があるが、wire format は最終形に合わせてある。
 */

export interface ParsedEmail {
  from: string | null;
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  messageId: string | null;
  receivedAt: string;
}

export interface DtakoHandleResult {
  matched: boolean;
  ticketId?: string;
  scraped?: boolean;
  vehicleName?: string;
  errorKind?: string;
}

interface TicketCreateResponse {
  id: string;
}

interface ScrapeResponse {
  comp_id?: string;
  unko_no?: string;
  operation_started_at?: string;
  operation_ended_at?: string;
  zip_path?: string;
  zip_size_bytes?: number;
  zip_base64?: string;
}

export async function handleDtakoEmail(
  email: ParsedEmail,
  env: Env,
): Promise<DtakoHandleResult> {
  const parsed = parseDtakoSubject(email.subject);
  if (!parsed) {
    return { matched: false };
  }

  if (!env.DTAKO_TENANT_ID) {
    console.warn("dtako handler: DTAKO_TENANT_ID is empty, skipping ingest", {
      subject: email.subject,
    });
    return { matched: true, vehicleName: parsed.vehicleName, errorKind: parsed.errorKind };
  }

  const ticketId = await createTicket(email, parsed.vehicleName, parsed.errorKind, env);

  // 起票後の scrape + patch は best-effort。失敗時は ticket を open のまま残し、
  // 運用側で手動 retry できるよう log だけ残す。
  try {
    const scrape = await scrapeVehicleSetting(parsed.vehicleName, email.receivedAt, env);
    await patchScraped(ticketId, scrape, env);
    return {
      matched: true,
      ticketId,
      scraped: true,
      vehicleName: parsed.vehicleName,
      errorKind: parsed.errorKind,
    };
  } catch (e) {
    console.error("dtako handler: scrape/patch failed", {
      ticketId,
      vehicleName: parsed.vehicleName,
      error: (e as Error).message,
    });
    return {
      matched: true,
      ticketId,
      scraped: false,
      vehicleName: parsed.vehicleName,
      errorKind: parsed.errorKind,
    };
  }
}

async function createTicket(
  email: ParsedEmail,
  vehicleName: string,
  errorKind: string,
  env: Env,
): Promise<string> {
  const url = `${env.ALC_API_BASE.replace(/\/$/, "")}/api/dtako/tickets`;
  const body = {
    source: "email",
    source_email_subject: email.subject,
    source_email_from: email.from,
    source_email_message_id: email.messageId,
    source_email_received_at: email.receivedAt,
    vehicle_name: vehicleName,
    error_kind: errorKind,
    raw_email_text: email.bodyText,
  };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Shared-Secret": env.INTERNAL_SHARED_SECRET,
      "X-Tenant-ID": env.DTAKO_TENANT_ID,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`createTicket ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as TicketCreateResponse;
  if (!data.id) {
    throw new Error("createTicket: response missing id");
  }
  return data.id;
}

async function scrapeVehicleSetting(
  vehicleName: string,
  receivedAt: string,
  env: Env,
): Promise<ScrapeResponse> {
  const res = await fetch(env.SCRAPER_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Scraper-API-Key": env.SCRAPER_API_KEY,
    },
    body: JSON.stringify({
      vehicle_name: vehicleName,
      received_at: receivedAt,
      skip_upload: true,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`scrape ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as ScrapeResponse;
}

async function patchScraped(
  ticketId: string,
  scrape: ScrapeResponse,
  env: Env,
): Promise<void> {
  const url = `${env.ALC_API_BASE.replace(/\/$/, "")}/api/dtako/tickets/${ticketId}/scraped`;
  const body = {
    comp_id: scrape.comp_id ?? null,
    unko_no: scrape.unko_no ?? null,
    operation_started_at: scrape.operation_started_at ?? null,
    operation_ended_at: scrape.operation_ended_at ?? null,
    settings_zip_r2_key: scrape.zip_path ?? null,
    scraped_payload: scrape,
  };
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Shared-Secret": env.INTERNAL_SHARED_SECRET,
      "X-Tenant-ID": env.DTAKO_TENANT_ID,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`patchScraped ${res.status}: ${text.slice(0, 200)}`);
  }
}
