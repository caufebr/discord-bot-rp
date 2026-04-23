# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

## Recent Changes (Muda Bot — Reactions, XP, Slots)

- **!work / !sal**: 1h e 8h cooldown. `!work` agora dá XP (15+) e gera níveis (200 XP/nv).
- **Profissões**: substituiu `!curso`/`!treinar` por escala social. `!profs` mostra tiers por nível (0/3/5/10/15). `!curso <prof>` escolhe sem custo se tiver nível. Cada `!work` aumenta `professionLevel` (prática); aos 10 vira certificado.
- **Slots de fazenda**: `!plantar` e `!animal` limitados por slots (3/2 default). `!comprarslot <planta|animal>` adiciona slot (custo dobra).
- **Reactions**: `!moral` (1️⃣2️⃣3️⃣), `!ginvitar`, `!casar` (taxa R$ 10k), `!racha` (✅/❌ + corrida animada).
- **Política**: `!apurar` deposita orçamento político no `inventory._orcamento_politico` (200k presidente, 80k prefeito). Novo `!comprarvoto @user <v>` gasta esse orçamento pra comprar votos (alvo confirma com ✅).
- **Animações com GIF**: helper `animate()` em messages.ts. URLs Tenor em `GIFS` map. Aplicado em work/plantar/colher/animal/racha/casamento/apuração.
- **Removido**: `!plantaranim` (substituído pela animação em `!plantar`).
- **Intents**: `GuildMessageReactions` + `Partials.Reaction`/`Partials.User` em `bot/index.ts`.
- **Sem mudanças de schema**: tudo armazenado em `players.inventory` (jsonb): `_xp`, `_slot_planta`, `_slot_animal`, `_orcamento_politico`.
