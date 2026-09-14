# 刹那のぷゆり

リアルタイム1対1の早押し対戦。
🥺（コミュニティ内の呼称「ぷゆゆ」）を使い、合図が出たら先にタップした方が勝ち。合図前のタップはフライング負け。

1試合は数秒〜十数秒。記録は毎日 0 時（JST）にリセットされる。

## 動かす

```bash
cd experiments/reaction-lab && npm install && npm start
```

| パス | 用途 |
|---|---|
| `/` | ゲーム本体 |
| `/lab.html` | 計測用の lab。診断値と CSV を取る |
| `/embed-test.html` | iframe に埋め込んだ見え方の確認 |
| `/api/health` | ヘルスチェック |
| `/api/ranking` | 当日ランキング（JSON）|
| `/api/summary` | 当日の全体集計。試合数・決着・引き分けの内訳 |

**同じブラウザで2タブ開いても対戦できない。** 同一 Cookie ＝同一 token なので自己対戦の防止が働く。
2人で試すには `localhost` と `127.0.0.1` で開いて Cookie を分ける。

## ディレクトリ

| パス | 内容 |
|---|---|
| `docs/` | 設計文書・判定規則・検証結果 |
| `experiments/reaction-lab/` | アプリ本体と計測用の lab |
| `Dockerfile` / `railway.json` | 公開用 |

## 決まっていること

| 項目 | 値 | 出典 |
|---|---|---|
| 判定方式 | クライアント計測 + 生理的下限のみ | [SET2-4 §3](docs/set2-4-sync-fairness.md) |
| 同着幅 `D` | 20 ms | SET2-4 §10.5 |
| 生理的下限 `R_min` | 100 ms | SET2-4 §5.3 |
| 入力期限 `T` | 3.0 秒 | |
| ランダム待機 `W` | 1.0〜4.0 秒 | |
| 識別子 | 非公開 Cookie（`Secure` + `SameSite=None` + `Partitioned`）| [SET2-6 §3](docs/set2-6-stats-ranking.md) |
| 戦績の置き場 | `DATA_DIR` の SQLite。当日ぶんだけ読む | [SET2-6 §5.3](docs/set2-6-stats-ranking.md) |
| ランキング | その日だけ。最速反応時間と最長連勝の2本 | SET2-6 §6 |

## 公開

Node + Railway。1コンテナで静的ファイルと WebSocket の両方を配信する。

```bash
docker build -t puyuri . && docker run -p 8787:8787 puyuri   # ローカルで確認
```

| 設定 | 値 |
|---|---|
| ビルド | リポジトリ直下の `Dockerfile` |
| ヘルスチェック | `/api/health` |
| ポート | `PORT` 環境変数（Railway が渡す）。既定 8787 |

### kusa の要件との対応

| 要件 | 対応 |
|---|---|
| iframe で表示される | 埋め込みを拒否するヘッダを出していない（`X-Frame-Options` も CSP `frame-ancestors` も設定しない）|
| 横幅 360px で見やすい | 360×540 / 320×420 で確認済み |
| https で置く | Railway のドメインで付く |
| 匿名で遊べる | ログインも入力も求めない |

### Cookie の Secure 属性は自動で付く

Railway は TLS を終端するので、アプリには平文で届く。
環境変数の設定漏れで Cookie の属性が落ちると **iOS Safari で identity が保てなくなる**ため、
`x-forwarded-proto: https` を見て自動で判断している。

```
https 経由 → Secure; SameSite=None; Partitioned
平文       → SameSite=Lax（ローカルでの動作確認用）
```

`COOKIE_SECURE=1` で強制することもできる。

### 戦績の保存には Volume が要る

戦績は `DATA_DIR` の SQLite（`stats.db`）に置く。**Railway で Volume をマウントしないと、
再デプロイのたびにその日の記録が消える。**

Railway のダッシュボードでサービスに Volume を追加し、マウント先を **`/app/data`** にする。
それだけでよく、環境変数の追加は要らない（`DATA_DIR` の既定が `/app/data`）。
別の場所にマウントしたい場合は `DATA_DIR` をそのパスに合わせる。

| | |
|---|---|
| 容量 | 1日ぶんで数十〜数百KB。Free の 0.5GB で十分 |
| レプリカ | **Volume とは併用できない。** 1インスタンスで動かす |
| 再デプロイ | Volume 付きのサービスは入れ替えに短いダウンタイムが出る |

Volume が無くても、書けなくても**サーバーは普通に動く**。戦績が残らないだけで、
起動ログに `保存しない（メモリのみ）` と出る。

Volume は root 所有でマウントされる。アプリを root で動かす（`RAILWAY_RUN_UID=0`）代わりに、
`docker-entrypoint.sh` が所有者を直してから `su-exec` で `node` に降りる。
**アプリ本体が root で動くことはない。**

### 環境変数

| 変数 | 既定 | 用途 |
|---|---|---|
| `PORT` | 8787 | Railway が渡す |
| `DATA_DIR` | `/app/data`（コンテナ）| 戦績の SQLite と CSV の置き場 |
| `PERSIST` | 有効 | `0` で戦績を保存しない（メモリのみ）|
| `CSV` | 本番は無効 | `1` で計測用 CSV を出す。**Volume を埋めるので常用しない** |
| `COOKIE_SECURE` | 自動判定 | `1` で Secure を強制 |
| `ALLOWED_ORIGINS` | 無効 | WebSocket の Origin 制限（任意）|
| `W_MIN` / `W_MAX` | 1000 / 4000 | ランダム待機 [ms] |
| `T` / `D` / `R_MIN` | 3000 / 20 / 100 | 入力期限・同着幅・生理的下限 [ms] |
| `REMATCH_TIMEOUT` | 60000 | 引き分けのあと再戦を待つ時間 [ms] |

## チケット

Linear チーム `setsuna_no_puyuri`（接頭辞 `SET2`）

| ID | 内容 | |
|---|---|---|
| SET2-1 | MVP・企画/仕様（親） | |
| SET2-2 | リアルタイム対戦：ルーム・状態遷移・結果確定 | ✅ |
| SET2-3 | マッチメイキング | ✅ |
| SET2-4 | 同期・公平性：合図・反応時間・不正対策 | ✅ |
| SET2-5 | UI/演出 | ✅ |
| SET2-6 | 戦績・ランキング | ✅ |
| SET2-7 | iframe組み込み（kusa連携） | |
| SET2-8 | 安全性/審査対応 | ✅ |
| SET2-9 | 戦績の永続化 | ✅ |
