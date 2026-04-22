import { db, schema } from "./db.js";
import { eq } from "drizzle-orm";

export async function seedDatabase() {
  const eco = await db.query.worldEconomy.findFirst();
  if (!eco) {
    await db.insert(schema.worldEconomy).values({ id: 1, inflation: 1.0, gdp: 1000000, taxRate: 0.1, bankTaxRate: 0.02, incomeTaxRate: 0.15, totalMoneySupply: 0 });
  }

  const gov = await db.query.government.findFirst();
  if (!gov) {
    await db.insert(schema.government).values({ id: 1, taxMultiplier: 100, crimeMultiplier: 100, policeSalaryMultiplier: 100, activeLaws: [] });
  }

  const territories = await db.query.territories.findMany();
  if (territories.length === 0) {
    await db.insert(schema.territories).values([
      { name: "Centro Histórico", passiveIncome: 1000, defenseBonus: 1.2 },
      { name: "Porto Industrial", passiveIncome: 1500, defenseBonus: 1.0 },
      { name: "Favela Norte", passiveIncome: 500, defenseBonus: 0.8 },
      { name: "Zona Sul", passiveIncome: 800, defenseBonus: 1.0 },
      { name: "Aeroporto", passiveIncome: 2000, defenseBonus: 1.5 },
      { name: "Mercado Central", passiveIncome: 1200, defenseBonus: 1.1 },
    ]);
    console.log("✅ Territórios criados.");
  }
}
