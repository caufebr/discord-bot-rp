import { eq } from "drizzle-orm";
import { db, schema } from "./db.js";
import type { Client, TextChannel } from "discord.js";
import { EmbedBuilder } from "discord.js";

const EVENT_TYPES = [
  {
    type: "crash",
    title: "📉 Crash do Mercado!",
    description: "O mercado financeiro colapsou! Preços das ações despencaram.",
    effect: { stockPriceMultiplier: 0.7, inflationChange: 0.1 },
    duration: 60 * 60 * 1000,
  },
  {
    type: "boom",
    title: "📈 Boom Econômico!",
    description: "A economia está aquecida! Todos os negócios prosperam.",
    effect: { stockPriceMultiplier: 1.3, inflationChange: -0.05 },
    duration: 90 * 60 * 1000,
  },
  {
    type: "crise_politica",
    title: "🏛️ Crise Política!",
    description: "Instabilidade no governo! Impostos aumentados temporariamente.",
    effect: { taxMultiplierChange: 20 },
    duration: 45 * 60 * 1000,
  },
  {
    type: "greve",
    title: "✊ Greve Geral!",
    description: "Trabalhadores em greve! Salários temporariamente suspensos.",
    effect: { workDisabled: true },
    duration: 30 * 60 * 1000,
  },
  {
    type: "guerra_gangues",
    title: "🔫 Guerra de Gangues!",
    description: "Violência nas ruas! Crime aumentou, polícia em alerta.",
    effect: { crimeBonus: 0.2 },
    duration: 60 * 60 * 1000,
  },
  {
    type: "festival",
    title: "🎉 Festival da Cidade!",
    description: "Economia aquecida pelo turismo! Todos ganham bônus no trabalho.",
    effect: { workBonus: 0.5 },
    duration: 120 * 60 * 1000,
  },
];

export async function triggerRandomEvent(client: Client, channelId: string) {
  const event = EVENT_TYPES[Math.floor(Math.random() * EVENT_TYPES.length)];
  const endsAt = new Date(Date.now() + event.duration);

  await db.insert(schema.worldEvents).values({
    type: event.type,
    title: event.title,
    description: event.description,
    effect: event.effect,
    isActive: true,
    endsAt,
  });

  const effect = event.effect as any;

  if (effect.stockPriceMultiplier) {
    const companies = await db.query.companies.findMany({ where: eq(schema.companies.isPublic, true) });
    for (const c of companies) {
      const newPrice = Math.max(1, Math.floor(c.sharePrice * effect.stockPriceMultiplier));
      const history = [...(c.priceHistory as number[]), newPrice].slice(-20);
      await db.update(schema.companies).set({
        sharePrice: newPrice,
        marketCap: newPrice * c.totalShares,
        priceHistory: history,
      }).where(eq(schema.companies.id, c.id));
    }
  }

  if (effect.inflationChange) {
    const eco = await db.query.worldEconomy.findFirst();
    if (eco) {
      await db.update(schema.worldEconomy).set({
        inflation: Math.max(0.5, Math.min(3.0, eco.inflation + effect.inflationChange)),
        updatedAt: new Date(),
      }).where(eq(schema.worldEconomy.id, 1));
    }
  }

  try {
    const channel = await client.channels.fetch(channelId) as TextChannel;
    if (channel) {
      const embed = new EmbedBuilder()
        .setTitle(`🌍 EVENTO MUNDIAL: ${event.title}`)
        .setDescription(event.description)
        .setColor(0xff6600)
        .addFields({ name: "⏱️ Duração", value: `${event.duration / 60000} minutos` })
        .setTimestamp();
      await channel.send({ embeds: [embed] });
    }
  } catch {}
}

export async function updateStockPrices() {
  const companies = await db.query.companies.findMany({ where: eq(schema.companies.isPublic, true) });
  for (const c of companies) {
    const change = (Math.random() - 0.48) * 0.05;
    const newPrice = Math.max(1, Math.floor(c.sharePrice * (1 + change)));
    const history = [...(c.priceHistory as number[]), newPrice].slice(-20);
    await db.update(schema.companies).set({
      sharePrice: newPrice,
      marketCap: newPrice * c.totalShares,
      priceHistory: history,
    }).where(eq(schema.companies.id, c.id));
  }
}

export async function updateInflation() {
  const eco = await db.query.worldEconomy.findFirst();
  if (!eco) return;
  const change = (Math.random() - 0.5) * 0.02;
  await db.update(schema.worldEconomy).set({
    inflation: Math.max(0.8, Math.min(2.5, eco.inflation + change)),
    updatedAt: new Date(),
  }).where(eq(schema.worldEconomy.id, 1));
}

const RADIO_NEWS = [
  "📻 *Boletim FavelaFM:* O preço do milho subiu 12% essa semana — bom momento para colher!",
  "📻 *Rádio Comunitária:* Rumores de que uma nova gangue está se formando no centro...",
  "📻 *Notícias da Cidade:* A polícia intensificou patrulhas — cuidado com /crime hoje.",
  "📻 *Boletim:* Investidores estão de olho em ações de empresas pequenas. Veja /bolsa.",
  "📻 *FavelaFM:* Casamentos estão em alta no servidor! Veja se alguém quer dizer 'sim'.",
  "📻 *Alerta:* Ration de pet em falta nas lojas em breve — abasteçam-se!",
  "📻 *Rádio:* Um morador anônimo doou R$ 50.000 para o bairro. Quem será?",
  "📻 *Notícia:* Mercado de armas registra alta na procura por pistolas. Tensão aumenta.",
  "📻 *Boletim:* A inflação está oscilando — preços podem mudar.",
  "📻 *Rumores:* Dizem que existe um cofre escondido em algum território...",
  "📻 *FavelaFM:* O político mais votado promete reduzir os impostos. Será?",
  "📻 *Notícia:* Festival da cidade pode acontecer a qualquer momento — fique atento!",
];

export async function broadcastRadio(client: Client, channelId: string) {
  try {
    const news = RADIO_NEWS[Math.floor(Math.random() * RADIO_NEWS.length)];
    const channel = await client.channels.fetch(channelId) as TextChannel;
    if (channel) await channel.send(news);
  } catch {}
}

export function startWorldEngine(client: Client, eventChannelId: string) {
  setInterval(() => updateStockPrices(), 5 * 60 * 1000);
  setInterval(() => updateInflation(), 15 * 60 * 1000);
  const eventInterval = 30 + Math.floor(Math.random() * 30);
  setInterval(() => {
    const chance = Math.random();
    if (chance < 0.3) triggerRandomEvent(client, eventChannelId);
  }, eventInterval * 60 * 1000);
  setInterval(() => broadcastRadio(client, eventChannelId), 25 * 60 * 1000);
}
