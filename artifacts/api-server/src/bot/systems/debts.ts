import { and, eq, lt } from "drizzle-orm";
import { db, schema } from "./db.js";
import { getPlayer, updatePlayer, addMoney } from "./player.js";

export const DEFAULT_INTEREST = 0.05;
export const DEFAULT_DUE_DAYS = 7;

export async function createDebt(debtorId: string, creditorId: string | null, amount: number, days = DEFAULT_DUE_DAYS, rate = DEFAULT_INTEREST) {
  const dueAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  const [d] = await db.insert(schema.debts).values({
    debtorId, creditorId, originalAmount: amount, remainingAmount: amount, interestRate: rate, dueAt,
  }).returning();
  return d;
}

export async function listDebts(debtorId: string) {
  return db.query.debts.findMany({ where: and(eq(schema.debts.debtorId, debtorId), eq(schema.debts.paid, false)) });
}

export async function payDebt(debtId: number, payerId: string): Promise<{ ok: boolean; msg: string }> {
  const d = await db.query.debts.findFirst({ where: eq(schema.debts.id, debtId) });
  if (!d || d.paid) return { ok: false, msg: "Dívida não encontrada ou já paga." };
  if (d.debtorId !== payerId) return { ok: false, msg: "Essa dívida não é sua." };
  const p = await getPlayer(payerId);
  if (!p) return { ok: false, msg: "Jogador não encontrado." };
  if (p.balance < d.remainingAmount) return { ok: false, msg: `Saldo insuficiente. Precisa de R$ ${d.remainingAmount.toLocaleString("pt-BR")}.` };
  await updatePlayer(payerId, { balance: p.balance - d.remainingAmount });
  if (d.creditorId) await addMoney(d.creditorId, d.remainingAmount);
  await db.update(schema.debts).set({ paid: true, remainingAmount: 0 }).where(eq(schema.debts.id, debtId));
  return { ok: true, msg: `Quitou a dívida #${debtId} (R$ ${d.remainingAmount.toLocaleString("pt-BR")}).` };
}

// Cron: aplicar juros diariamente nas dívidas em atraso e marcar caloteiros
export async function processOverdueDebts() {
  const overdue = await db.query.debts.findMany({
    where: and(eq(schema.debts.paid, false), eq(schema.debts.defaulted, false), lt(schema.debts.dueAt, new Date())),
  });
  for (const d of overdue) {
    const newAmount = Math.floor(d.remainingAmount * (1 + d.interestRate));
    await db.update(schema.debts).set({ remainingAmount: newAmount, defaulted: true }).where(eq(schema.debts.id, d.id));
    const p = await getPlayer(d.debtorId);
    if (p) await updatePlayer(d.debtorId, { reputation: p.reputation - 50, karma: p.karma - 10 });
  }
}

export function startDebtCron() {
  processOverdueDebts().catch(() => {});
  setInterval(() => { processOverdueDebts().catch(() => {}); }, 60 * 60 * 1000);
}

// Falência ----------------------------------------------------------------
export async function checkBankruptcy(discordId: string): Promise<boolean> {
  const p = await getPlayer(discordId);
  if (!p) return false;
  if (p.bankrupt) {
    if (p.bankruptUntil && new Date() > p.bankruptUntil) {
      await updatePlayer(discordId, { bankrupt: false, bankruptUntil: null });
      return false;
    }
    return true;
  }
  const debts = await listDebts(discordId);
  const totalDebt = debts.reduce((s, d) => s + d.remainingAmount, 0);
  const wealth = p.balance + p.bankBalance;
  if (totalDebt > 0 && wealth - totalDebt < -10000) {
    await declareBankruptcy(discordId);
    return true;
  }
  return false;
}

export async function declareBankruptcy(discordId: string) {
  const until = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  // perde casas e carros
  await db.delete(schema.cars).where(eq(schema.cars.ownerId, discordId));
  await db.delete(schema.houses).where(eq(schema.houses.ownerId, discordId));
  // zera dívidas (perdão judicial — calote total)
  await db.update(schema.debts).set({ paid: true, remainingAmount: 0, defaulted: true })
    .where(and(eq(schema.debts.debtorId, discordId), eq(schema.debts.paid, false)));
  const p = await getPlayer(discordId);
  await updatePlayer(discordId, {
    bankrupt: true, bankruptUntil: until,
    balance: 0, bankBalance: 0,
    reputation: (p?.reputation ?? 0) - 200,
    karma: (p?.karma ?? 0) - 30,
  });
}
