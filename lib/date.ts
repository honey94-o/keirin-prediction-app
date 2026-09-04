/**
 * 日付関連の共通ユーティリティ。YYYYMMDD文字列を基本単位として扱う。
 * VercelやGitHub ActionsのサーバーはUTCで動くため、`new Date()`をそのまま
 * 使うと日本時間の日付境界（正午〜深夜）でズレる。競輪はJST基準の暦で開催
 * されるため、必ずJSTオフセット（+9時間）を明示的に足してから日付を取り出す。
 */

export function todayJstStr(): string {
  const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const y = jstNow.getUTCFullYear();
  const m = String(jstNow.getUTCMonth() + 1).padStart(2, "0");
  const d = String(jstNow.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

/** 現在時刻をJSTの"HH:MM"で返す。races.start_timeと同じ書式なので直接比較できる。 */
export function nowJstHHMM(): string {
  const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const hh = String(jstNow.getUTCHours()).padStart(2, "0");
  const mm = String(jstNow.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function addDaysToDateStr(dateStr: string, days: number): string {
  const y = Number(dateStr.slice(0, 4));
  const m = Number(dateStr.slice(4, 6));
  const d = Number(dateStr.slice(6, 8));
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  const ny = date.getUTCFullYear();
  const nm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const nd = String(date.getUTCDate()).padStart(2, "0");
  return `${ny}${nm}${nd}`;
}

export function formatDateStr(dateStr: string): string {
  return `${dateStr.slice(0, 4)}/${dateStr.slice(4, 6)}/${dateStr.slice(6, 8)}`;
}

/** YYYYMMDD形式かどうかだけの簡易チェック（実在の日付かまでは検証しない）。 */
export function isValidDateStr(s: string | undefined): s is string {
  return !!s && /^\d{8}$/.test(s);
}

/**
 * DBのTEXT型タイムスタンプ（"YYYY-MM-DD HH:MM:SS"、UTC。datetime('now')由来）を
 * JST表示用の"MM/DD HH:MM"に変換する。最終同期時刻の表示用。
 */
export function formatUtcAsJst(utcStr: string): string {
  const utcDate = new Date(`${utcStr.replace(" ", "T")}Z`);
  const jst = new Date(utcDate.getTime() + 9 * 60 * 60 * 1000);
  const m = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(jst.getUTCDate()).padStart(2, "0");
  const hh = String(jst.getUTCHours()).padStart(2, "0");
  const mm = String(jst.getUTCMinutes()).padStart(2, "0");
  return `${m}/${d} ${hh}:${mm}`;
}
