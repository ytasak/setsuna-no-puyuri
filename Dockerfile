# 1コンテナ構成。Node のプロセスが静的ファイルと WebSocket の両方を配信するため、
# ゲーム本体と対戦サーバーは常に同一 Origin になる。
#
# kusa へは iframe で埋め込まれるので、埋め込みを拒否するヘッダを出さないこと。
# X-Frame-Options も CSP frame-ancestors も設定していない（出すと真っ白になる）。

FROM node:24-alpine AS deps
WORKDIR /app
COPY experiments/reaction-lab/package.json experiments/reaction-lab/package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-alpine
# su-exec は起動時に root から node へ降りるために使う（docker-entrypoint.sh）
RUN apk add --no-cache tzdata su-exec
WORKDIR /app
# DATA_DIR に戦績の SQLite を置く。Railway ではここに Volume をマウントする
ENV NODE_ENV=production TZ=Asia/Tokyo DATA_DIR=/app/data

COPY --from=deps /app/node_modules ./node_modules
COPY experiments/reaction-lab/package.json ./
COPY experiments/reaction-lab/server.js ./
COPY experiments/reaction-lab/core ./core
COPY experiments/reaction-lab/adapters ./adapters
COPY experiments/reaction-lab/public ./public

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
 && mkdir -p "$DATA_DIR" && chown -R node:node /app

# USER は指定しない。Volume の所有者を直すために起動の一瞬だけ root でいて、
# entrypoint が node に降りてからアプリを起動する。
# （Railway の案内どおり RAILWAY_RUN_UID=0 にすると、アプリ本体が root で動いてしまう）
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

EXPOSE 8787
CMD ["node", "server.js"]
