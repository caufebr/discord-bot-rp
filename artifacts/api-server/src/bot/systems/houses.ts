export interface HouseType {
  key: string;
  name: string;
  emoji: string;
  basePrice: number;
  passiveIncome: number;
}

export const HOUSE_TYPES: Record<string, HouseType> = {
  barraco: { key: "barraco", name: "Barraco", emoji: "🛖", basePrice: 5000, passiveIncome: 50 },
  casa: { key: "casa", name: "Casa", emoji: "🏠", basePrice: 50000, passiveIncome: 250 },
  apto: { key: "apto", name: "Apartamento", emoji: "🏢", basePrice: 180000, passiveIncome: 700 },
  mansao: { key: "mansao", name: "Mansão", emoji: "🏛️", basePrice: 1200000, passiveIncome: 3000 },
  comercio: { key: "comercio", name: "Ponto Comercial", emoji: "🏪", basePrice: 350000, passiveIncome: 1500 },
};

export interface Upgrade {
  key: string;
  name: string;
  emoji: string;
  price: number;
  bonusIncome: number;
  description: string;
}

export const HOUSE_UPGRADES: Record<string, Upgrade> = {
  internet: { key: "internet", name: "Internet Fibra", emoji: "📡", price: 3000, bonusIncome: 80, description: "+R$80/h" },
  seguranca: { key: "seguranca", name: "Sistema de Segurança", emoji: "🔒", price: 8000, bonusIncome: 50, description: "Reduz roubo e +R$50/h" },
  decoracao: { key: "decoracao", name: "Decoração de Luxo", emoji: "🛋️", price: 12000, bonusIncome: 120, description: "+R$120/h e reputação" },
  garagem: { key: "garagem", name: "Garagem", emoji: "🚪", price: 25000, bonusIncome: 0, description: "Protege carros (sem desvalorização extra)" },
};
