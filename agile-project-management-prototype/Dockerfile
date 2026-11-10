FROM node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d AS build

WORKDIR /workspace/agile-project-management-prototype

COPY packages/suite-ui /workspace/packages/suite-ui
COPY packages/core-client /workspace/packages/core-client
COPY agile-project-management-prototype/package.json agile-project-management-prototype/package-lock.json ./
RUN npm ci

COPY agile-project-management-prototype/ .
ARG VITE_BASE_PATH=/
ARG VITE_API_URL=
ARG VITE_TIME_URL=
ARG VITE_INVENTORY_URL=
ARG VITE_CORE_URL=
ARG VITE_ENABLED_MODULES=time,inventory,agile
ENV VITE_BASE_PATH=${VITE_BASE_PATH}
ENV VITE_API_URL=${VITE_API_URL}
ENV VITE_TIME_URL=${VITE_TIME_URL}
ENV VITE_INVENTORY_URL=${VITE_INVENTORY_URL}
ENV VITE_CORE_URL=${VITE_CORE_URL}
ENV VITE_ENABLED_MODULES=${VITE_ENABLED_MODULES}
RUN npm run build
RUN npm prune --omit=dev

FROM node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d AS runtime

ENV NODE_ENV=production
ENV PORT=4197
ENV AGILE_PROJECT_DATA=/data/agile-project.sqlite

WORKDIR /app

COPY --from=build /workspace/agile-project-management-prototype/package.json /workspace/agile-project-management-prototype/package-lock.json ./
COPY --from=build /workspace/agile-project-management-prototype/node_modules ./node_modules
COPY --from=build /workspace/agile-project-management-prototype/dist ./dist
COPY --from=build /workspace/agile-project-management-prototype/server ./server
COPY --from=build /workspace/agile-project-management-prototype/scripts ./scripts
COPY --from=build /workspace/packages/core-client /packages/core-client
COPY --from=build /workspace/agile-project-management-prototype/src/workspace.ts ./src/workspace.ts
COPY --from=build /workspace/agile-project-management-prototype/README.md ./
COPY LICENSE.md THIRD_PARTY_NOTICES.md ./

RUN mkdir -p /data && chown node:node /data

USER node
VOLUME ["/data"]
EXPOSE 4197

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 4197) + '/api/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "--import", "tsx", "server/index.ts"]
