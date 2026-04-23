import { SlashCommandBuilder, EmbedBuilder, type ChatInputCommandInteraction } from "discord.js";
import { eq } from "drizzle-orm";
import { db, schema } from "../systems/db.js";
import { getOrCreatePlayer, updatePlayer } from "../systems/player.js";

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName("casar")
      .setDescription("Pedir alguém em casamento")
      .addUserOption(o => o.setName("jogador").setDescription("Pessoa a casar").setRequired(true)),
    async execute(interaction: ChatInputCommandInteraction) {
      const player = await getOrCreatePlayer(interaction.user.id, interaction.user.username);
      const target = interaction.options.getUser("jogador", true);
      if (target.id === player.discordId) return interaction.reply({ content: "❌ Não dá para casar consigo mesmo.", ephemeral: true });
      if (target.bot) return interaction.reply({ content: "❌ Bots não casam.", ephemeral: true });
      const partner = await getOrCreatePlayer(target.id, target.username);
      if (player.partnerId) return interaction.reply({ content: "❌ Você já é casado(a).", ephemeral: true });
      if (partner.partnerId) return interaction.reply({ content: "❌ Esse jogador já é casado(a).", ephemeral: true });

      const now = new Date();
      await updatePlayer(player.discordId, { partnerId: target.id, marriedAt: now });
      await updatePlayer(target.id, { partnerId: player.discordId, marriedAt: now });

      return interaction.reply({ content: `💍 **${player.username}** e **${target.username}** estão oficialmente casados! 🎉` });
    },
  },
  {
    data: new SlashCommandBuilder().setName("divorciar").setDescription("Divorciar-se do parceiro"),
    async execute(interaction: ChatInputCommandInteraction) {
      const player = await getOrCreatePlayer(interaction.user.id, interaction.user.username);
      if (!player.partnerId) return interaction.reply({ content: "❌ Você não é casado(a).", ephemeral: true });
      const partnerId = player.partnerId;
      await updatePlayer(player.discordId, { partnerId: null, marriedAt: null });
      await updatePlayer(partnerId, { partnerId: null, marriedAt: null });
      return interaction.reply({ content: `💔 Divórcio finalizado. Você está solteiro(a) novamente.` });
    },
  },
];
