import { eq } from "drizzle-orm";
import { db, schema } from "./db.js";

export const PROFESSIONS = {
  policial: { name: "Policial", emoji: "👮", baseSalary: 3500, courseCost: 5000, trainDays: 1 },
  medico: { name: "Médico", emoji: "🏥", baseSalary: 8000, courseCost: 15000, trainDays: 2 },
  advogado: { name: "Advogado", emoji: "⚖️", baseSalary: 7000, courseCost: 12000, trainDays: 2 },
  bombeiro: { name: "Bombeiro", emoji: "🚒", baseSalary: 4000, courseCost: 6000, trainDays: 1 },
  mecanico: { name: "Mecânico", emoji: "🔧", baseSalary: 3000, courseCost: 4000, trainDays: 1 },
  aeromoca: { name: "Aeromoça", emoji: "✈️", baseSalary: 5000, courseCost: 8000, trainDays: 1 },
  piloto: { name: "Piloto", emoji: "👨‍✈️", baseSalary: 12000, courseCost: 25000, trainDays: 3 },
  empresario: { name: "Empresário", emoji: "💼", baseSalary: 0, courseCost: 20000, trainDays: 2 },
};

export type ProfessionKey = keyof typeof PROFESSIONS;

export async function getEconomy() {
  let eco = await db.query.worldEconomy.findFirst();
  if (!eco) {
    const [inserted] = await db.insert(schema.worldEconomy).values({ id: 1 }).returning();
    eco = inserted;
  }
  return eco;
}

export async function getGovernment() {
  let gov = await db.query.government.findFirst();
  if (!gov) {
    const [inserted] = await db.insert(schema.government).values({ id: 1 }).returning();
    gov = inserted;
  }
  return gov;
}

export async function calcSalary(profession: ProfessionKey): Promise<number> {
  const eco = await getEconomy();
  const gov = await getGovernment();
  const base = PROFESSIONS[profession].baseSalary;
  let multiplier = eco.inflation * (gov.policeSalaryMultiplier / 100);
  if (profession === "policial") multiplier *= (gov.policeSalaryMultiplier / 100);
  return Math.floor(base * multiplier);
}

export async function applyTax(amount: number): Promise<number> {
  const eco = await getEconomy();
  const gov = await getGovernment();
  const rate = eco.incomeTaxRate * (gov.taxMultiplier / 100);
  return Math.floor(amount * (1 - rate));
}

export async function logTransaction(fromId: string | null, toId: string | null, amount: number, type: string, description: string) {
  await db.insert(schema.transactions).values({ fromId, toId, amount, type, description });
}

export function cooldownLeft(lastTime: Date | null, cooldownMs: number): number {
  if (!lastTime) return 0;
  const diff = Date.now() - new Date(lastTime).getTime();
  return Math.max(0, cooldownMs - diff);
}

export function formatCooldown(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}
