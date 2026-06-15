import { describe, expect, it } from "vitest";
import { parseDtakoSubject } from "../../src/parsers/dtako-subject";

describe("parseDtakoSubject", () => {
  it("matches canonical SD card error subject", () => {
    const result = parseDtakoSubject(
      "[web金星号] SDカードエラー通知メール … (16) 十勝800か16",
    );
    expect(result).toEqual({
      errorKind: "sd_card_error",
      vehicleName: "(16) 十勝800か16",
    });
  });

  it("matches with halfwidth digits and various spacing", () => {
    const result = parseDtakoSubject(
      "[web金星号] SD カードエラー通知メール … (203) 札幌100あ203",
    );
    expect(result).toEqual({
      errorKind: "sd_card_error",
      vehicleName: "(203) 札幌100あ203",
    });
  });

  it("returns null when subject lacks SDカードエラー keyword", () => {
    expect(parseDtakoSubject("[web金星号] エンジン警告 … (16) 十勝800か16")).toBeNull();
  });

  it("returns null when vehicle pattern is missing", () => {
    expect(parseDtakoSubject("[web金星号] SDカードエラー通知メール")).toBeNull();
  });

  it("returns null for empty / null / undefined", () => {
    expect(parseDtakoSubject(null)).toBeNull();
    expect(parseDtakoSubject(undefined)).toBeNull();
    expect(parseDtakoSubject("")).toBeNull();
  });

  it("normalizes fullwidth digits via NFKC", () => {
    const result = parseDtakoSubject(
      "[web金星号] ＳＤカードエラー通知メール … （１６） 十勝800か16",
    );
    expect(result?.errorKind).toBe("sd_card_error");
    expect(result?.vehicleName).toBe("(16) 十勝800か16");
  });
});
