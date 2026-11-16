FROM node:22-alpine

ENV NODE_ENV=production \
    TZ=Asia/Jakarta \
    DATA_DIR=/data \
    PORT=3000

RUN apk add --no-cache su-exec tzdata

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .
RUN chmod +x docker-entrypoint.sh && mkdir -p /data && chown -R node:node /app /data

VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/healthz" >/dev/null || exit 1

# Entrypoint memastikan /data bisa ditulis (volume dari Coolify kadang dimiliki root), lalu turun ke user "node".
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
