import type { Client, TextChannel } from "discord.js";
import { and, desc, eq, gt } from "drizzle-orm";
import { db, schema } from "./db.js";

export type EventType = "inflacao" | "recessao" | "boom" | "deflacao";

export const EVENT_DEFS: Record<EventType, { name: string; emoji: string; desc: string; multiplier: number; durationH: number }> = {
  inflacao: { name: "Inflação Alta", emoji: "📈", desc: "Preços disparam! Inflação em alta.", multiplier: 1.4, durationH: 6 },
  recessao: { name: "Recessão", emoji: "📉", desc: "Economia em crise. Salários reduzidos.", multiplier: 0.7, durationH: 8 },
  boom: { name: "Boom Econômico", emoji: "🚀", desc: "Economia em ebulição! Ganhos turbinados.", multiplier: 1.5, durationH: 6 },
  deflacao: { name: "Deflação", emoji: "❄️", desc: "Tudo mais barato, mas economia parada.", multiplier: 0.85, durationH: 6 },
};

export async function getActiveEvent() {
  return db.query.economicEvents.findFirst({
    where: and(eq(schema.economicEvents.active, true), gt(schema.economicEvents.endsAt, new Date())),
    orderBy: [desc(schema.economicEvents.startedAt)],
  });
}

export async function startEvent(type: EventType, client?: Client, channelId?: string) {
  const def = EVENT_DEFS[type];
  const endsAt = new Date(Date.now() + def.durationH * 60 * 60 * 1000);
  // desativa anteriores
  await db.update(schema.economicEvents).set({ active: false }).where(eq(schema.economicEvents.active, true));
  await db.insert(schema.economicEvents).values({ type, endsAt });
  // aplica no worldEconomy
  const eco = await db.query.worldEconomy.findFirst();
  if (eco) {
    await db.update(schema.worldEconomy).set({ inflation: def.multiplier }).where(eq(schema.worldEconomy.id, eco.id));
  }
  if (client && channelId) {
    try {
      const ch = await client.channels.fetch(channelId);
      if (ch && "send" in ch) {
        await (ch as TextChannel).send(`${def.emoji} **${def.name.toUpperCase()}** — ${def.desc}\n⏰ Duração: ${def.durationH}h.`);
      }
    } catch {}
  }
}

export async function tickEvents(client: Client, channelId: string) {
  const active = await getActiveEvent();
  if (active) return;
  // chance 8% por hora de novo evento
  if (Math.random() < 0.08) {
    const types: EventType[] = ["inflacao", "recessao", "boom", "deflacao"];
    const t = types[Math.floor(Math.random() * types.length)]!;
    await startEvent(t, client, channelId);
  } else {
    // sem evento → restaurar inflação base
    const eco = await db.query.worldEconomy.findFirst();
    if (eco && eco.inflation !== 1.0) {
      await db.update(schema.worldEconomy).set({ inflation: 1.0 }).where(eq(schema.worldEconomy.id, eco.id));
    }
  }
}

export function startEventCron(client: Client, channelId: string) {
  setInterval(() => { tickEvents(client, channelId).catch(() => {}); }, 60 * 60 * 1000);
}
