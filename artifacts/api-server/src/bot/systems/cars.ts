export interface CarModel {
  key: string;
  name: string;
  category: "popular" | "sedan" | "suv" | "esportivo" | "luxo";
  price: number;
  emoji: string;
}

export const CAR_MODELS: Record<string, CarModel> = {
  uno: { key: "uno", name: "Fiat Uno", category: "popular", price: 18000, emoji: "🚗" },
  gol: { key: "gol", name: "VW Gol", category: "popular", price: 25000, emoji: "🚗" },
  onix: { key: "onix", name: "Chevrolet Onix", category: "popular", price: 65000, emoji: "🚙" },
  hb20: { key: "hb20", name: "Hyundai HB20", category: "popular", price: 70000, emoji: "🚙" },
  corolla: { key: "corolla", name: "Toyota Corolla", category: "sedan", price: 130000, emoji: "🚘" },
  civic: { key: "civic", name: "Honda Civic", category: "sedan", price: 150000, emoji: "🚘" },
  hilux: { key: "hilux", name: "Toyota Hilux", category: "suv", price: 280000, emoji: "🛻" },
  rangerover: { key: "rangerover", name: "Range Rover", category: "suv", price: 650000, emoji: "🚙" },
  mustang: { key: "mustang", name: "Ford Mustang", category: "esportivo", price: 450000, emoji: "🏎️" },
  porsche: { key: "porsche", name: "Porsche 911", category: "esportivo", price: 950000, emoji: "🏎️" },
  ferrari: { key: "ferrari", name: "Ferrari F8", category: "luxo", price: 3500000, emoji: "🏎️" },
  lambo: { key: "lambo", name: "Lamborghini Huracán", category: "luxo", price: 4200000, emoji: "🏎️" },
};

export const MAINTENANCE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
export const REPAIR_COST_PER_POINT = 80;

export const CATEGORY_TOP_SPEED: Record<string, number> = {
  popular: 150,
  sedan: 200,
  suv: 190,
  esportivo: 290,
  luxo: 340,
};

export function topSpeedFor(category: string, condition: number): number {
  const base = CATEGORY_TOP_SPEED[category] ?? 140;
  const condFactor = Math.max(0.5, condition / 100);
  return Math.floor(base * condFactor);
}

export function depreciate(currentValue: number, basePrice: number, condition: number): number {
  const condFactor = Math.max(0.2, condition / 100);
  return Math.floor(basePrice * condFactor * 0.85);
}

export function repairCost(condition: number): number {
  const missing = 100 - condition;
  return missing * REPAIR_COST_PER_POINT;
}
