import { describe, expect, it } from "vitest";
import { uint8ArrayToBase64 } from "../../src/lib/base64";

describe("uint8ArrayToBase64", () => {
  it("encodes a small buffer", () => {
    const bytes = new TextEncoder().encode("hello");
    expect(uint8ArrayToBase64(bytes)).toBe(btoa("hello"));
  });

  it("encodes an empty buffer", () => {
    expect(uint8ArrayToBase64(new Uint8Array())).toBe("");
  });

  it("handles buffers larger than chunkSize", () => {
    const big = new Uint8Array(0x8000 + 17).fill(0x41);
    const out = uint8ArrayToBase64(big);
    expect(out).toBe(btoa("A".repeat(0x8000 + 17)));
  });
});
