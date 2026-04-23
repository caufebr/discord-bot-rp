import { eq } from "drizzle-orm";
import { db, schema } from "./db.js";
import type { Player } from "@workspace/db/schema";

export async function getOrCreatePlayer(discordId: string, username: string): Promise<Player> {
  const existing = await db.query.players.findFirst({
    where: eq(schema.players.discordId, discordId),
  });
  if (existing) return existing;

  const [player] = await db
    .insert(schema.players)
    .values({ discordId, username, balance: 1000, bankBalance: 0 })
    .returning();
  return player;
}

export async function getPlayer(discordId: string): Promise<Player | undefined> {
  return db.query.players.findFirst({ where: eq(schema.players.discordId, discordId) });
}

export async function updatePlayer(discordId: string, data: Partial<Player>) {
  await db.update(schema.players).set(data).where(eq(schema.players.discordId, discordId));
}

export async function addMoney(discordId: string, amount: number) {
  const p = await getPlayer(discordId);
  if (!p) return;
  await updatePlayer(discordId, { balance: p.balance + amount });
}

export async function removeMoney(discordId: string, amount: number): Promise<boolean> {
  const p = await getPlayer(discordId);
  if (!p || p.balance < amount) return false;
  await updatePlayer(discordId, { balance: p.balance - amount });
  return true;
}

export function formatMoney(amount: number): string {
  return `R$ ${amount.toLocaleString("pt-BR")}`;
}

export function isJailed(player: Player): boolean {
  if (!player.isJailed) return false;
  if (player.jailEnd && new Date() > player.jailEnd) {
    updatePlayer(player.discordId, { isJailed: false, jailEnd: null });
    return false;
  }
  return true;
}

export function isHospitalized(player: Player): boolean {
  if (!player.isHospitalized) return false;
  if (player.hospitalizationEnd && new Date() > player.hospitalizationEnd) {
    updatePlayer(player.discordId, { isHospitalized: false, hospitalizationEnd: null, health: 100 });
    return false;
  }
  return true;
}

export function isDead(player: Player): boolean {
  if (!player.isDead) return false;
  if (player.deathEnd && new Date() > player.deathEnd) {
    updatePlayer(player.discordId, { isDead: false, deathEnd: null, health: 50, isHospitalized: false });
    return false;
  }
  return true;
}

export async function killPlayer(discordId: string, reason: string): Promise<{ lostMoney: number; reason: string }> {
  const p = await getPlayer(discordId);
  if (!p) return { lostMoney: 0, reason };
  const lost = p.balance + p.bankBalance;
  const deathEnd = new Date(Date.now() + 30 * 60 * 1000);
  await updatePlayer(discordId, {
    isDead: true,
    deathEnd,
    health: 0,
    balance: 0,
    bankBalance: 0,
    weapon: null,
    isJailed: false,
    jailEnd: null,
    wantedLevel: 0,
  });
  return { lostMoney: lost, reason };
}

export async function refillEnergy(player: Player): Promise<Player> {
  const now = new Date();
  const last = player.lastEnergyRefill ?? player.createdAt;
  const minutes = Math.floor((now.getTime() - last.getTime()) / (60 * 1000));
  if (minutes < 6) return player;
  const refill = Math.min(100 - player.energy, Math.floor(minutes / 6) * 5);
  if (refill <= 0) return player;
  const newEnergy = Math.min(100, player.energy + refill);
  await updatePlayer(player.discordId, { energy: newEnergy, lastEnergyRefill: now });
  return { ...player, energy: newEnergy, lastEnergyRefill: now };
}

export async function consumeEnergy(discordId: string, amount: number): Promise<boolean> {
  const p = await getPlayer(discordId);
  if (!p) return false;
  const refreshed = await refillEnergy(p);
  if (refreshed.energy < amount) return false;
  await updatePlayer(discordId, { energy: refreshed.energy - amount });
  return true;
}
