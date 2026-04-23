export interface BlackMarketItem {
  key: string;
  name: string;
  emoji: string;
  price: number;
  type: "weapon" | "consumable" | "doc";
  damage?: number;
  description: string;
}

export const BLACK_MARKET: Record<string, BlackMarketItem> = {
  uzi: { key: "uzi", name: "Submetralhadora UZI", emoji: "🔫", price: 22000, type: "weapon", damage: 80, description: "Rajada rápida. Sem registro." },
  granada: { key: "granada", name: "Granada", emoji: "💣", price: 8000, type: "weapon", damage: 120, description: "Uso único. Devastador." },
  colete: { key: "colete", name: "Colete Balístico", emoji: "🦺", price: 15000, type: "consumable", description: "+50 vida máxima por 24h." },
  rgfalso: { key: "rgfalso", name: "RG Falso", emoji: "🪪", price: 5000, type: "doc", description: "Limpa metade da ficha criminal." },
  passaporte: { key: "passaporte", name: "Passaporte Frio", emoji: "🛂", price: 25000, type: "doc", description: "Zera nível de procurado." },
  doping: { key: "doping", name: "Doping", emoji: "💊", price: 3000, type: "consumable", description: "+100 energia instantâneo." },
};

export const MIN_RECORD_TO_ACCESS = 3;
