# The collab post office in a container (see post-office/DEPLOY.md).
# Build from the repo root:  docker build -f post-office/Dockerfile -t collab-post-office .
# Only core + post-office are built; the ui and the other workspaces are not.

FROM node:20-slim AS build
# python3/make/g++: better-sqlite3 falls back to compiling if its prebuilt
# binary can't be downloaded. unzip: the cr-sqlite fetch unpacks with it.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ unzip ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Every workspace's package.json, so npm ci can check the lockfile; only the
# office's two are installed.
COPY package.json package-lock.json tsconfig.base.json addon-manifest.json ./
COPY core/package.json core/
COPY post-office/package.json post-office/
COPY courier/package.json courier/
COPY mcp/package.json mcp/
COPY server/package.json server/
COPY ui/package.json ui/
COPY gemini-mcp/package.json gemini-mcp/
COPY cli/package.json cli/
# COLLAB-192: ui lists a Windows-only rolldown binding that can stop `npm ci`
# on Linux (EBADPLATFORM). ui is not installed here; if npm still refuses,
# --force gets past that check.
RUN npm ci -w @collab-mcp/core -w @collab-mcp/post-office --include-workspace-root=false --no-audit --no-fund \
 || npm ci -w @collab-mcp/core -w @collab-mcp/post-office --include-workspace-root=false --no-audit --no-fund --force
COPY core/ core/
COPY post-office/ post-office/
COPY mcp/migrations/ mcp/migrations/
COPY scripts/fetch-crsqlite.mjs scripts/
# The office loads cr-sqlite on every connection: fetch the add-on for THIS
# build's OS/CPU (linux-x64 or linux-arm64), checked against addon-manifest.json.
RUN npm -w @collab-mcp/core run build \
 && npm -w @collab-mcp/post-office run build \
 && node scripts/fetch-crsqlite.mjs \
 && sed -i 's/\r$//' post-office/docker-entrypoint.sh

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production COLLAB_OFFICE_DATA=/data
# addon-manifest.json marks the install root; core finds vendor/crsqlite from it.
COPY --from=build /app/package.json /app/addon-manifest.json ./
COPY --from=build /app/vendor ./vendor
# serve brings store.db to the newest migration; core reads them from mcp/migrations.
COPY --from=build /app/mcp/migrations ./mcp/migrations
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/core/package.json ./core/
COPY --from=build /app/core/dist ./core/dist
COPY --from=build /app/post-office/package.json /app/post-office/docker-entrypoint.sh ./post-office/
COPY --from=build /app/post-office/dist ./post-office/dist
# The lockfile nests better-sqlite3 11 inside each workspace (the root has 12).
COPY --from=build /app/core/node_modules ./core/node_modules
COPY --from=build /app/post-office/node_modules ./post-office/node_modules
# /data must be a volume (docker run -v, or the host's volume setting). No
# VOLUME line on purpose: some hosts (Railway) refuse Dockerfiles that have one.
EXPOSE 7443
# Runs as root: hosted volumes are usually root-owned. Membership commands:
#   docker exec <container> node /app/post-office/dist/bin.js add-member "<name>"
ENTRYPOINT ["sh", "/app/post-office/docker-entrypoint.sh"]
