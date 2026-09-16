// 勝ち負けの決め方。
//
// **I/O を持たない。** ブラウザは /core/match.js としてこれをそのまま読むので、
// 判定の実体はこの1本しかない。書き写すと必ず食い違う。
//
// もとは対人戦1ルームの状態遷移も抱えていたが、マルチプレイの廃止で判定だけが残った。
// 判定規則の経緯は docs/set2-4-sync-fairness.md §5。

export const DEFAULT_CFG = {
  wMin: 1000,           // ランダム待機の下限 [ms]
  wMax: 4000,           // ランダム待機の上限 [ms]
  inputDeadline: 3000,  // 入力期限 T [ms]
};

/**
 * 1ラウンドの結果。自分から見た 'win' か 'lose' しか返さない。
 *
 * 優先順位: フライング > 無入力 > 反応時間の比較
 *
 * **同着の幅（D=20ms）も生理的下限（R_min=100ms）も持たない。**
 * どちらも対人戦のためのものだった。D は回線差と計測のばらつきを引き分けに逃がすため、
 * R_min は相手のいる勝負で予測入力を弾くためにあった。
 * 相手が同じ端末の中にいる今は、どちらも守るものが無い。
 *
 * 引き分けも無い。相手は合図の前に抜かず、切断もせず、必ず期限内に抜くので、
 * 引き分けになり得る条件（双方フライング・双方無入力・同着）が揃わない。
 *
 * @param {{flying?:boolean, noInput?:boolean, R?:number|null}} me
 * @param {{flying?:boolean, noInput?:boolean, R?:number|null}} foe
 */
export function decide(me, foe) {
  if (me.flying) return 'lose';        // 合図より前に抜いた
  if (foe.flying) return 'win';
  if (me.noInput) return 'lose';       // 期限まで抜かなかった
  if (foe.noInput) return 'win';
  return me.R <= foe.R ? 'win' : 'lose';
}
