FROM node:22-alpine AS build
WORKDIR /app
# Retry past transient DNS/network blips reaching Alpine's package CDN —
# cheap insurance against flaky build-host networking (e.g. a local DNS
# resolver that's briefly unreachable from the build container).
RUN for i in 1 2 3 4 5; do apk add --no-cache python3 make g++ && break || sleep 5; done
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-alpine
RUN for i in 1 2 3 4 5; do apk add --no-cache gosu tzdata && break || sleep 5; done
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV PORT=3000

VOLUME /data
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:3000/api/health || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
