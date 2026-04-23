// Ecossistema do Salafrário — tudo via players.inventory (jsonb), sem migrations.
//
// Convenções de chaves no inventory (com prefixo "_" para não colidir com itens reais):
//   _drogas            : Record<string, number>          // estoque de drogas (in natura e processadas)
//   _lab_drogas        : { nivel: number; built: number; lastRaid?: number } | null
//   _droga_plantios    : Array<{ id: number; droga: string; plantedAt: number }>
//   _vicio             : Record<string, number>          // adicção 0..100 por droga
//   _dirt              : Array<DirtItem>                 // sujeira coletada por VOCÊ sobre OUTROS
//   _dirt_against_me   : Array<DirtItem>                 // sujeira que outros têm sobre VOCÊ
//   _sequestrado_por   : { kidnapperId: string; ransom: number; until: number } | null
//   _sequestros        : Array<{ victimId: string; ransom: number; until: number }>
//   _subornos          : Array<{ ts: number; alvo: string; valor: number }>
//   _missoes           : { day: string; list: MissionDef[]; progress: Record<string, number>; claimed: string[] }
//   _inf_counters      : Record<string, number>          // contadores p/ cálculo de infâmia
//   _mercado_ofertas   : Array<MarketOffer>              // ofertas que você publicou
//   _piramide_dono     : { id: string; nome: string; entrada: number; criadoEm: number; pote: number; participantes: number; ativa: boolean } | null
//   _piramide_invest   : Array<{ donoId: string; piramideId: string; valor: number; ts: number }>
//   _last_phishing     : number
//   _last_estelionato  : number
//   _last_fofoca       : number
//   _last_traf         : number
//   _last_consumo      : number
//   _imune_fiscal_ate  : number  (timestamp até quando fiscal foi subornado)

// ============ DROGAS ============

export interface DrogaDef {
  key: string;                 // chave da semente/planta
  name: string;
  emoji: string;
  growMinutes: number;         // tempo de plantio
  processedKey: string;        // chave do produto processado
  processedName: string;
  yieldPerRaw: number;         // unidades processadas por planta
  laborCost: number;           // custo p/ processar 1 planta no lab
  labLevel: number;            // nível mínimo do laboratório
  basePrice: number;           // preço sugerido por unidade processada
  addiction: number;           // pontos de vício por consumo
  effect: { type: "energy" | "health" | "xp"; amount: number };
  raidChance: number;          // chance da plantação ser invadida ao checar
}

export const DROGAS: Record<string, DrogaDef> = {
  maconha: {
    key: "maconha", name: "Pé de Maconha", emoji: "🌿",
    growMinutes: 30, processedKey: "maconha_pronta", processedName: "Baseado",
    yieldPerRaw: 4, laborCost: 100, labLevel: 1,
    basePrice: 350, addiction: 8,
    effect: { type: "energy", amount: 25 }, raidChance: 0.06,
  },
  coca: {
    key: "coca", name: "Folha de Coca", emoji: "🍃",
    growMinutes: 90, processedKey: "po", processedName: "Pó",
    yieldPerRaw: 3, laborCost: 600, labLevel: 2,
    basePrice: 1800, addiction: 22,
    effect: { type: "energy", amount: 70 }, raidChance: 0.12,
  },
  opio: {
    key: "opio", name: "Papoula (Ópio)", emoji: "🌺",
    growMinutes: 180, processedKey: "her", processedName: "Heroína",
    yieldPerRaw: 2, laborCost: 1800, labLevel: 3,
    basePrice: 6000, addiction: 40,
    effect: { type: "health", amount: 80 }, raidChance: 0.20,
  },
  metan: {
    key: "metan", name: "Precursores Sintéticos", emoji: "⚗️",
    growMinutes: 240, processedKey: "meth", processedName: "Cristal",
    yieldPerRaw: 5, laborCost: 3500, labLevel: 4,
    basePrice: 12000, addiction: 55,
    effect: { type: "xp", amount: 250 }, raidChance: 0.28,
  },
};

export const LAB_BUILD_COST = 25000;
export const LAB_UPGRADE_BASE = 20000;
export const MAX_LAB_LEVEL = 5;

// ============ GOLPES ============

export interface GolpeDef {
  key: string;
  name: string;
  emoji: string;
  cooldownMs: number;
  successBase: number;          // 0..1
  rewardMin: number;
  rewardMax: number;
  wantedOnFail: number;
  description: string;
}

