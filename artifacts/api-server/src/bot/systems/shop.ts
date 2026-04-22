export interface ShopItem {
  name: string;
  emoji: string;
  description: string;
  price: number;
  type: "seed" | "tool" | "consumable";
  cropKey?: string;
}

export const SHOP_ITEMS = {
  semente_milho: { name: "Semente de Milho", emoji: "🌽", description: "Cresce em 10 minutos.", price: 50, type: "seed", cropKey: "milho" },
  semente_trigo: { name: "Semente de Trigo", emoji: "🌾", description: "Cresce em 20 minutos.", price: 120, type: "seed", cropKey: "trigo" },
  semente_tomate: { name: "Semente de Tomate", emoji: "🍅", description: "Cresce em 45 minutos.", price: 300, type: "seed", cropKey: "tomate" },
  semente_uva: { name: "Semente de Uva", emoji: "🍇", description: "Cresce em 2 horas.", price: 800, type: "seed", cropKey: "uva" },
  fertilizante: { name: "Fertilizante", emoji: "🧪", description: "Reduz o tempo de crescimento da próxima plantação em 30%.", price: 200, type: "consumable" },
  agua: { name: "Garrafa d'Água", emoji: "💧", description: "Recupera 20 de saúde.", price: 80, type: "consumable" },
  bandagem: { name: "Bandagem", emoji: "🩹", description: "Recupera 50 de saúde.", price: 250, type: "consumable" },
  cafe: { name: "Café", emoji: "☕", description: "Reduz o cooldown de /trabalhar pela metade na próxima vez.", price: 150, type: "consumable" },
} as const satisfies Record<string, ShopItem>;

export type ShopItemKey = keyof typeof SHOP_ITEMS;

export const CROPS: Record<string, { name: string; emoji: string; growMinutes: number; sellMin: number; sellMax: number }> = {
  milho: { name: "Milho", emoji: "🌽", growMinutes: 10, sellMin: 100, sellMax: 180 },
  trigo: { name: "Trigo", emoji: "🌾", growMinutes: 20, sellMin: 240, sellMax: 380 },
  tomate: { name: "Tomate", emoji: "🍅", growMinutes: 45, sellMin: 600, sellMax: 950 },
  uva: { name: "Uva", emoji: "🍇", growMinutes: 120, sellMin: 1700, sellMax: 2600 },
};
