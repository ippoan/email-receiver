import type { Env } from "../env";
import { handleDtakoEmail, type ParsedEmail, type DtakoHandleResult } from "./dtako";

/**
 * email → handler dispatcher。
 *
 * 受信メールを順に handler に渡し、最初に `matched: true` を返した handler の結果で
 * 処理を完了する。どの handler もマッチしなければ silent drop。
 *
 * 新しい email type を増やす時はここに handler を 1 行追加する。
 */

export interface DispatchResult {
  handler: string | null;
  result: DtakoHandleResult | null;
}

export async function dispatchEmail(email: ParsedEmail, env: Env): Promise<DispatchResult> {
  const dtakoResult = await handleDtakoEmail(email, env);
  if (dtakoResult.matched) {
    return { handler: "dtako", result: dtakoResult };
  }

  return { handler: null, result: null };
}
