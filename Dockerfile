# syntax=docker/dockerfile:1
# CodeMasti API — optimized multi-stage production image.
# Node/npm versions must match devEngines in package.json (and .nvmrc). Both stages are pinned
# to the same Alpine release so the copied node binary links against the same musl/libstdc++.

ARG NODE_VERSION=24.22.1
ARG NPM_VERSION=12.2.1
ARG ALPINE_VERSION=3.24

# ---------- Stage 1: production dependencies ----------
FROM node:${NODE_VERSION}-alpine${ALPINE_VERSION} AS deps
ARG NPM_VERSION
WORKDIR /app

RUN npm install -g npm@${NPM_VERSION} --no-audit --no-fund

COPY package.json package-lock.json ./
# Prod deps only; no dependency needs install scripts. This stage is discarded, so the npm
# cache never reaches the final image.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 # Strip files that are never loaded at runtime (docs, type declarations, source maps).
 && find node_modules -type f \( -name "*.md" -o -name "*.markdown" -o -name "*.d.ts" -o -name "*.d.mts" \
      -o -name "*.d.cts" -o -name "*.map" -o -name "*.tsbuildinfo" \) -delete

# ---------- Stage 2: runtime ----------
# Plain Alpine + only the node binary: no npm, npx, corepack or yarn in the final image.
FROM alpine:${ALPINE_VERSION} AS runtime

ENV NODE_ENV=production \
    PORT=5001

# - libstdc++/libgcc: the node binary's only shared-library dependencies
# - tini: PID 1 that forwards signals and reaps zombies (the API spawns child processes
#   to run student JS/Python code)
# - dedicated unprivileged user: fixed UID/GID 10001, no password, no home, no login shell
RUN apk add --no-cache libstdc++ libgcc tini \
 && addgroup -S -g 10001 codemasti \
 && adduser -S -D -H -u 10001 -G codemasti -s /sbin/nologin codemasti

COPY --from=deps /usr/local/bin/node /usr/local/bin/node

WORKDIR /app

# Application code and dependencies are owned by root and read-only for the app user,
# so a compromised process cannot modify the code it runs. The app writes nothing to disk
# (all uploads go to Cloudinary), so no writable directory is needed.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

USER 10001:10001

EXPOSE 5001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||5001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
