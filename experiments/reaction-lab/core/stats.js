// その日だけの戦績とランキング。
//
// 日次リセットは「ゲーム日でスコープする」ことで成立させる。
// 古い日付は参照されないので消えているのと同じ。prune は容量回収だけが目的で、
// 遅れても、二重に動いても、動かなくても正しさに影響しない。
//
// docs/set2-6-stats-ranking.md

import { gameDate } from './clock.js';
import { nickname } from './nickname.js';

/** 連勝の増減。引き分けと無効試合では切らさない（§6.2） */
function nextStreak(streak, outcome, recorded) {
  if (!recorded) return streak;             // 記録されない試合はノーカウント
  if (outcome === 'win') return streak + 1;
  if (outcome === 'lose') return 0;
  return streak;                            // draw / void は維持
}

/** 最速記録の対象になるか。負けた試合も対象にする（§6.1） */
function countsForBest(p, recorded) {
  return recorded
    && p.R != null
    && !p.flying && !p.tooFast && !p.noInput && !p.disconnected;
}

/**
 * @param onChange 1人ぶんの戦績が変わるたびに呼ばれる。保存層をつなぐための口。
 *   core に I/O を持ち込まないためのフックなので、**この中で例外を投げないこと**。
 *   投げると試合の確定処理ごと巻き込む。保存に失敗しても握りつぶすのは呼ぶ側の責任。
 */
export function createStats({ now = () => new Date(), onChange = null } = {}) {
  /** @type {Map<string, {players: Map<string, object>, seen: Set<string>}>} */
  const days = new Map();

  const day = (date) => {
    let d = days.get(date);
    if (!d) { d = { players: new Map(), seen: new Set() }; days.set(date, d); }
    return d;
  };

  const blank = (token, date) => ({
    token, date, name: nickname(token, date),
    games: 0, win: 0, lose: 0, draw: 0, voided: 0,
    bestR: null, bestRAt: null,
    streak: 0, bestStreak: 0, bestStreakAt: null,
  });

  return {
    /** 1ラウンドの結果を取り込む。同じ resultId の2回目は捨てる（§5.1） */
    record(result, tokenOf, at = now()) {
      const date = gameDate(at);
      const d = day(date);
      if (d.seen.has(result.resultId)) return { recorded: false, duplicate: true };
      d.seen.add(result.resultId);

      for (const p of result.players) {
        const token = tokenOf(p.id);
        if (!token) continue;
        let s = d.players.get(token);
        if (!s) { s = blank(token, date); d.players.set(token, s); }

        s.games += 1;
        if (result.recorded) {
          if (p.result === 'win') s.win += 1;
          else if (p.result === 'lose') s.lose += 1;
          else if (p.result === 'draw') s.draw += 1;
        } else {
          s.voided += 1;
        }

        s.streak = nextStreak(s.streak, p.result, result.recorded);
        if (s.streak > s.bestStreak) { s.bestStreak = s.streak; s.bestStreakAt = at.toISOString(); }

        if (countsForBest(p, result.recorded) && (s.bestR === null || p.R < s.bestR)) {
          s.bestR = p.R; s.bestRAt = at.toISOString();
        }

        onChange?.(s);
      }
      return { recorded: true, duplicate: false, date };
    },

    /**
     * 保存してあった行を読み戻す。起動時に1回だけ呼ぶ。
     *
     * onChange は呼ばない。読み戻したものをそのまま書き戻すことになるし、
     * 起動のたびに全行を書き直すのは無駄でしかない。
     *
     * resultId の集合（seen）は復元しない。結果はこのプロセスの中でしか作られないので、
     * 再起動をまたいで同じ resultId が再び届くことがない。seen は
     * 「同じプロセスの中で二重に record しない」ための防御であって、永続化する意味がない。
     */
    restore(rows = []) {
      let n = 0;
      for (const row of rows) {
        if (!row?.date || !row?.token) continue;
        // 列が欠けていても blank で埋まるようにしておく
        day(row.date).players.set(row.token, { ...blank(row.token, row.date), ...row });
        n += 1;
      }
      return n;
    },

    /** 本人向けの当日戦績 */
    daily(token, at = now()) {
      const date = gameDate(at);
      return day(date).players.get(token) ?? blank(token, date);
    },

    /**
     * 当日ランキング2種。同点は先に記録した方が上（§6.3）。
     * token は絶対に外へ出さない（§6.4）
     */
    ranking(at = now(), limit = 10) {
      const date = gameDate(at);
      const all = [...day(date).players.values()];
      const pub = (s, value) => ({ name: s.name, value });

      const fastest = all.filter((s) => s.bestR !== null)
        .sort((a, b) => (a.bestR - b.bestR) || (a.bestRAt < b.bestRAt ? -1 : 1))
        .slice(0, limit).map((s) => pub(s, Math.round(s.bestR)));

      const streak = all.filter((s) => s.bestStreak > 0)
        .sort((a, b) => (b.bestStreak - a.bestStreak) || (a.bestStreakAt < b.bestStreakAt ? -1 : 1))
        .slice(0, limit).map((s) => pub(s, s.bestStreak));

      return { date, fastest, streak, players: all.length };
    },

    /**
     * 当日の全体集計。個人は出さず、傾向だけ見る。
     *
     * 1試合につき2人ぶん記録されるので、試合数の系統は2で割る。
     * 決着した試合は「勝ち」がちょうど1つなので、勝ちの総和がそのまま決着数になる。
     *
     * 同着幅 D をこのままにしてよいか（引き分けが多すぎないか）を
     * 実データで判断するために足した。合計しか出さないので token は漏れない。
     */
    summary(at = now()) {
      const date = gameDate(at);
      const all = [...day(date).players.values()];
      const sum = (k) => all.reduce((t, s) => t + (s[k] ?? 0), 0);

      const matches = sum('games') / 2;
      const draws = sum('draw') / 2;
      const voided = sum('voided') / 2;
      const decided = sum('win');

      return {
        date, players: all.length,
        matches, decided, draws, voided,
        drawRate: matches ? Number((draws / matches).toFixed(4)) : 0,
        // 内訳が足し合わないときは片側しか記録されていない試合がある
        raw: { games: sum('games'), win: sum('win'), lose: sum('lose'), draw: sum('draw'), voided: sum('voided') },
      };
    },

    /** 容量回収だけが目的。動かなくても正しさには影響しない */
    prune(at = now()) {
      const keep = gameDate(at);
      for (const date of days.keys()) if (date !== keep) days.delete(date);
    },

    get dates() { return [...days.keys()]; },
  };
}
