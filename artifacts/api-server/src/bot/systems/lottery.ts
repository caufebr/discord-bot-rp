import type { Client, TextChannel } from "discord.js";
import { and, desc, eq, lt } from "drizzle-orm";
import { db, schema } from "./db.js";
import { addMoney } from "./player.js";

export const TICKET_PRICE = 100;
export const DRAW_INTERVAL_HOURS = 24;
export const NUMBER_RANGE = 100;

export async function getCurrentDraw() {
  const open = await db.query.lotteryDraws.findFirst({
    where: eq(schema.lotteryDraws.winningNumber as never, null as never),
    orderBy: [desc(schema.lotteryDraws.drawAt)],
  }).catch(() => null);
  if (open) return open;
  const last = await db.query.lotteryDraws.findFirst({ orderBy: [desc(schema.lotteryDraws.drawNumber)] });
  const next = (last?.drawNumber ?? 0) + 1;
  const drawAt = new Date(Date.now() + DRAW_INTERVAL_HOURS * 60 * 60 * 1000);
  const [d] = await db.insert(schema.lotteryDraws).values({ drawNumber: next, drawAt, totalPot: 0 }).returning();
  return d;
}

export async function buyTicket(playerId: string, number: number) {
  const draw = await getCurrentDraw();
  await db.insert(schema.lotteryTickets).values({ drawId: draw.id, playerId, number });
  await db.update(schema.lotteryDraws).set({ totalPot: draw.totalPot + TICKET_PRICE }).where(eq(schema.lotteryDraws.id, draw.id));
  return draw;
}

export async function runDrawIfDue(client: Client, channelId: string) {
  const due = await db.query.lotteryDraws.findMany({
    where: and(lt(schema.lotteryDraws.drawAt, new Date())),
  });
  for (const d of due) {
    if (d.drawnAt) continue;
    const winning = Math.floor(Math.random() * NUMBER_RANGE) + 1;
    const winners = await db.query.lotteryTickets.findMany({
      where: and(eq(schema.lotteryTickets.drawId, d.id), eq(schema.lotteryTickets.number, winning)),
    });
    let winnerId: string | null = null;
    if (winners.length > 0) {
      const w = winners[Math.floor(Math.random() * winners.length)]!;
      winnerId = w.playerId;
      await addMoney(winnerId, d.totalPot);
    }
    await db.update(schema.lotteryDraws).set({ winningNumber: winning, drawnAt: new Date(), winnerId }).where(eq(schema.lotteryDraws.id, d.id));
    try {
      const ch = await client.channels.fetch(channelId);
      if (ch && "send" in ch) {
        const text = winnerId
          ? `🎰 **LOTERIA #${d.drawNumber}** — Número sorteado: **${winning}**\n💰 Prêmio: R$ ${d.totalPot.toLocaleString("pt-BR")}\n🏆 Vencedor: <@${winnerId}>`
          : `🎰 **LOTERIA #${d.drawNumber}** — Número sorteado: **${winning}**\n😢 Ninguém acertou. Acumulou R$ ${d.totalPot.toLocaleString("pt-BR")} pro próximo!`;
        await (ch as TextChannel).send(text);
        if (!winnerId) {
          // acumula no próximo
          const next = await getCurrentDraw();
          await db.update(schema.lotteryDraws).set({ totalPot: next.totalPot + d.totalPot }).where(eq(schema.lotteryDraws.id, next.id));
        }
      }
    } catch {}
  }
}

export function startLotteryCron(client: Client, channelId: string) {
  runDrawIfDue(client, channelId).catch(() => {});
  setInterval(() => { runDrawIfDue(client, channelId).catch(() => {}); }, 5 * 60 * 1000);
}
