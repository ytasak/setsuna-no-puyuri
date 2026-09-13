// 戦績の保存。
//
// 戦績はメモリに持っているだけだったので、再デプロイのたびにその日の記録が消えていた。
// 日次リセット前提なので「1日ぶん消えるだけ」ではあるが、演出を直して出すたびに
// ランキングが 0 に戻るのは困る。
//
// core/stats.js は I/O を持たない。ここが唯一のディスクへの口で、
// createStats の onChange から1人ぶんずつ呼ばれる。
//
// **保存に失敗しても対戦は続けること。** 記録が残らないのは残念だが、
// それでゲームが止まるほうがずっと悪い。失敗したら黙ってメモリだけで動き続ける。
//
// docs/set2-6-stats-ranking.md §7

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * STRICT にはしていない。bestR は ms の小数だが、たまたま整数になった値を
 * node:sqlite が INTEGER として渡すことがあり、STRICT だとそこで弾かれる。
 * SQLite 本来の緩い型で受けるほうがこの用途では素直。
 *
 * 主キーが (date, token) なので、日をまたいでも同じ人の行は別物になる。
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS daily (
    date         TEXT NOT NULL,
    token        TEXT NOT NULL,
    name         TEXT NOT NULL,
    games        INTEGER NOT NULL DEFAULT 0,
    win          INTEGER NOT NULL DEFAULT 0,
    lose         INTEGER NOT NULL DEFAULT 0,
    draw         INTEGER NOT NULL DEFAULT 0,
    voided       INTEGER NOT NULL DEFAULT 0,
    bestR        REAL,
    bestRAt      TEXT,
    streak       INTEGER NOT NULL DEFAULT 0,
    bestStreak   INTEGER NOT NULL DEFAULT 0,
    bestStreakAt TEXT,
    PRIMARY KEY (date, token)
  );
`;

const UPSERT = `
  INSERT INTO daily
    (date, token, name, games, win, lose, draw, voided, bestR, bestRAt, streak, bestStreak, bestStreakAt)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(date, token) DO UPDATE SET
    name = excluded.name,
    games = excluded.games, win = excluded.win, lose = excluded.lose,
    draw = excluded.draw, voided = excluded.voided,
    bestR = excluded.bestR, bestRAt = excluded.bestRAt,
    streak = excluded.streak,
    bestStreak = excluded.bestStreak, bestStreakAt = excluded.bestStreakAt
`;

/** node:sqlite は undefined を受け取れない。null に寄せる */
const n = (v) => (v === undefined ? null : v);

/** 保存しない版。Volume が無い環境とテスト用 */
const noStore = { save() {}, load() { return []; }, prune() {}, close() {}, get ok() { return false; } };

/**
 * 戦績の保存先を開く。開けなければ保存しない版を返す。
 *
 * @param {string} file  SQLite ファイルのパス
 * @param {{enabled?: boolean, log?: (...a: unknown[]) => void}} options
 */
export function openStatsStore(file, { enabled = true, log = console.warn } = {}) {
  if (!enabled) return noStore;

  let db;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    db = new DatabaseSync(file);
    // WAL にしておくと書き込みが読み取りを止めない。
    // synchronous=NORMAL は WAL と組むと、クラッシュで最後の数件を落とす代わりに速い。
    // 1日で消える記録なので、そのくらいの割り切りでよい。
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec(SCHEMA);
  } catch (e) {
    log(`[stats] 保存先を開けないのでメモリだけで動きます: ${file} (${e.message})`);
    try { db?.close(); } catch { /* 開けていないなら閉じるものも無い */ }
    return noStore;
  }

  const upsert = db.prepare(UPSERT);
  const selectDay = db.prepare('SELECT * FROM daily WHERE date = ?');
  const deleteOther = db.prepare('DELETE FROM daily WHERE date <> ?');

  // 一度こけたら以降は黙る。試合ごとに同じ警告を出し続けても意味がない
  let broken = false;
  const guard = (what, fn, fallback) => {
    if (broken) return fallback;
    try {
      return fn();
    } catch (e) {
      broken = true;
      log(`[stats] ${what}に失敗したので、以降はメモリだけで動きます (${e.message})`);
      return fallback;
    }
  };

  return {
    /** 1人ぶんを書く。createStats の onChange から呼ばれるので、絶対に投げない */
    save(s) {
      guard('保存', () => upsert.run(
        s.date, s.token, s.name,
        s.games, s.win, s.lose, s.draw, s.voided,
        n(s.bestR), n(s.bestRAt),
        s.streak, s.bestStreak, n(s.bestStreakAt),
      ));
    },

    /**
     * その日の行を読む。起動時に1回だけ。
     *
     * node:sqlite が返す行は prototype が null なので、素のオブジェクトに写し替える。
     * そのまま配ると deepStrictEqual が通らないなど、呼ぶ側で驚くことになる。
     */
    load(date) {
      return guard('読み込み', () => selectDay.all(date).map((r) => ({ ...r })), []);
    },

    /** 当日以外を捨てる。容量回収だけが目的なので、失敗しても困らない */
    prune(keepDate) {
      guard('掃除', () => deleteOther.run(keepDate));
    },

    close() {
      try { db.close(); } catch { /* 閉じられないなら諦める */ }
    },

    get ok() { return !broken; },
  };
}
