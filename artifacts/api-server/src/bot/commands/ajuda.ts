import { SlashCommandBuilder, EmbedBuilder, type ChatInputCommandInteraction } from "discord.js";

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName("ajuda")
      .setDescription("Ver os comandos disponíveis"),
    async execute(interaction: ChatInputCommandInteraction) {
      const embed = new EmbedBuilder()
        .setTitle("📖 Comandos disponíveis")
        .setColor(0x5865f2)
        .setDescription("Lista enxuta com os comandos essenciais do bot.")
        .addFields(
          { name: "💰 Economia", value: "`/saldo` · `/banco depositar|sacar|saldo` · `/transferir` · `/trabalhar`" },
          { name: "🎁 Recompensa", value: "`/daily` — recompensa diária com streak" },
          { name: "🛒 Loja", value: "`/loja ver|comprar|inventario`" },
          { name: "🪪 Personagem", value: "`/perfil` (criar RG) · `/rg [jogador]` · `/mochila`" },
          { name: "🛠️ Admin", value: "`/adm dar|remover|resetar` (apenas administradores)" },
        )
        .setFooter({ text: "Use /ajuda a qualquer momento." });

      await interaction.reply({ embeds: [embed], ephemeral: true });
    },
  },
];
