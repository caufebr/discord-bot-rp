export interface AnimalSpecies {
  key: string;
  name: string;
  emoji: string;
  buyPrice: number;
  growHours: number;
  meatYield: number;
  feedCost: number;
}

export const ANIMAL_SPECIES: Record<string, AnimalSpecies> = {
  galinha: { key: "galinha", name: "Galinha", emoji: "🐔", buyPrice: 200, growHours: 6, meatYield: 350, feedCost: 30 },
  porco: { key: "porco", name: "Porco", emoji: "🐖", buyPrice: 1200, growHours: 24, meatYield: 2500, feedCost: 100 },
  vaca: { key: "vaca", name: "Vaca", emoji: "🐄", buyPrice: 5000, growHours: 72, meatYield: 12000, feedCost: 250 },
  ovelha: { key: "ovelha", name: "Ovelha", emoji: "🐑", buyPrice: 800, growHours: 36, meatYield: 2000, feedCost: 80 },
};

export const HUNGER_DECAY_PER_HOUR = 4;
