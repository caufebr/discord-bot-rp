import { SlashCommandBuilder, EmbedBuilder, type ChatInputCommandInteraction } from "discord.js";
import { getOrCreatePlayer, updatePlayer, removeMoney, formatMoney } from "../systems/player.js";
import { logTransaction } from "../systems/economy.js";
import { SHOP_ITEMS, type ShopItemKey } from "../systems/shop.js";

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName("loja")
      .setDescription("Loja de itens básicos")
      .addSubcommand(s => s.setName("ver").setDescription("Ver itens à venda"))
      .addSubcommand(s =>
        s.setName("comprar")
          .setDescription("Comprar um item")
          .addStringOption(o =>
            o.setName("item").setDescription("Item a comprar").setRequired(true)
              .addChoices(...Object.entries(SHOP_ITEMS).map(([k, v]) => ({ name: `${v.emoji} ${v.name} — ${formatMoney(v.price)}`, value: k }))),
          )
          .addIntegerOption(o => o.setName("quantidade").setDescription("Quantidade").setRequired(false).setMinValue(1).setMaxValue(99)),
      )
      .addSubcommand(s => s.setName("inventario").setDescription("Ver seu inventário")),
    async execute(interaction: ChatInputCommandInteraction) {
      const player = await getOrCreatePlayer(interaction.user.id, interaction.user.username);
      const sub = interaction.options.getSubcommand();

      if (sub === "ver") {
        const embed = new EmbedBuilder().setTitle("🛒 Loja de Itens Básicos").setColor(0xffaa00);
        for (const [, item] of Object.entries(SHOP_ITEMS)) {
          embed.addFields({ name: `${item.emoji} ${item.name}`, value: `${item.description}\n💵 ${formatMoney(item.price)}`, inline: true });
        }
        embed.setFooter({ text: "Use /loja comprar item:<nome> quantidade:<n>" });
        return interaction.reply({ embeds: [embed] });
      }

      if (sub === "comprar") {
        const itemKey = interaction.options.getString("item", true) as ShopItemKey;
        const qty = interaction.options.getInteger("quantidade") ?? 1;
        const item = SHOP_ITEMS[itemKey];
        if (!item) return interaction.reply({ content: "❌ Item inválido.", ephemeral: true });

        const total = item.price * qty;
        if (player.balance < total) return interaction.reply({ content: `❌ Custa ${formatMoney(total)}, você tem ${formatMoney(player.balance)}.`, ephemeral: true });

        await removeMoney(player.discordId, total);
        const inv = { ...(player.inventory ?? {}) };
        inv[itemKey] = (inv[itemKey] ?? 0) + qty;
        await updatePlayer(player.discordId, { inventory: inv });
        await logTransaction(player.discordId, "SHOP", total, "shop_buy", `${qty}x ${item.name}`);

        return interaction.reply({ content: `✅ Comprou ${qty}x ${item.emoji} **${item.name}** por ${formatMoney(total)}.` });
      }

      if (sub === "inventario") {
        const inv = player.inventory ?? {};
        const entries = Object.entries(inv).filter(([, n]) => n > 0);
        const embed = new EmbedBuilder().setTitle("🎒 Seu Inventário").setColor(0x5865f2);
        if (entries.length === 0) {
          embed.setDescription("Vazio. Visite a `/loja ver`.");
        } else {
          for (const [key, qty] of entries) {
            const meta = SHOP_ITEMS[key as ShopItemKey];
            embed.addFields({ name: meta ? `${meta.emoji} ${meta.name}` : key, value: `x${qty}`, inline: true });
          }
        }
        return interaction.reply({ embeds: [embed], ephemeral: true });
      }
    },
  },
];
