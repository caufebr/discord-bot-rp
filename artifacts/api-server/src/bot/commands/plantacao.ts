import { SlashCommandBuilder, EmbedBuilder, type ChatInputCommandInteraction } from "discord.js";
import { eq, and } from "drizzle-orm";
import { db, schema } from "../systems/db.js";
import { getOrCreatePlayer, updatePlayer, formatMoney } from "../systems/player.js";
import { logTransaction } from "../systems/economy.js";
import { CROPS, SHOP_ITEMS, type ShopItemKey } from "../systems/shop.js";

const MAX_PLOTS = 6;

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName("plantar")
      .setDescription("Plantar uma semente do seu inventário")
      .addStringOption(o =>
        o.setName("semente").setDescription("Semente a plantar").setRequired(true)
          .addChoices(
            ...Object.entries(SHOP_ITEMS)
              .filter(([, v]) => v.type === "seed")
              .map(([k, v]) => ({ name: `${v.emoji} ${v.name}`, value: k })),
          ),
      ),
    async execute(interaction: ChatInputCommandInteraction) {
      const player = await getOrCreatePlayer(interaction.user.id, interaction.user.username);
      const seedKey = interaction.options.getString("semente", true) as ShopItemKey;
      const seed = SHOP_ITEMS[seedKey];
      if (!seed || seed.type !== "seed" || !seed.cropKey) return interaction.reply({ content: "❌ Semente inválida.", ephemeral: true });

      const inv = { ...(player.inventory ?? {}) };
      if ((inv[seedKey] ?? 0) <= 0) return interaction.reply({ content: `❌ Você não tem ${seed.emoji} ${seed.name}. Compre na \`/loja\`.`, ephemeral: true });

      const active = await db.select().from(schema.plots).where(and(eq(schema.plots.ownerId, player.discordId), eq(schema.plots.harvested, false)));
      if (active.length >= MAX_PLOTS) return interaction.reply({ content: `❌ Você já tem ${MAX_PLOTS} plantações ativas. Use \`/colher\` primeiro.`, ephemeral: true });

      const crop = CROPS[seed.cropKey];
      let minutes = crop.growMinutes;
      if ((inv["fertilizante"] ?? 0) > 0) {
        minutes = Math.ceil(minutes * 0.7);
        inv["fertilizante"] = (inv["fertilizante"] ?? 1) - 1;
      }
      inv[seedKey] = (inv[seedKey] ?? 1) - 1;

      const readyAt = new Date(Date.now() + minutes * 60 * 1000);
      await db.insert(schema.plots).values({ ownerId: player.discordId, crop: seed.cropKey, readyAt });
      await updatePlayer(player.discordId, { inventory: inv });

      return interaction.reply({ content: `🌱 Plantou ${crop.emoji} **${crop.name}**! Estará pronta <t:${Math.floor(readyAt.getTime() / 1000)}:R>.` });
    },
  },
  {
    data: new SlashCommandBuilder().setName("plantacao").setDescription("Ver suas plantações"),
    async execute(interaction: ChatInputCommandInteraction) {
      const player = await getOrCreatePlayer(interaction.user.id, interaction.user.username);
      const active = await db.select().from(schema.plots).where(and(eq(schema.plots.ownerId, player.discordId), eq(schema.plots.harvested, false)));

      const embed = new EmbedBuilder().setTitle("🌾 Suas Plantações").setColor(0x88cc44);
      if (active.length === 0) {
        embed.setDescription("Nenhuma plantação ativa. Use `/plantar` para começar.");
      } else {
        for (const p of active) {
          const crop = CROPS[p.crop];
          const ready = p.readyAt.getTime() <= Date.now();
          embed.addFields({
            name: `${crop?.emoji ?? "🌱"} ${crop?.name ?? p.crop} (#${p.id})`,
            value: ready ? "✅ Pronta para colher!" : `⏳ Pronta <t:${Math.floor(p.readyAt.getTime() / 1000)}:R>`,
            inline: true,
          });
        }
      }
      embed.setFooter({ text: `Slots: ${active.length}/${MAX_PLOTS}` });
      return interaction.reply({ embeds: [embed], ephemeral: true });
    },
  },
  {
    data: new SlashCommandBuilder().setName("colher").setDescription("Colher e vender todas as plantações prontas"),
    async execute(interaction: ChatInputCommandInteraction) {
      const player = await getOrCreatePlayer(interaction.user.id, interaction.user.username);
      const active = await db.select().from(schema.plots).where(and(eq(schema.plots.ownerId, player.discordId), eq(schema.plots.harvested, false)));
      const ready = active.filter(p => p.readyAt.getTime() <= Date.now());

      if (ready.length === 0) return interaction.reply({ content: "❌ Nenhuma plantação está pronta.", ephemeral: true });

      let total = 0;
      const lines: string[] = [];
      for (const p of ready) {
        const crop = CROPS[p.crop];
        if (!crop) continue;
        const value = Math.floor(Math.random() * (crop.sellMax - crop.sellMin) + crop.sellMin);
        total += value;
        lines.push(`${crop.emoji} ${crop.name} → ${formatMoney(value)}`);
        await db.update(schema.plots).set({ harvested: true }).where(eq(schema.plots.id, p.id));
      }

      await updatePlayer(player.discordId, { balance: player.balance + total });
      await logTransaction(null, player.discordId, total, "harvest", `${ready.length} colheita(s)`);

      const embed = new EmbedBuilder()
        .setTitle("🚜 Colheita realizada!")
        .setColor(0x00cc66)
        .setDescription(lines.join("\n"))
        .addFields({ name: "💰 Total recebido", value: formatMoney(total) });
      return interaction.reply({ embeds: [embed] });
    },
  },
];
