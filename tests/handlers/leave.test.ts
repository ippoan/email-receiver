import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleLeaveEmail, verifySenderAuth } from "../../src/handlers/leave";
import type { LeaveRoute } from "../../src/router";

const CF_PASS =
  "mx.cloudflare.net; dkim=pass header.d=example.com; spf=pass smtp.mailfrom=example.com; dmarc=pass header.from=example.com";

interface MailOpts {
  to?: string;
  headers?: string[];
  pdfs?: { name: string; type?: string }[];
  other?: number;
  from?: string;
}

function rawMail(o: MailOpts = {}): ReadableStream {
  const b = "BOUNDARY";
  const lines = [
    ...(o.headers ?? [`Authentication-Results: ${CF_PASS}`]),
    `From: Alice <${o.from ?? "alice@example.com"}>`,
    "To: x@leave.ippoan.org",
    "Subject: 休暇申請",
    "Message-ID: <abc@example.com>",
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${b}"`,
    "",
    `--${b}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    "body",
  ];
  for (const p of o.pdfs ?? [{ name: "a.pdf", type: "application/pdf" }]) {
    lines.push(
      `--${b}`,
      `Content-Type: ${p.type ?? "application/pdf"}; name="${p.name}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${p.name}"`,
      "",
      btoa(`%PDF-1.4 ${p.name}`),
    );
  }
  for (let i = 0; i < (o.other ?? 0); i++) {
    lines.push(
      `--${b}`,
      'Content-Type: image/png; name="x.png"',
      "Content-Transfer-Encoding: base64",
      'Content-Disposition: attachment; filename="x.png"',
      "",
      btoa("png"),
    );
  }
  lines.push(`--${b}--`, "");
  return new Response(lines.join("\r\n")).body!;
}

function msg(o: MailOpts = {}) {
  return { to: o.to ?? "Leave-Ohishi@leave.ippoan.org", from: "bounce@mta.example.com", raw: rawMail(o) } as never;
}

describe("handleLeaveEmail", () => {
  const fetchMock = vi.fn();
  const route: LeaveRoute = {
    env: "prod",
    leaveWorker: { fetch: fetchMock as unknown as typeof fetch },
    internalSharedSecret: "SECRET-VALUE",
  };

  beforeEach(() => {
    fetchMock.mockReset().mockImplementation(async () => Response.json({ pages: 1 }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("posts one contract-shaped request per pdf; secret only in header", async () => {
    const r = await handleLeaveEmail(msg(), route, "2026-10-10T00:00:00.000Z");
    expect(r.sent).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const req = fetchMock.mock.calls[0][0] as Request;
    expect(req.url).toBe("https://rust-leave-worker/internal/ingest");
    expect(req.method).toBe("POST");
    expect(req.headers.get("X-Internal-Shared-Secret")).toBe("SECRET-VALUE");
    expect(req.headers.get("Content-Type")).toBe("application/json");
    const text = await req.text();
    expect(text).not.toContain("SECRET-VALUE");
    const body = JSON.parse(text);
    expect(Object.keys(body).sort()).toEqual([
      "envelope_from",
      "filename",
      "header_from",
      "mailbox",
      "message_id",
      "pdf_base64",
      "received_at",
      "subject",
    ]);
    expect(body).toMatchObject({
      mailbox: "leave-ohishi",
      header_from: "alice@example.com",
      envelope_from: "bounce@mta.example.com",
      subject: "休暇申請",
      message_id: "<abc@example.com>",
      received_at: "2026-10-10T00:00:00.000Z",
      filename: "a.pdf",
    });
    expect(atob(body.pdf_base64)).toBe("%PDF-1.4 a.pdf");
  });

  it("accepts .pdf extension with octet-stream, ignores non-pdf", async () => {
    const r = await handleLeaveEmail(
      msg({ pdfs: [{ name: "b.PDF", type: "application/octet-stream" }], other: 2 }),
      route,
    );
    expect(r.sent).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    "ab@leave.ippoan.org",
    "a_b_c@leave.ippoan.org",
    "ab.cd@leave.ippoan.org",
    `${"a".repeat(65)}@leave.ippoan.org`,
  ])("drops invalid local-part %s", async (to) => {
    const r = await handleLeaveEmail(msg({ to }), route);
    expect(r.sent).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("drops when there is no pdf", async () => {
    const r = await handleLeaveEmail(msg({ pdfs: [], other: 1 }), route);
    expect(r.dropped).toBe("no pdf attachment");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends only 10 of 11 pdfs", async () => {
    const pdfs = Array.from({ length: 11 }, (_, i) => ({ name: `f${i}.pdf` }));
    const r = await handleLeaveEmail(msg({ pdfs }), route);
    expect(r.sent).toBe(10);
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });

  it("continues after 5xx / throw and treats 202 as ok", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("x", { status: 503 }))
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(Response.json({ dropped: "unknown mailbox" }, { status: 202 }));
    const pdfs = [{ name: "1.pdf" }, { name: "2.pdf" }, { name: "3.pdf" }];
    const message = msg({ pdfs }) as { setReject?: () => void };
    message.setReject = vi.fn();
    const r = await handleLeaveEmail(message as never, route);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(r.sent).toBe(1);
    expect(console.error).toHaveBeenCalledTimes(2);
    expect(message.setReject).not.toHaveBeenCalled();
  });

  describe("sender auth", () => {
    it.each([
      ["dmarc pass", "Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=example.com", true],
      ["spf+dkim pass", "Authentication-Results: mx.cloudflare.net; spf=pass; dkim=pass", true],
      ["spf only", "Authentication-Results: mx.cloudflare.net; spf=pass; dkim=fail", false],
      ["dmarc fail", "Authentication-Results: mx.cloudflare.net; dmarc=fail; spf=pass; dkim=none", false],
      ["ARC pass", "ARC-Authentication-Results: i=1; mx.cloudflare.net; dmarc=pass", true],
      ["forged authserv-id", "Authentication-Results: evil.example.org; dmarc=pass; spf=pass; dkim=pass", false],
      ["lookalike authserv-id", "Authentication-Results: evilmx.cloudflare.net; dmarc=pass", false],
      ["no header", null, false],
    ] as [string, string | null, boolean][])("%s", async (_n, header, ok) => {
      await handleLeaveEmail(msg({ headers: header ? [header] : [] }), route);
      expect(fetchMock).toHaveBeenCalledTimes(ok ? 1 : 0);
    });

    it("ignores a forged cloudflare line placed below the top one", async () => {
      await handleLeaveEmail(
        msg({
          headers: [
            "Authentication-Results: mx.cloudflare.net; dmarc=fail",
            "Authentication-Results: mx.cloudflare.net; dmarc=pass",
          ],
        }),
        route,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("logs a distinguishable message when no cloudflare result exists", async () => {
      await handleLeaveEmail(msg({ headers: [] }), route);
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining("leave: no cloudflare auth result"));
    });

    it("verifySenderAuth reason", () => {
      expect(verifySenderAuth([])).toEqual({ ok: false, reason: "no-cloudflare-result" });
      expect(
        verifySenderAuth([{ key: "authentication-results", originalKey: "", value: "mx.cloudflare.net; spf=fail" }]),
      ).toEqual({ ok: false, reason: "not-passed" });
    });
  });
});
