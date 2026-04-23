import type { Client, TextChannel } from "discord.js";
import { EmbedBuilder } from "discord.js";
import { db, schema } from "./db.js";
import { desc } from "drizzle-orm";

const RADIO_INTERVAL_MS = 30 * 60 * 1000;

const RUMORS = [
  "Dizem que um jogador encontrou um Lamborghini abandonado no porto...",
  "Boatos de que a polícia vai fazer uma blitz nos próximos minutos.",
  "Rumores de que o preço da uva vai disparar essa semana.",
  "Alguém viu uma gangue se reunindo no Centro Histórico ontem à noite.",
  "Especialistas dizem que o real está se desvalorizando rápido.",
  "Um pet exótico fugiu de uma mansão da Zona Sul.",
];

const NEWS = [
  "📰 BOLSA: empresas listadas tiveram movimento intenso hoje.",
  "📰 SEGURANÇA: nível de criminalidade na cidade aumentou 12%.",
  "📰 ECONOMIA: governo discute ajuste na taxa de impostos.",
  "📰 SAÚDE: hospital com capacidade reduzida nos próximos dias.",
  "📰 AGRO: colheitas atingem recorde no semestre.",
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

export async function broadcastRadio(client: Client, channelId: string) {
  try {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased() || !("send" in channel)) return;

    const eco = await db.query.worldEconomy.findFirst();
    const topPlayers = await db.query.players.findMany({ orderBy: [desc(schema.players.balance)], limit: 3 });

    const embed = new EmbedBuilder()
      .setTitle("📻 Rádio Comunitária")
      .setColor(0xffa500)
      .setDescription(pick(NEWS))
      .addFields(
        { name: "💰 Inflação", value: eco ? `${((eco.inflation - 1) * 100).toFixed(1)}%` : "—", inline: true },
        { name: "🏆 Top Jogadores", value: topPlayers.map((p, i) => `${i + 1}. ${p.username} — R$ ${p.balance.toLocaleString("pt-BR")}`).join("\n") || "Nenhum jogador ainda.", inline: false },
        { name: "🗣️ Rumor da hora", value: pick(RUMORS), inline: false },
      )
      .setTimestamp();

    await (channel as TextChannel).send({ embeds: [embed] });
  } catch (err) {
    console.error("Radio broadcast failed:", err);
  }
}

export function startRadio(client: Client, channelId: string) {
  setTimeout(() => broadcastRadio(client, channelId), 60_000);
  setInterval(() => broadcastRadio(client, channelId), RADIO_INTERVAL_MS);
}
