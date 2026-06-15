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
      console.log("email-receiver: missing host", { to: message.to });
      return;
    }

    const route = pickRoute(hostRaw, env);
    if (!route) {
      console.log("email-receiver: no route for host", { to: message.to });
      return;
    }

    let parsed: Awaited<ReturnType<typeof PostalMime.parse>>;
    try {
      parsed = await PostalMime.parse(message.raw);
    } catch (e) {
      message.setReject(`MIME parse failed: ${(e as Error).message}`);
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
      message.setReject(`Handler failed: ${(e as Error).message}`);
      return;
    }

    if (!dispatch.handler) {
      // どの handler にもマッチしなかった: silent drop。
      console.log("email-receiver: no handler matched", {
        route: route.env,
        from: email.from,
        subject: email.subject,
      });
      return;
    }

    console.log("email-receiver: handler matched", {
      route: route.env,
      handler: dispatch.handler,
      result: dispatch.result,
    });
  },
};
