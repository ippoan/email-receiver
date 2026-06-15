/**
 * dtako (デジタコ) からのエラー通知メール subject パーサ。
 *
 * 対象 subject 例 (epic ippoan/email-receiver#1 より):
 *   `[web金星号] SDカードエラー通知メール … (16) 十勝800か16`
 *
 * subject に `SDカードエラー` (全角/半角・スペース揺れ許容) が含まれる場合のみマッチし、
 * `(数字) 文字列` 形式の車両表記を vehicle_name として抜き出す。
 *
 * マッチしない subject は null を返し、index.ts 側で silent drop する。
 *
 * 将来 `エンジン異常` 等の別 error_kind を増やす時は parse 関数を追加し、
 * dispatch 側で順に試す。
 */
export type DtakoErrorKind = "sd_card_error";

export interface DtakoSubject {
  errorKind: DtakoErrorKind;
  vehicleName: string;
}

const SD_CARD_RE = /SD\s*カード\s*エラー/u;
// `(16) 十勝800か16` のような `(<digits>) <非空白>` を捕捉。
// 後続の余分な記号 (… や 全角空白) は trim で落とす。
const VEHICLE_RE = /(\([0-9]+\)\s*[^\s\]）]+)/u;

export function parseDtakoSubject(subjectRaw: string | null | undefined): DtakoSubject | null {
  if (!subjectRaw) return null;
  // `[web金星号]` のような subject prefix は読み飛ばし、残りで判定する。
  const subject = subjectRaw.normalize("NFKC");
  if (!SD_CARD_RE.test(subject)) return null;
  const m = subject.match(VEHICLE_RE);
  if (!m) return null;
  const vehicleName = m[1].trim();
  if (!vehicleName) return null;
  return { errorKind: "sd_card_error", vehicleName };
}
