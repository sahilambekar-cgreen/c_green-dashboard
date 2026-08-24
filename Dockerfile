# ─────────────────────────────────────────────────────────────────────────────
# Stitch Debt Recovery Pulse — dashboard API + built frontend
#
# One process: Express serves /api/* and the built Vite bundle from dist/.
# See DEPLOY.md for the environment contract and the files that must be mounted.
# ─────────────────────────────────────────────────────────────────────────────

FROM node:22-alpine AS build-dependencies

WORKDIR /app

# Install dependencies first so this layer caches independently of source edits.
COPY package.json package-lock.json ./
RUN npm ci


FROM build-dependencies AS builder

COPY . .

# Validate both the Express API and React source before producing the Vite
# bundle. Vite transpiles the frontend but does not type-check server.ts.
# The final assertion prevents a successful-looking image with no entry page.
RUN ./node_modules/.bin/tsc --noEmit \
 && npm run build \
 && test -s dist/index.html


FROM node:22-alpine AS production-dependencies

WORKDIR /app

# Install only the exact runtime dependency graph from the lockfile. Keeping this
# separate from the build tree prevents Vite, TypeScript, and other build tools
# from leaking into the final image. tsx remains because it is a dependency.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force


FROM node:22-alpine AS runtime

# tini reaps zombies and forwards SIGTERM to tsx so `docker stop` is graceful.
# tzdata is required for TZ to take effect — the dashboard computes daily and
# monthly KPI boundaries in local time, so a UTC container shifts the day.
RUN apk add --no-cache tini tzdata

ENV NODE_ENV=production \
    PORT=3001 \
    TZ=Asia/Kolkata

WORKDIR /app

COPY --chown=node:node --from=production-dependencies /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/dist ./dist
COPY --chown=node:node --from=builder /app/package.json ./package.json
# server.ts runs through tsx and imports shared helpers from src/. Keep the
# TypeScript configuration with it so runtime transpilation matches local use.
# public/ is also required for the employee-photo fallback directory.
COPY --chown=node:node --from=builder /app/tsconfig.json ./tsconfig.json
COPY --chown=node:node --from=builder /app/server.ts ./server.ts
COPY --chown=node:node --from=builder /app/src ./src
COPY --chown=node:node --from=builder /app/public ./public

# Run unprivileged. The `node` user is uid/gid 1000 in this base image; any
# mounted token file must be writable by that uid (see DEPLOY.md).
USER node

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>r.json()).then(j=>process.exit(j.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/app/node_modules/.bin/tsx", "server.ts"]
