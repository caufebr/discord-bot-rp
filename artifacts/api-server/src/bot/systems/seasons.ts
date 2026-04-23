import { db, schema } from "./db.js";
import { eq } from "drizzle-orm";
import type { Client, TextChannel } from "discord.js";
import { EmbedBuilder } from "discord.js";

const SEASON_DURATION_MS = 6 * 30 * 24 * 60 * 60 * 1000; // ~6 months

export async function ensureSeason() {
  const cur = await db.query.seasons.findFirst();
  if (!cur) {
    const endsAt = new Date(Date.now() + SEASON_DURATION_MS);
    await db.insert(schema.seasons).values({ id: 1, number: 1, endsAt });
    return;
  }
  if (cur.endsAt && new Date() > cur.endsAt) {
    await rotateSeason(cur.number + 1);
  }
}

export async function rotateSeason(newNumber: number) {
  // Soft reset: cap balances and reduce inflation
  const all = await db.query.players.findMany();
  for (const p of all) {
    const newBal = Math.min(p.balance, 10000);
    const newBank = Math.floor(p.bankBalance * 0.5);
    await db.update(schema.players).set({
      balance: newBal,
      bankBalance: newBank,
      lastDaily: null,
      lastWeekly: null,
      lastBonus: null,
      wantedLevel: 0,
    }).where(eq(schema.players.discordId, p.discordId));
  }
  await db.update(schema.worldEconomy).set({ inflation: 1.0 }).where(eq(schema.worldEconomy.id, 1));
  const endsAt = new Date(Date.now() + SEASON_DURATION_MS);
  await db.update(schema.seasons).set({ number: newNumber, startedAt: new Date(), endsAt }).where(eq(schema.seasons.id, 1));
}

export function startSeasonChecker(client: Client | null, broadcastChannelId: string | null) {
  setInterval(async () => {
    const cur = await db.query.seasons.findFirst();
    if (cur && new Date() > cur.endsAt) {
      await rotateSeason(cur.number + 1);
      if (client && broadcastChannelId) {
        const channel = await client.channels.fetch(broadcastChannelId).catch(() => null);
        if (channel && channel.isTextBased() && "send" in channel) {
          const embed = new EmbedBuilder()
            .setTitle("🔄 NOVA TEMPORADA INICIADA!")
            .setColor(0xff0000)
            .setDescription(`A economia foi resetada. Bem-vindo à Temporada **#${cur.number + 1}**!\n\n• Saldos foram limitados\n• Inflação resetada\n• Cooldowns liberados`);
          await (channel as TextChannel).send({ embeds: [embed] });
        }
      }
    }
  }, 60 * 60 * 1000); // hourly check
}
