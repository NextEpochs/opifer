# Opifer in container: opzione di distribuzione per server e cloud.
# L'installazione locale non richiede Docker (vedi README).
#
#   docker build -t opifer .
#   docker run -p 4700:4700 -v opifer-data:/data opifer

FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json tsconfig.json vitest.config.ts ./
COPY packages ./packages
COPY plugins ./plugins
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile
RUN pnpm build
# Toglie le dipendenze di sviluppo mantenendo i dist compilati.
RUN pnpm prune --prod

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    OPIFER_HOME=/data \
    OPIFER_HOST=0.0.0.0 \
    OPIFER_PORT=4700
# Postgres non gira come root: l'immagine usa l'utente "node" già presente.
RUN mkdir -p /data && chown node:node /data
WORKDIR /app
COPY --from=build --chown=node:node /app /app
USER node
VOLUME ["/data"]
EXPOSE 4700
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.OPIFER_PORT+'/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# init è idempotente: alla prima partenza crea database e azienda, poi solo aggiorna le migrazioni.
CMD ["sh", "-c", "node packages/cli/dist/main.js init --host \"$OPIFER_HOST\" --port \"$OPIFER_PORT\" --company \"${OPIFER_COMPANY:-La mia azienda}\" --no-color && exec node packages/cli/dist/main.js up --no-color"]
