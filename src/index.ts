import PostalMime from "postal-mime";
import type { Env } from "./env";
import { dispatchEmail } from "./handlers";
import type { ParsedEmail } from "./handlers/dtako";
import { pickRoute } from "./router";

const MAX_RAW_BYTES = 10 * 1024 * 1024;

export default {
  async email(
    message: ForwardableEmailMessage,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    if (message.rawSize > MAX_RAW_BYTES) {
      message.setReject(`Raw message exceeds ${MAX_RAW_BYTES} bytes`);
      return;
    }

    // RCPT TO の host 部 (subdomain) で prod / staging を分岐。catch-all は
    // 1 つしか張れないため prod Worker に集約し、host で env を出し分ける。
    // 未対応 host や local-part 不在は silent drop (bounce は from 偽装で第三者
    // に送られうるため絶対に reject しない)。
    const [, hostRaw] = message.to.split("@");
    if (!hostRaw) {
      // host 実値は CF Observability の構造化引数に出ないため message 文字列に埋める。
      console.log(`email-receiver: missing host (to=${message.to})`);
      return;
    }

    const route = await pickRoute(hostRaw, env);
    if (!route) {
      // どの host にも一致しなかった / required env 欠落で silent drop。
      // CF Observability は console.log の構造化第2引数 (`{ ... }`) を展開
      // しないため、切り分け用情報は message 文字列に直接埋める。
      console.log(
        `email-receiver: no route for host (to=${message.to} host=${hostRaw} ` +
          `prodHost=${env.PROD_HOST ?? "<default>"} stagingHost=${env.STAGING_HOST ?? "<default>"})`,
      );
      return;
    }

    let parsed: Awaited<ReturnType<typeof PostalMime.parse>>;
    try {
      parsed = await PostalMime.parse(message.raw);
    } catch (e) {
      // setReject だけだと CF Observability に reject 理由が残らない
      // (bounce を見ない限り見えない)。console.error で実エラーを残す。
      const reason = `MIME parse failed: ${(e as Error).message}`;
      console.error(`email-receiver: setReject (route=${route.env} reason=${reason})`);
      message.setReject(reason);
      return;
    }

    const email: ParsedEmail = {
      from: parsed.from?.address ?? null,
      subject: parsed.subject ?? null,
      bodyText: parsed.text ?? null,
      bodyHtml: parsed.html ?? null,
      messageId: parsed.messageId ?? null,
      receivedAt: new Date().toISOString(),
    };

    let dispatch;
    try {
      dispatch = await dispatchEmail(email, route);
    } catch (e) {
      // dispatchEmail (= handleDtakoEmail) は createTicket 等の throw を握り
      // つぶさず投げ直す設計。ここで setReject だけ呼ぶと CF Observability に
      // 何が起きたか残らないため、必ず console.error で実エラーを残す。
      const reason = `Handler failed: ${(e as Error).message}`;
      console.error(
        `email-receiver: setReject (route=${route.env} from=${email.from ?? "<null>"} ` +
          `subject=${email.subject ?? "<null>"} reason=${reason})`,
      );
      message.setReject(reason);
      return;
    }

    if (!dispatch.handler) {
      // どの handler にもマッチしなかった: silent drop。
      // CF Observability は構造化引数を展開しないため message 文字列に埋める。
      console.log(
        `email-receiver: no handler matched (route=${route.env} ` +
          `from=${email.from ?? "<null>"} subject=${email.subject ?? "<null>"})`,
      );
      return;
    }

    console.log(
      `email-receiver: handler matched (route=${route.env} handler=${dispatch.handler} ` +
        `ticketId=${dispatch.result?.ticketId ?? "<none>"} ` +
        `scraped=${dispatch.result?.scraped ?? false} ` +
        `vehicle=${dispatch.result?.vehicleName ?? "<none>"})`,
    );
  },
};
