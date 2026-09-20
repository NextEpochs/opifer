# Opifer in a container: deployment option for servers and cloud.
# The local installation does not require Docker (see README).
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
# Keeps only the production dependencies (the compiled dist folders are untouched). `pnpm prune --prod` is not
# reliable in a workspace: it dropped commander from the CLI. CI=true: pnpm refuses to remove node_modules without a TTY.
RUN CI=true pnpm install --prod --frozen-lockfile --offline

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    OPIFER_HOME=/data \
    OPIFER_HOST=0.0.0.0 \
    OPIFER_PORT=4700
# Postgres does not run as root: the image uses the existing "node" user.
RUN mkdir -p /data && chown node:node /data
WORKDIR /app
COPY --from=build --chown=node:node /app /app
USER node
VOLUME ["/data"]
EXPOSE 4700
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.OPIFER_PORT+'/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# init is idempotent: on first start it creates database and company, afterwards it only updates the migrations.
CMD ["sh", "-c", "node packages/cli/dist/main.js init --host \"$OPIFER_HOST\" --port \"$OPIFER_PORT\" --company \"${OPIFER_COMPANY:-My company}\" --no-color && exec node packages/cli/dist/main.js up --no-color"]
