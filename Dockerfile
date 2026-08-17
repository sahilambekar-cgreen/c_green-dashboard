# ─────────────────────────────────────────────────────────────────────────────
# Stitch Debt Recovery Pulse — dashboard API + built frontend
#
# One process: Express serves /api/* and the built Vite bundle from dist/.
# See DEPLOY.md for the environment contract and the files that must be mounted.
# ─────────────────────────────────────────────────────────────────────────────

FROM node:22-alpine AS builder

WORKDIR /app

# Install dependencies first so this layer caches independently of source edits.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Vite build → dist/ (also copies public/ into dist/)
RUN npm run build

# Drop devDependencies. tsx is a runtime dependency (the server runs TypeScript
# directly), so it survives this prune — see package.json.
RUN npm prune --omit=dev


FROM node:22-alpine AS runtime

# tini reaps zombies and forwards SIGTERM to tsx so `docker stop` is graceful.
# tzdata is required for TZ to take effect — the dashboard computes daily and
# monthly KPI boundaries in local time, so a UTC container shifts the day.
RUN apk add --no-cache tini tzdata

ENV NODE_ENV=production \
    PORT=3001 \
    TZ=Asia/Kolkata

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json
# server.ts imports ./src/privacy, and employeePhotoDir resolves to
# <app>/public/employee-photos — so both directories are required at runtime.
COPY --from=builder /app/server.ts ./server.ts
COPY --from=builder /app/src ./src
COPY --from=builder /app/public ./public

# Run unprivileged. The `node` user is uid/gid 1000 in this base image; any
# mounted token file must be writable by that uid (see DEPLOY.md).
RUN chown -R node:node /app
USER node

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>r.json()).then(j=>process.exit(j.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/app/node_modules/.bin/tsx", "server.ts"]
