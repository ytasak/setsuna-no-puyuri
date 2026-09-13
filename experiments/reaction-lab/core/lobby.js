// 待機列の割り当て規則。I/O を持たない純粋な関数。
//
// docs/set2-3-matchmaking.md §3

/**
 * 待機列の先頭から見て、token が異なる最初の2人の位置を返す。
 * 見つからなければ null。
 *
 * 接続単位ではなく token 単位で見るのは、複数タブを開いた同じ人を
 * 自分自身と対戦させないため（§2）。
 *
 * @param {Array<{token: string}>} queue
 */
export function pickPair(queue) {
  for (let i = 0; i < queue.length; i++) {
    for (let j = i + 1; j < queue.length; j++) {
      if (queue[i].token !== queue[j].token) return [i, j];
    }
  }
  return null;
}

/** その token が既に待機列か対戦に所属しているか（1 token = 1所属、§3.3） */
export function isEngaged(token, { queue = [], engagedTokens = new Set() } = {}) {
  return engagedTokens.has(token) || queue.some((e) => e.token === token);
}
