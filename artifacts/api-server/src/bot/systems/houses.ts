export interface HouseType {
  key: string;
  name: string;
  emoji: string;
  basePrice: number;
  passiveIncome: number;
}

// Escala progressiva: cada tier custa ~3-4x mais que o anterior e rende ~3x mais.
// ROI cresce gradualmente (~80h → 200h), incentivando upgrade pra status/renda absoluta.
export const HOUSE_TYPES: Record<string, HouseType> = {
  barraco:  { key: "barraco",  name: "Barraco",         emoji: "🛖",  basePrice:    8000, passiveIncome:    100 },
  kitnet:   { key: "kitnet",   name: "Kitnet",          emoji: "🛏️",  basePrice:   30000, passiveIncome:    350 },
  casa:     { key: "casa",     name: "Casa",            emoji: "🏠",  basePrice:  120000, passiveIncome:   1000 },
  apto:     { key: "apto",     name: "Apartamento",     emoji: "🏢",  basePrice:  400000, passiveIncome:   3000 },
  comercio: { key: "comercio", name: "Ponto Comercial", emoji: "🏪",  basePrice: 1000000, passiveIncome:   6500 },
  mansao:   { key: "mansao",   name: "Mansão",          emoji: "🏛️",  basePrice: 5000000, passiveIncome:  25000 },
};

export interface Upgrade {
  key: string;
  name: string;
  emoji: string;
  price: number;
  bonusIncome: number;
  description: string;
}

// Upgrades reescalonados pra ficarem proporcionais aos novos imóveis maiores.
export const HOUSE_UPGRADES: Record<string, Upgrade> = {
  internet:  { key: "internet",  name: "Internet Fibra",       emoji: "📡",  price:   8000, bonusIncome: 150, description: "+R$150/h" },
  seguranca: { key: "seguranca", name: "Sistema de Segurança", emoji: "🔒",  price:  25000, bonusIncome: 250, description: "Reduz roubo e +R$250/h" },
  decoracao: { key: "decoracao", name: "Decoração de Luxo",    emoji: "🛋️",  price:  50000, bonusIncome: 500, description: "+R$500/h e reputação" },
  garagem:   { key: "garagem",   name: "Garagem",              emoji: "🚪",  price:  80000, bonusIncome:   0, description: "Protege carros (sem desvalorização extra)" },
};
