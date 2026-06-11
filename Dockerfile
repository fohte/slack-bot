# syntax=docker/dockerfile:1

# Base image with corepack-enabled pnpm
FROM node:24.16.0-bookworm-slim AS base
WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
COPY package.json ./
RUN corepack enable && corepack prepare --activate
COPY pnpm-workspace.yaml ./

# Install all dependencies (including dev), typecheck, and build dist/
FROM base AS builder
COPY pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN pnpm exec tsc --noEmit && pnpm run build

# Production deps only
FROM base AS prod-deps
COPY pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod

# Final runtime image
FROM node:24.16.0-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080

# Run as a non-root user provided by the upstream image
USER node

COPY --chown=node:node --from=prod-deps /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/dist ./dist
COPY --chown=node:node package.json ./

EXPOSE 8080

# Hit the liveness endpoint to verify the bot is responsive
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/health/live').then(r => { if (r.status !== 200) process.exit(1) }).catch(() => process.exit(1))"

CMD ["node", "dist/main.js"]

LABEL org.opencontainers.image.source=https://github.com/fohte/slack-bot
