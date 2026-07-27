# syntax=docker/dockerfile:1

<<<<<<< before updating
# Base image with corepack-enabled pnpm
FROM node:24.16.0-bookworm-slim AS base
||||||| last update
=======
# Keep the Node.js version in sync with .mise.toml.
FROM node:24.18.0-slim AS base
>>>>>>> after updating
WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
<<<<<<< before updating
COPY package.json ./
RUN corepack enable && corepack prepare --activate
COPY pnpm-workspace.yaml ./
||||||| last update
=======
# Node.js 25+ no longer bundles Corepack: https://github.com/nodejs/corepack
RUN npm install -g corepack@0.35.0 && npm cache clean --force && corepack enable
>>>>>>> after updating

<<<<<<< before updating
# Install all dependencies (including dev), typecheck, and build dist/
FROM base AS builder
COPY pnpm-lock.yaml ./
||||||| last update
=======
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
>>>>>>> after updating
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile
<<<<<<< before updating
||||||| last update
=======

# Local development stage. Bind-mount the repo over /app (e.g. from
# docker compose, with an anonymous volume on /app/node_modules to keep
# this image's install instead of the host's) for live-reload without
# rebuilding the image.
FROM base AS dev
COPY --from=deps /app/node_modules ./node_modules
CMD ["pnpm", "dev"]

FROM deps AS builder
>>>>>>> after updating
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
<<<<<<< before updating
RUN pnpm exec tsc --noEmit && pnpm run build
||||||| last update
=======
RUN pnpm run build
>>>>>>> after updating

<<<<<<< before updating
# Production deps only
FROM base AS prod-deps
COPY pnpm-lock.yaml ./
||||||| last update
=======
# Built fresh from `base`, not `builder`, so the runtime image doesn't inherit
# dev dependencies or source files left over from the build stage.
FROM base AS runtime
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
>>>>>>> after updating
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod
<<<<<<< before updating

# Final runtime image
FROM node:24.16.0-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080

# Run as a non-root user provided by the upstream image
||||||| last update
=======
COPY --from=builder /app/dist ./dist
COPY otel-register.mjs ./
>>>>>>> after updating
USER node
<<<<<<< before updating

COPY --chown=node:node --from=prod-deps /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/dist ./dist
COPY --chown=node:node drizzle ./drizzle
COPY --chown=node:node package.json otel-register.mjs ./

||||||| last update
=======
>>>>>>> after updating
EXPOSE 8080
<<<<<<< before updating

# Hit the liveness endpoint to verify the bot is responsive
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/health/live').then(r => { if (r.status !== 200) process.exit(1) }).catch(() => process.exit(1))"

CMD ["node", "--import", "./otel-register.mjs", "dist/main.js"]

LABEL org.opencontainers.image.source=https://github.com/fohte/slack-bot
||||||| last update
=======
CMD ["node", "--import", "./otel-register.mjs", "dist/index.js"]
>>>>>>> after updating
