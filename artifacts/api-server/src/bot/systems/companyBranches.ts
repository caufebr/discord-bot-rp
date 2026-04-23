// Ramos empresariais com cadeia produtiva: matéria-prima → fábrica → produto → utilidade real
// Tudo é guardado em players.inventory (jsonb) — nenhuma migração de schema é necessária.
//
// Inventory keys usadas:
//   _materias: Record<matKey, number>        // estoque de matérias-primas do dono
//   _fabrica:  { nivel: number; ramo: string } // fábrica do dono (1 por empresa)
//   _estoque:  Record<prodKey, number>       // produtos manufaturados, prontos pra ir à loja
//   _produtos (já existe): produtos cadastrados na loja podem referenciar prodKey

export type Utility =
  | { type: "weapon"; weaponKey: string }
  | { type: "heal"; amount: number }
  | { type: "energy"; amount: number }
  | { type: "xp"; amount: number }
  | { type: "rep"; amount: number };

export interface MaterialDef {
  key: string;
  name: string;
  emoji: string;
  price: number; // preço unitário pra comprar matéria-prima
}

export interface ProductDef {
  key: string;
  name: string;
  emoji: string;
  factoryLevel: number;          // nível mínimo de fábrica
  materials: Record<string, number>; // por unidade
  laborCost: number;             // custo extra de produção por unidade (energia, mão-de-obra)
  suggestedPrice: number;        // sugestão de preço de venda
  utility: Utility;
  description: string;
}

export interface BranchDef {
  key: string;
  name: string;
  emoji: string;
  description: string;
  materials: MaterialDef[];
  products: ProductDef[];
}

export const FACTORY_BUILD_COST = 30000;       // construir fábrica nível 1
export const FACTORY_UPGRADE_BASE = 25000;     // custo do upgrade = base * (nivel + 1)
export const MAX_FACTORY_LEVEL = 5;

