import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env, ServiceBinding } from "../src/env";

type Mock = ServiceBinding & { fetch: ReturnType<typeof vi.fn> };
const mk = (): Mock => ({ fetch: vi.fn(async () => Response.json({ pages: 1 })) as never });

const raw = () =>
  new Response(
    [
      "Authentication-Results: mx.cloudflare.net; dmarc=pass",
      "From: a@example.com",
      "Subject: hello",
      'Content-Type: multipart/mixed; boundary="B"',
      "",
      "--B",
      "Content-Type: application/pdf; name=a.pdf",
      "Content-Transfer-Encoding: base64",
      "Content-Disposition: attachment; filename=a.pdf",
      "",
      btoa("%PDF"),
      "--B--",
      "",
    ].join("\r\n"),
  ).body!;

describe("index host branching", () => {
  let leave: Mock, leaveStg: Mock, auth: Mock, authStg: Mock;
  let env: Env;
  const setReject = vi.fn();
  const send = (to: string) =>
    worker.email({ to, from: "x@example.com", raw: raw(), rawSize: 100, setReject } as never, env, {} as never);

  beforeEach(() => {
    leave = mk();
    leaveStg = mk();
    auth = mk();
    authStg = mk();
    env = {
      INTERNAL_SHARED_SECRET: { get: async () => "S" },
      SCRAPER_API_KEY: "k",
      DTAKO_R2_PREFIX: "p",
      AUTH_WORKER: auth,
      AUTH_WORKER_STAGING: authStg,
      DTAKO_TENANT_ID: "t",
      DTAKO_TENANT_ID_STAGING: "t2",
      SCRAPER_ENDPOINT: "https://s",
      SCRAPER_ENDPOINT_STAGING: "https://s2",
      LEAVE_WORKER: leave,
      LEAVE_WORKER_STAGING: leaveStg,
      LEAVE_HOST: "leave.ippoan.org",
      LEAVE_STAGING_HOST: "leave-staging.ippoan.org",
    } as Env;
    setReject.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("leave host → LEAVE_WORKER with resolved secret", async () => {
    await send("abc-def@leave.ippoan.org");
    expect(leave.fetch).toHaveBeenCalledTimes(1);
    const req = leave.fetch.mock.calls[0][0] as Request;
    expect(req.headers.get("X-Internal-Shared-Secret")).toBe("S");
    expect(leaveStg.fetch).not.toHaveBeenCalled();
  });

  it("leave-staging host → LEAVE_WORKER_STAGING", async () => {
    await send("abc-def@LEAVE-STAGING.ippoan.org");
    expect(leaveStg.fetch).toHaveBeenCalledTimes(1);
    expect(leave.fetch).not.toHaveBeenCalled();
  });

  it("dtako host → dtako path, leave untouched", async () => {
    await send("anything@dtako.ippoan.org");
    expect(leave.fetch).not.toHaveBeenCalled();
    expect(leaveStg.fetch).not.toHaveBeenCalled();
    expect(setReject).not.toHaveBeenCalled(); // subject 不一致 → silent drop
  });

  it("other host → silent drop", async () => {
    await send("abc-def@example.org");
    expect(leave.fetch).not.toHaveBeenCalled();
    expect(auth.fetch).not.toHaveBeenCalled();
    expect(setReject).not.toHaveBeenCalled();
  });

  it("leave host without binding → silent drop, never falls to dtako", async () => {
    delete env.LEAVE_WORKER;
    await send("abc-def@leave.ippoan.org");
    expect(setReject).not.toHaveBeenCalled();
    expect(auth.fetch).not.toHaveBeenCalled();
  });
});