export const GOLPES: Record<string, GolpeDef> = {
  phishing: {
    key: "phishing", name: "Phishing", emoji: "🎣",
    cooldownMs: 30 * 60 * 1000, successBase: 0.45,
    rewardMin: 800, rewardMax: 4000, wantedOnFail: 1,
    description: "Manda link falso pra um alvo. Se cair, leva entre R$ 800 e R$ 4.000.",
  },
  estelionato: {
    key: "estelionato", name: "Estelionato", emoji: "📑",
    cooldownMs: 60 * 60 * 1000, successBase: 0.55,
    rewardMin: 3000, rewardMax: 12000, wantedOnFail: 2,
    description: "Fraude documental contra o sistema. Recompensa maior, risco maior.",
  },
  falsoproduto: {
    key: "falsoproduto", name: "Falso Produto", emoji: "📦",
    cooldownMs: 45 * 60 * 1000, successBase: 0.50,
    rewardMin: 1500, rewardMax: 7000, wantedOnFail: 1,
    description: "Vende produto que nunca chega ao alvo.",
  },
};

export const PIRAMIDE_MIN_ENTRADA = 500;
export const PIRAMIDE_TAXA_DONO = 0.30;     // dono fica com 30% de cada entrada
export const PIRAMIDE_DURACAO_MS = 6 * 60 * 60 * 1000; // 6h até colapsar
export const PIRAMIDE_PAGA_DEPOIS_DE = 5;   // primeiros N investidores recebem 1.8x

// ============ SUBORNO ============

export interface SubornoAlvo {
  key: string;
  name: string;
  emoji: string;
  custoMin: number;
  description: string;
  apply: "wanted" | "jail" | "fiscal" | "prefeito";
  scandalChance: number;
}

export const SUBORNO_ALVOS: Record<string, SubornoAlvo> = {
  policia: {
    key: "policia", name: "Policial", emoji: "👮",
    custoMin: 1500, scandalChance: 0.10,
    description: "Cada R$ 1.500 reduz 1 ⭐ de procurado.",
    apply: "wanted",
  },
  juiz: {
    key: "juiz", name: "Juiz", emoji: "⚖️",
    custoMin: 5000, scandalChance: 0.18,
    description: "Cada R$ 5.000 reduz 10 minutos de cadeia.",
    apply: "jail",
  },
  fiscal: {
    key: "fiscal", name: "Fiscal da Receita", emoji: "🧾",
    custoMin: 8000, scandalChance: 0.12,
    description: "R$ 8.000 = 24h de imunidade a auditoria fiscal e sonegação fica zerada.",
    apply: "fiscal",
  },
  prefeito: {
    key: "prefeito", name: "Prefeito", emoji: "🏛️",
    custoMin: 15000, scandalChance: 0.25,
    description: "R$ 15.000 = +1 nível instantâneo na sua empresa.",
    apply: "prefeito",
  },
};

// ============ CHANTAGEM ============

export interface DirtItem {
  id: number;
  aboutId: string;
  aboutName: string;
  fact: string;
  collectedAt: number;
}

export const DIRT_FACTS: string[] = [
  "tem segunda família escondida em outra cidade",
  "deve dinheiro pra agiota pesado",
  "sonegou imposto nos últimos 6 meses",
  "comprou voto na última eleição",
  "vendeu produto vencido na própria loja",
  "está envolvido com tráfico de drogas",
  "subornou a polícia pra escapar",
  "traiu o cônjuge no carnaval",
  "armou racha com chip do carro",
  "lavou dinheiro de gangue rival",
  "faltou ao próprio casamento",
  "foi flagrado fugindo da cadeia",
  "mantém pirâmide financeira ativa",
  "deve aluguel há 3 meses",
  "usou ração de pet vencida",
];

export const FOFOCA_COST = 800;
export const FOFOCA_SUCCESS = 0.55;
export const FOFOCA_COOLDOWN_MS = 20 * 60 * 1000;
export const SIGILO_COST_PER_DIRT = 2500;

// ============ SEQUESTRO ============

export const SEQUESTRO_DURACAO_MS = 30 * 60 * 1000;     // 30 min de cativeiro
export const SEQUESTRO_RANSOM_MIN = 2000;
export const SEQUESTRO_RANSOM_MAX = 100000;
export const SEQUESTRO_TAXA_FUGA = 0.25;                // 25% de chance de fugir
export const SEQUESTRO_DANO_FUGA = 35;                  // dano se a fuga falhar

// ============ MERCADO P2P ============

export interface MarketOffer {
  id: number;
  sellerId: string;
  sellerName: string;
  itemKey: string;
  itemName: string;
  qtd: number;
  preco: number;
  criadoEm: number;
}

export const MERCADO_TAXA = 0.05;      // 5% taxa do anúncio
export const MERCADO_MAX_OFERTAS = 3;  // por jogador

// ============ MISSÕES DIÁRIAS ============

export type MissionAction =
  | "trabalhar" | "crime" | "traficar" | "phishing" | "sequestro"
  | "suborno" | "chantagear" | "vender_produto" | "fabricar"
  | "lavar" | "duelo_vencer" | "consumir_d";

