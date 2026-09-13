// ゲーム日の時刻抽象。
//
// このゲームのルールはすべて JST の暦日にスコープされるので、
// 日付に関わる処理は Date.now() を直接使わず必ずここを通す。
// テストでは固定した時刻を渡せるようにしてある。
//
// docs/set2-6-stats-ranking.md §2

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** JST の暦日を 'YYYY-MM-DD' で返す */
export function gameDate(now = new Date()) {
  const t = new Date(now.getTime() + JST_OFFSET_MS);
  const y = t.getUTCFullYear();
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 次に日付が変わる瞬間（JST 00:00）を返す */
export function nextReset(now = new Date()) {
  const t = new Date(now.getTime() + JST_OFFSET_MS);
  const next = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + 1);
  return new Date(next - JST_OFFSET_MS);
}

/** リセットまでの残り [ms] */
export function msUntilReset(now = new Date()) {
  return nextReset(now).getTime() - now.getTime();
}
