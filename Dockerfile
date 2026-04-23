FROM node:20-slim AS base

RUN apt-get update -y && apt-get install -y --no-install-recommends \
    openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@9.15.0

WORKDIR /app

FROM base AS build

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY tsconfig.base.json tsconfig.json ./
COPY lib ./lib
COPY artifacts ./artifacts
COPY scripts ./scripts
COPY index.mjs ./

RUN pnpm install --no-frozen-lockfile
RUN pnpm run build

FROM base AS runtime

ENV NODE_ENV=production

COPY --from=build /app /app

CMD ["sh", "-c", "pnpm run db:push && node index.mjs"]
