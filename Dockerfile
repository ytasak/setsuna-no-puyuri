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
RUN apk add --no-cache tzdata
WORKDIR /app
ENV NODE_ENV=production TZ=Asia/Tokyo

COPY --from=deps /app/node_modules ./node_modules
COPY experiments/reaction-lab/package.json ./
COPY experiments/reaction-lab/server.js ./
COPY experiments/reaction-lab/core ./core
COPY experiments/reaction-lab/adapters ./adapters
COPY experiments/reaction-lab/public ./public

# 記録はメモリに持つので書き込み先は不要だが、CSV 出力が参照するので用意しておく
RUN mkdir -p data && chown -R node:node /app
USER node

EXPOSE 8787
CMD ["node", "server.js"]
