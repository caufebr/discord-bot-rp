FROM node:20-slim

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV CI=true
ENV NODE_ENV=production

RUN apt-get update -y && apt-get install -y --no-install-recommends \
    openssl ca-certificates python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@9.15.0

WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY tsconfig.base.json tsconfig.json ./
COPY lib ./lib
COPY artifacts/api-server ./artifacts/api-server
COPY scripts ./scripts
COPY index.mjs ./

RUN NODE_ENV=development pnpm install --no-frozen-lockfile --ignore-scripts

RUN pnpm run build

CMD ["sh", "-c", "(pnpm run db:push || echo '[warn] db:push falhou, continuando...') && pnpm --filter @workspace/api-server run start"]
