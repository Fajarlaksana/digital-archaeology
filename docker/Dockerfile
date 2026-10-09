# syntax=docker/dockerfile:1.7
# Production images (Phase 14, ADR-028). One build, three targets:
#   backend — API + scan/maintenance workers      (docker build --target backend)
#   signer  — Key Vault service (loopback only)    (docker build --target signer)
#   web     — Caddy serving the built frontend + reverse proxy to the API
# Workspace packages run from TypeScript source (no build step, see CLAUDE.md), with tsx.

ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable && corepack prepare pnpm@12.8.1 --activate
WORKDIR /app

# ── Dependencies (cached until a manifest or a Prisma schema changes) ──
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY backend/package.json backend/prisma.config.ts backend/
COPY backend/prisma backend/prisma
COPY signer/package.json signer/prisma.config.ts signer/
COPY signer/prisma signer/prisma
COPY frontend/package.json frontend/
COPY shared/package.json shared/
# postinstall runs `prisma generate` for backend and signer.
RUN pnpm install --frozen-lockfile

FROM deps AS source
COPY . .

# ── Frontend build → static files ──
FROM source AS web-build
RUN pnpm --filter frontend build

FROM caddy:2-alpine AS web
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=web-build /app/frontend/dist /srv

# ── Backend ──
FROM source AS backend
ENV NODE_ENV=production
WORKDIR /app/backend
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "src/server.ts"]

# ── Signer (listens on 127.0.0.1 inside the backend's network namespace) ──
FROM source AS signer
ENV NODE_ENV=production
WORKDIR /app/signer
USER node
HEALTHCHECK --interval=15s --timeout=5s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "src/server.ts"]
