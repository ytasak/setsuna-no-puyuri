# 刹那のぷゆり — アプリ本体

ディレクトリ名は SET2-4「同期・公平性」の実測用プロトタイプだったころのもの。
いまはここがアプリそのもの。

判定の考え方は [`../../docs/set2-4-sync-fairness.md`](../../docs/set2-4-sync-fairness.md)、
画面と演出は [`../../docs/set2-5-ui.md`](../../docs/set2-5-ui.md)。

## 構成

```
core/match.js        … 判定。decide() と DEFAULT_CFG だけ。I/O を持たない
core/stats.js        … 当日の戦績とランキング。I/O を持たない
core/clock.js        … ゲーム日（JST の暦日）
core/nickname.js     … その日限りの二つ名
adapters/server.js   … HTTP。静的配信と記録の口。ここだけが I/O を持つ
adapters/stats-store.js … SQLite への保存
public/game.{html,js}   … ゲーム本体
public/rules-bridge.js  … core/match.js をブラウザへ渡す橋
server.js            … エントリポイント
```

**依存パッケージは無い。** `npm install` は何も入れない。

### 判定の実体は1つだけ

ブラウザは `/core/match.js` として `core/match.js` をそのまま読む（`public/rules-bridge.js` 経由）。
サーバーは判定しない。**判定を書き写すと、直したときに片方だけ直って食い違う。**

## テスト

```bash
npm test
```

51件、0.2秒ほど。時計は偽物を渡すので実時間を待たない。
HTTP のテストは同一プロセスでサーバーを起こして叩く。

## 起動

```bash
npm start
```

起動時にローカルURLと**LANのURL**を表示する。スマホからは LAN のURLを開く（同一ネットワークにいること）。

| パス | 用途 |
|---|---|
| `/` | **ゲーム本体**（`/game.html` と同じもの）|
| `/embed-test.html` | iframe に埋め込んだ見え方の確認 |
| `/api/health` | ヘルスチェック。起動時刻と直近の異常終了も返す |
| `/api/me` | 二つ名・自分の当日の記録・最速ランキング |
| `/api/result` | 1ラウンドぶんを記録する（POST）|
| `/api/ranking` | 当日ランキング |
| `/core/match.js` | 判定規則 |

```bash
COOKIE_SECURE=1 npm start   # 本番相当。Secure + SameSite=None + Partitioned が付く
PERSIST=0 npm start         # 保存しない。メモリだけで動く
DATA_DIR=/tmp/puyuri npm start
```

閾値（ランダム待機 `W`、入力期限 `T`）は `core/match.js` の `DEFAULT_CFG` にある。
ブラウザが直接読むので環境変数では振れない。

## 判定

```
合図の前に抜いた → 負け
抜かなかった     → 負け
それ以外         → 速いほうが勝ち
```

引き分けは無い。相手（道場の各段）は合図の前に抜かず、切断もせず、必ず期限内に抜くので、
引き分けになり得る条件が揃わない。

生理的下限 `R_min`（100ms）と同着幅 `D`（20ms）はマルチプレイと一緒に廃止した。
`R_min` は相手のいる勝負で予測入力を弾くため、`D` は回線差と計測のばらつきを
引き分けに逃がすためのものだった。相手が同じ端末の中にいる今は、どちらも守るものが無い。

## 記録

道場の1ラウンドごとに `POST /api/result` を投げる。本文はこれだけ。

```json
{ "id": "<使い捨ての一意な文字列>", "result": "win", "R": 210.4, "flying": false, "noInput": false }
```

`id` を連番にしないこと。ページを開き直すと以前のラウンドと同じ id になり、
二重記録の防止（`resultId` の照合）に引っかかって捨てられる。

サーバーは型だけ見て受ける。**値の正しさは確かめない。**
`curl` で直に叩けば最速ランキングは書き換えられる（[SET2-4 §5.3](../../docs/set2-4-sync-fairness.md)）。

記録に失敗しても遊ぶほうは止まらない。サーバーが落ちていても道場は最後まで動き、
「記録につながりませんでした」と出るだけ。

## 公開エンドポイントとしての手当て

| 項目 | 状態 |
|---|---|
| 受信サイズの上限 | `POST /api/result` は 8KB。超えたら読むのをやめて接続を捨てる |
| 入力の検査 | 型と範囲だけ。`id` の形、`result` が win/lose か、`R` が有限で 0〜60000 か |
| ログ | 出すのは起動と異常終了だけ。**token はどこにも出さない** |
| 秘密情報 | 持っていない。環境変数はポートと保存先のみ |
| 異常終了 | `stats.db` の `diag` 表に残し、`/api/health` から読める |

接続数や頻度の制限は入れていない。趣味の規模では過剰と判断した。
必要になったら IP 単位から足すのが素直。
