# syntax=docker/dockerfile:1

# Base image with corepack-enabled pnpm
FROM node:24-bookworm-slim AS base
WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare --activate

# Install all dependencies (including dev) and run typecheck
FROM base AS builder
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm exec tsc --noEmit

# Production deps only
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod

# Final runtime image
FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080

# Run as a non-root user provided by the upstream image
USER node

COPY --chown=node:node --from=prod-deps /app/node_modules ./node_modules
COPY --chown=node:node package.json tsconfig.json ./
COPY --chown=node:node src ./src

EXPOSE 8080

# Hit the liveness endpoint to verify the bot is responsive
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/health/live').then(r => { if (r.status !== 200) process.exit(1) }).catch(() => process.exit(1))"

CMD ["node", "--import", "tsx", "src/main.ts"]

LABEL org.opencontainers.image.source=https://github.com/fohte/slack-bot