export const BRANCHES: Record<string, BranchDef> = {
  armas: {
    key: "armas",
    name: "Armas & Munição",
    emoji: "⚔️",
    description: "Produção de armamento. Produtos servem como armas equipáveis em duelos e crimes.",
    materials: [
      { key: "aco",     name: "Aço",      emoji: "🔩", price: 120 },
      { key: "polvora", name: "Pólvora",  emoji: "💣", price: 200 },
      { key: "madeira", name: "Madeira",  emoji: "🪵", price: 60  },
    ],
    products: [
      { key: "faca_artesanal",    name: "Faca Artesanal",    emoji: "🔪", factoryLevel: 1, materials: { aco: 2, madeira: 1 },           laborCost: 80,  suggestedPrice: 700,   utility: { type: "weapon", weaponKey: "faca" },     description: "Faca afiada (vira arma equipável)." },
      { key: "pistola_caseira",   name: "Pistola Caseira",   emoji: "🔫", factoryLevel: 2, materials: { aco: 5, polvora: 4 },            laborCost: 600, suggestedPrice: 6500,  utility: { type: "weapon", weaponKey: "pistola" },  description: "Pistola caseira (vira arma equipável)." },
      { key: "escopeta_industrial", name: "Escopeta Industrial", emoji: "💥", factoryLevel: 3, materials: { aco: 8, polvora: 8, madeira: 2 }, laborCost: 1500, suggestedPrice: 15000, utility: { type: "weapon", weaponKey: "escopeta" }, description: "Escopeta de calibre alto (arma equipável)." },
      { key: "fuzil_militar",     name: "Fuzil Militar",     emoji: "🪖", factoryLevel: 4, materials: { aco: 15, polvora: 15 },          laborCost: 4000, suggestedPrice: 40000, utility: { type: "weapon", weaponKey: "fuzil" },    description: "Fuzil pesado (arma equipável)." },
    ],
  },

  alimentos: {
    key: "alimentos",
    name: "Alimentos",
    emoji: "🍔",
    description: "Indústria alimentícia. Produtos curam saúde quando consumidos.",
    materials: [
      { key: "trigo",  name: "Trigo",  emoji: "🌾", price: 40  },
      { key: "carne",  name: "Carne",  emoji: "🥩", price: 150 },
      { key: "leite",  name: "Leite",  emoji: "🥛", price: 70  },
    ],
    products: [
      { key: "marmita",        name: "Marmita Caseira", emoji: "🍱", factoryLevel: 1, materials: { trigo: 2, carne: 1 },           laborCost: 50,  suggestedPrice: 500,  utility: { type: "heal", amount: 30 }, description: "Recupera 30 de saúde." },
      { key: "hamburguer",     name: "Hambúrguer",      emoji: "🍔", factoryLevel: 2, materials: { trigo: 3, carne: 2, leite: 1 }, laborCost: 150, suggestedPrice: 1200, utility: { type: "heal", amount: 60 }, description: "Recupera 60 de saúde." },
      { key: "banquete_gourmet", name: "Banquete Gourmet", emoji: "🍽️", factoryLevel: 3, materials: { trigo: 5, carne: 5, leite: 3 }, laborCost: 600, suggestedPrice: 4500, utility: { type: "heal", amount: 120 }, description: "Recupera 120 de saúde (cura completa)." },
    ],
  },

  bebidas: {
    key: "bebidas",
    name: "Bebidas",
    emoji: "🍻",
    description: "Engarrafamento. Produtos restauram energia.",
    materials: [
      { key: "agua",   name: "Água",   emoji: "💧", price: 20  },
      { key: "acucar", name: "Açúcar", emoji: "🍬", price: 35  },
      { key: "lupulo", name: "Lúpulo", emoji: "🌿", price: 90  },
    ],
    products: [
      { key: "refrigerante", name: "Refrigerante",    emoji: "🥤", factoryLevel: 1, materials: { agua: 2, acucar: 2 },         laborCost: 40,  suggestedPrice: 350,  utility: { type: "energy", amount: 25 }, description: "Recupera 25 de energia." },
      { key: "cerveja",      name: "Cerveja Artesanal", emoji: "🍺", factoryLevel: 2, materials: { agua: 3, lupulo: 2 },          laborCost: 130, suggestedPrice: 900,  utility: { type: "energy", amount: 50 }, description: "Recupera 50 de energia." },
      { key: "energetico_premium", name: "Energético Premium", emoji: "⚡", factoryLevel: 3, materials: { agua: 4, acucar: 4, lupulo: 1 }, laborCost: 350, suggestedPrice: 2200, utility: { type: "energy", amount: 100 }, description: "Recupera 100 de energia." },
    ],
  },

  medicamentos: {
    key: "medicamentos",
    name: "Medicamentos",
    emoji: "💊",
    description: "Laboratório farmacêutico. Produtos curam saúde.",
    materials: [
      { key: "erva",     name: "Erva Medicinal", emoji: "🌱", price: 80  },
      { key: "quimico",  name: "Composto Químico", emoji: "🧪", price: 220 },
      { key: "frasco",   name: "Frasco de Vidro", emoji: "🧴", price: 50  },
    ],
    products: [
      { key: "analgesico",  name: "Analgésico",          emoji: "💊", factoryLevel: 1, materials: { erva: 2, frasco: 1 },             laborCost: 120, suggestedPrice: 800,  utility: { type: "heal", amount: 40 },  description: "Recupera 40 de saúde." },
      { key: "antibiotico", name: "Antibiótico",         emoji: "💉", factoryLevel: 2, materials: { quimico: 2, frasco: 1, erva: 1 }, laborCost: 400, suggestedPrice: 2800, utility: { type: "heal", amount: 80 },  description: "Recupera 80 de saúde." },
      { key: "kit_primeiros_socorros", name: "Kit Primeiros Socorros", emoji: "🩺", factoryLevel: 3, materials: { quimico: 3, erva: 3, frasco: 2 }, laborCost: 900, suggestedPrice: 6000, utility: { type: "heal", amount: 150 }, description: "Recupera 150 de saúde (cura total)." },
    ],
  },

  tecnologia: {
    key: "tecnologia",
    name: "Tecnologia",
    emoji: "💻",
    description: "Fabricação de eletrônicos. Produtos dão XP ao usuário.",
    materials: [
      { key: "chip",     name: "Microchip", emoji: "🧩", price: 350 },
      { key: "plastico", name: "Plástico",  emoji: "♻️", price: 60  },
      { key: "bateria",  name: "Bateria",   emoji: "🔋", price: 180 },
    ],
    products: [
      { key: "smartphone",    name: "Smartphone",    emoji: "📱", factoryLevel: 2, materials: { chip: 2, plastico: 3, bateria: 1 }, laborCost: 700,  suggestedPrice: 4500,  utility: { type: "xp", amount: 80 },  description: "Concede 80 de XP ao usuário." },
      { key: "notebook",      name: "Notebook",      emoji: "💻", factoryLevel: 3, materials: { chip: 4, plastico: 4, bateria: 2 }, laborCost: 2000, suggestedPrice: 12000, utility: { type: "xp", amount: 200 }, description: "Concede 200 de XP ao usuário." },
      { key: "console_jogos", name: "Console de Jogos", emoji: "🎮", factoryLevel: 4, materials: { chip: 6, plastico: 5, bateria: 3 }, laborCost: 4500, suggestedPrice: 25000, utility: { type: "xp", amount: 450 }, description: "Concede 450 de XP (sobe de nível)." },
    ],
  },

  moda: {
    key: "moda",
    name: "Moda & Vestuário",
    emoji: "👗",
    description: "Confecção de roupas. Produtos elevam reputação.",
    materials: [
      { key: "tecido",   name: "Tecido",   emoji: "🧵", price: 70  },
      { key: "couro",    name: "Couro",    emoji: "🟫", price: 220 },
      { key: "linha",    name: "Linha",    emoji: "🪡", price: 25  },
    ],
    products: [
      { key: "camisa_basica", name: "Camisa Básica", emoji: "👕", factoryLevel: 1, materials: { tecido: 2, linha: 1 },         laborCost: 60,  suggestedPrice: 600,   utility: { type: "rep", amount: 5 },  description: "Aumenta sua reputação em 5." },
      { key: "vestido_casual", name: "Vestido Casual", emoji: "👗", factoryLevel: 2, materials: { tecido: 4, linha: 2 },         laborCost: 250, suggestedPrice: 2200,  utility: { type: "rep", amount: 12 }, description: "Aumenta sua reputação em 12." },
      { key: "terno_grife",   name: "Terno de Grife", emoji: "🤵", factoryLevel: 3, materials: { tecido: 5, couro: 2, linha: 3 }, laborCost: 800, suggestedPrice: 8000,  utility: { type: "rep", amount: 30 }, description: "Aumenta sua reputação em 30." },
    ],
  },
};

export const BRANCH_KEYS = Object.keys(BRANCHES);

export function getBranch(key: string): BranchDef | null {
  return BRANCHES[key.toLowerCase()] ?? null;
}

export function findProduct(key: string): { branch: BranchDef; product: ProductDef } | null {
  for (const b of Object.values(BRANCHES)) {
    const p = b.products.find(x => x.key === key);
    if (p) return { branch: b, product: p };
  }
  return null;
}

export function findMaterial(key: string): { branch: BranchDef; material: MaterialDef } | null {
  for (const b of Object.values(BRANCHES)) {
    const m = b.materials.find(x => x.key === key);
    if (m) return { branch: b, material: m };
  }
  return null;
}