export interface MissionDef {
  key: string;
  description: string;
  action: MissionAction;
  goal: number;
  reward: number;
}

export const MISSION_POOL: MissionDef[] = [
  { key: "m_trab",      description: "Trabalhe 3 vezes",                    action: "trabalhar",      goal: 3, reward: 1500 },
  { key: "m_crime",     description: "Cometa 2 crimes",                     action: "crime",          goal: 2, reward: 2500 },
  { key: "m_traf",      description: "Trafique drogas para 2 jogadores",    action: "traficar",       goal: 2, reward: 6000 },
  { key: "m_phish",     description: "Aplique 1 golpe de phishing",         action: "phishing",       goal: 1, reward: 4000 },
  { key: "m_sequestro", description: "Realize 1 sequestro",                 action: "sequestro",      goal: 1, reward: 8000 },
  { key: "m_suborno",   description: "Pague 1 suborno",                     action: "suborno",        goal: 1, reward: 3000 },
  { key: "m_chant",     description: "Chantageie 1 jogador com sucesso",    action: "chantagear",     goal: 1, reward: 5000 },
  { key: "m_venda",     description: "Venda 5 unidades de produto da loja", action: "vender_produto", goal: 5, reward: 4000 },
  { key: "m_fab",       description: "Fabrique 5 produtos na fábrica",      action: "fabricar",       goal: 5, reward: 3500 },
  { key: "m_lavar",     description: "Lave R$ 10.000 ou mais",              action: "lavar",          goal: 1, reward: 4500 },
  { key: "m_duelo",     description: "Vença 1 duelo",                       action: "duelo_vencer",   goal: 1, reward: 4000 },
  { key: "m_con",       description: "Consuma 1 droga",                     action: "consumir_d",     goal: 1, reward: 2000 },
];

export function pickDailyMissions(seed: string): MissionDef[] {
  // 4 missões por dia, escolhidas pseudo-aleatoriamente pela seed (data + discordId)
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) | 0;
  const pool = [...MISSION_POOL];
  const out: MissionDef[] = [];
  for (let i = 0; i < 4 && pool.length > 0; i++) {
    h = (h * 1103515245 + 12345) & 0x7fffffff;
    const idx = h % pool.length;
    out.push(pool[idx]!);
    pool.splice(idx, 1);
  }
  return out;
}

export function todayKey(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

// ============ INFÂMIA ============

export interface InfCounters {
  golpes?: number;
  subornos?: number;
  sequestros?: number;
  traficos?: number;
  chantagens?: number;
  pirámides?: number;
  fugas?: number;
  raids_sobreviveu?: number;
}

export function calcInfamia(c: InfCounters | undefined): number {
  if (!c) return 0;
  return (
    (c.golpes ?? 0) * 8 +
    (c.subornos ?? 0) * 5 +
    (c.sequestros ?? 0) * 25 +
    (c.traficos ?? 0) * 4 +
    (c.chantagens ?? 0) * 12 +
    (c.pirámides ?? 0) * 35 +
    (c.fugas ?? 0) * 15 +
    (c.raids_sobreviveu ?? 0) * 10
  );
}

export const INFAMIA_TITULOS: Array<{ min: number; titulo: string; emoji: string }> = [
  { min: 0,    titulo: "Cidadão de Bem",     emoji: "😇" },
  { min: 25,   titulo: "Malandro Inicial",   emoji: "🙃" },
  { min: 100,  titulo: "Fica de Olho",       emoji: "🕶️" },
  { min: 250,  titulo: "Salafrário",         emoji: "🦝" },
  { min: 500,  titulo: "Pilantra Profissa",  emoji: "🎩" },
  { min: 1000, titulo: "Cabeça de Esquema",  emoji: "👑" },
  { min: 2500, titulo: "Mafioso Lendário",   emoji: "💼" },
  { min: 6000, titulo: "Imperador do Crime", emoji: "🦂" },
];

export function infamiaTitulo(score: number): { titulo: string; emoji: string } {
  let cur = INFAMIA_TITULOS[0]!;
  for (const t of INFAMIA_TITULOS) if (score >= t.min) cur = t;
  return cur;
}

// ============ HELPERS p/ inventory ============

export function bumpInf(inv: any, key: keyof InfCounters, by = 1) {
  inv._inf_counters = inv._inf_counters ?? {};
  inv._inf_counters[key] = (inv._inf_counters[key] ?? 0) + by;
}

export function bumpMissionProgress(inv: any, action: MissionAction, by = 1) {
  const m = inv._missoes;
  if (!m || !Array.isArray(m.list)) return;
  for (const mis of m.list as MissionDef[]) {
    if (mis.action === action) {
      m.progress = m.progress ?? {};
      m.progress[mis.key] = (m.progress[mis.key] ?? 0) + by;
    }
  }
}
