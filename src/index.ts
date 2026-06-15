import PostalMime from "postal-mime";
import type { Env } from "./env";
import { dispatchEmail } from "./handlers";
import type { ParsedEmail } from "./handlers/dtako";

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
      dispatch = await dispatchEmail(email, env);
    } catch (e) {
      message.setReject(`Handler failed: ${(e as Error).message}`);
      return;
    }

    if (!dispatch.handler) {
      // どの handler にもマッチしなかった: silent drop。
      console.log("email-receiver: no handler matched", {
        from: email.from,
        subject: email.subject,
      });
      return;
    }

    console.log("email-receiver: handler matched", {
      handler: dispatch.handler,
      result: dispatch.result,
    });
  },
};
