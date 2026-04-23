FROM node:20-slim AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV CI=true

RUN apt-get update -y && apt-get install -y --no-install-recommends \
    openssl ca-certificates python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@9.15.0

WORKDIR /app

FROM base AS build

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY tsconfig.base.json tsconfig.json ./
COPY lib ./lib
COPY artifacts/api-server ./artifacts/api-server
COPY scripts ./scripts
COPY index.mjs ./

RUN pnpm install --no-frozen-lockfile --ignore-scripts

RUN pnpm run build

FROM base AS runtime

ENV NODE_ENV=production

WORKDIR /app

COPY --from=build /app /app

CMD ["sh", "-c", "pnpm run db:push && node index.mjs"]
