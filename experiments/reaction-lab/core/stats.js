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

export function createStats({ now = () => new Date() } = {}) {
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
      }
      return { recorded: true, duplicate: false, date };
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

    /** 容量回収だけが目的。動かなくても正しさには影響しない */
    prune(at = now()) {
      const keep = gameDate(at);
      for (const date of days.keys()) if (date !== keep) days.delete(date);
    },

    get dates() { return [...days.keys()]; },
  };
}
