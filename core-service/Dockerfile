FROM node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d AS build

WORKDIR /workspace/core-service

COPY packages/suite-ui /workspace/packages/suite-ui
COPY core-service/package.json core-service/package-lock.json ./
RUN npm ci

COPY core-service/ .
RUN npm run build
RUN npm prune --omit=dev

FROM node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d AS runtime

ENV NODE_ENV=production
ENV PORT=4167
ENV DCO_CORE_DATA=/data/digital-core-office.sqlite

WORKDIR /app

COPY --from=build /workspace/core-service/package.json /workspace/core-service/package-lock.json ./
COPY --from=build /workspace/core-service/node_modules ./node_modules
COPY --from=build /workspace/core-service/dist ./dist
COPY --from=build /workspace/core-service/server ./server
COPY --from=build /workspace/core-service/scripts ./scripts
COPY --from=build /workspace/core-service/README.md ./
COPY LICENSE.md THIRD_PARTY_NOTICES.md ./
COPY deploy/scripts/backup-suite.mjs deploy/scripts/restore-suite.mjs deploy/scripts/suite-backup-lib.mjs deploy/scripts/scheduled-backup.mjs /app/deploy-scripts/

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 4167

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 4167) + '/api/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "--import", "tsx", "server/index.ts"]
