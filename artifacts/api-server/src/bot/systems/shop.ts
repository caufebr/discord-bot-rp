export interface ShopItem {
  name: string;
  emoji: string;
  description: string;
  price: number;
  type: "seed" | "tool" | "consumable" | "weapon" | "petfood";
  cropKey?: string;
  damage?: number;
}

export const SHOP_ITEMS = {
  semente_milho: { name: "Semente de Milho", emoji: "🌽", description: "Cresce em 10 minutos.", price: 50, type: "seed", cropKey: "milho" },
  semente_trigo: { name: "Semente de Trigo", emoji: "🌾", description: "Cresce em 20 minutos.", price: 120, type: "seed", cropKey: "trigo" },
  semente_tomate: { name: "Semente de Tomate", emoji: "🍅", description: "Cresce em 45 minutos.", price: 300, type: "seed", cropKey: "tomate" },
  semente_uva: { name: "Semente de Uva", emoji: "🍇", description: "Cresce em 2 horas.", price: 800, type: "seed", cropKey: "uva" },
  fertilizante: { name: "Fertilizante", emoji: "🧪", description: "Reduz o tempo da próxima plantação em 40%.", price: 200, type: "consumable" },
  agua: { name: "Garrafa d'Água", emoji: "💧", description: "Recupera 20 de saúde.", price: 80, type: "consumable" },
  bandagem: { name: "Bandagem", emoji: "🩹", description: "Recupera 50 de saúde.", price: 250, type: "consumable" },
  cafe: { name: "Café", emoji: "☕", description: "Reduz cooldown de /trabalhar pela metade.", price: 150, type: "consumable" },
  energetico: { name: "Energético", emoji: "⚡", description: "Recupera 50 de energia.", price: 300, type: "consumable" },
  racao_pet: { name: "Ração de Pet", emoji: "🦴", description: "Alimenta seu pet (+50 fome).", price: 100, type: "petfood" },
} as const satisfies Record<string, ShopItem>;

export type ShopItemKey = keyof typeof SHOP_ITEMS;

export const CROPS: Record<string, { name: string; emoji: string; growMinutes: number; sellMin: number; sellMax: number }> = {
  milho: { name: "Milho", emoji: "🌽", growMinutes: 10, sellMin: 100, sellMax: 180 },
  trigo: { name: "Trigo", emoji: "🌾", growMinutes: 20, sellMin: 240, sellMax: 380 },
  tomate: { name: "Tomate", emoji: "🍅", growMinutes: 45, sellMin: 600, sellMax: 950 },
  uva: { name: "Uva", emoji: "🍇", growMinutes: 120, sellMin: 1700, sellMax: 2600 },
};

export interface Weapon {
  key: string;
  name: string;
  emoji: string;
  price: number;
  damage: number;
  description: string;
}

export const WEAPONS: Record<string, Weapon> = {
  faca: { key: "faca", name: "Faca", emoji: "🔪", price: 500, damage: 25, description: "Corte rápido e silencioso." },
  bastao: { key: "bastao", name: "Bastão de Beisebol", emoji: "🏏", price: 1200, damage: 35, description: "Pancada que derruba." },
  pistola: { key: "pistola", name: "Pistola .38", emoji: "🔫", price: 5000, damage: 60, description: "Arma de fogo padrão." },
  escopeta: { key: "escopeta", name: "Escopeta 12", emoji: "💥", price: 12000, damage: 85, description: "Estouro a curta distância." },
  fuzil: { key: "fuzil", name: "Fuzil AK", emoji: "🪖", price: 30000, damage: 100, description: "Arma de guerra. Letal." },
};

export const BR_STATES: Record<string, string[]> = {
  "AC": ["Rio Branco", "Cruzeiro do Sul"],
  "AL": ["Maceió", "Arapiraca"],
  "AP": ["Macapá", "Santana"],
  "AM": ["Manaus", "Parintins"],
  "BA": ["Salvador", "Feira de Santana", "Vitória da Conquista"],
  "CE": ["Fortaleza", "Caucaia", "Juazeiro do Norte"],
  "DF": ["Brasília", "Taguatinga"],
  "ES": ["Vitória", "Vila Velha", "Serra"],
  "GO": ["Goiânia", "Aparecida de Goiânia", "Anápolis"],
  "MA": ["São Luís", "Imperatriz"],
  "MT": ["Cuiabá", "Várzea Grande"],
  "MS": ["Campo Grande", "Dourados"],
  "MG": ["Belo Horizonte", "Uberlândia", "Contagem", "Juiz de Fora"],
  "PA": ["Belém", "Ananindeua", "Santarém"],
  "PB": ["João Pessoa", "Campina Grande"],
  "PR": ["Curitiba", "Londrina", "Maringá"],
  "PE": ["Recife", "Olinda", "Caruaru"],
  "PI": ["Teresina", "Parnaíba"],
  "RJ": ["Rio de Janeiro", "São Gonçalo", "Duque de Caxias", "Niterói"],
  "RN": ["Natal", "Mossoró"],
  "RS": ["Porto Alegre", "Caxias do Sul", "Pelotas"],
  "RO": ["Porto Velho", "Ji-Paraná"],
  "RR": ["Boa Vista"],
  "SC": ["Florianópolis", "Joinville", "Blumenau"],
  "SP": ["São Paulo", "Guarulhos", "Campinas", "Santos", "Ribeirão Preto"],
  "SE": ["Aracaju", "Nossa Senhora do Socorro"],
  "TO": ["Palmas", "Araguaína"],
};

export const POLITICAL_SIDES = ["Esquerda", "Centro", "Direita", "Apolítico"] as const;
export const GENDERS = ["Masculino", "Feminino", "Não-binário", "Prefiro não dizer"] as const;
export const PET_SPECIES = ["Cachorro", "Gato", "Papagaio", "Coelho", "Hamster"] as const;
