#!/bin/sh
# Railway の Volume は root 所有でマウントされる。
# 非 root で動くイメージはそこに書けないので、Railway は RAILWAY_RUN_UID=0
# （＝アプリごと root で動かす）を案内している。
#
# それはやらない。ここで所有者を直すあいだだけ root でいて、
# アプリは node に降りてから起動する。アプリ本体が root で動くことはない。
#
# chown に失敗しても止めない。書けなければ戦績の保存が
# 「保存しない版」に落ちるだけで、対戦は続く（adapters/stats-store.js）。
set -e

DATA_DIR="${DATA_DIR:-/app/data}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR" 2>/dev/null || true
  chown -R node:node "$DATA_DIR" 2>/dev/null || true
  exec su-exec node "$@"
fi

# すでに非 root で動いている場合（ローカルで --user を付けたときなど）はそのまま
mkdir -p "$DATA_DIR" 2>/dev/null || true
exec "$@"
