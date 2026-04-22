import { SlashCommandBuilder, PermissionFlagsBits, type ChatInputCommandInteraction } from "discord.js";
import { getOrCreatePlayer, updatePlayer, formatMoney } from "../systems/player.js";
import { logTransaction } from "../systems/economy.js";

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName("adm")
      .setDescription("Comandos administrativos de economia")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addSubcommand(s =>
        s.setName("dar")
          .setDescription("Dar dinheiro a um membro")
          .addUserOption(o => o.setName("membro").setDescription("Membro alvo").setRequired(true))
          .addIntegerOption(o => o.setName("valor").setDescription("Valor a dar").setRequired(true).setMinValue(1)),
      )
      .addSubcommand(s =>
        s.setName("remover")
          .setDescription("Remover dinheiro de um membro")
          .addUserOption(o => o.setName("membro").setDescription("Membro alvo").setRequired(true))
          .addIntegerOption(o => o.setName("valor").setDescription("Valor a remover").setRequired(true).setMinValue(1)),
      )
      .addSubcommand(s =>
        s.setName("resetar")
          .setDescription("Resetar o dinheiro (carteira e banco) de um membro para 0")
          .addUserOption(o => o.setName("membro").setDescription("Membro alvo").setRequired(true)),
      ),
    async execute(interaction: ChatInputCommandInteraction) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: "❌ Apenas administradores podem usar este comando.", ephemeral: true });
      }

      const sub = interaction.options.getSubcommand();
      const target = interaction.options.getUser("membro", true);
      const player = await getOrCreatePlayer(target.id, target.username);

      if (sub === "dar") {
        const valor = interaction.options.getInteger("valor", true);
        await updatePlayer(player.discordId, { balance: player.balance + valor });
        await logTransaction("ADMIN", player.discordId, valor, "admin_give", `Adm ${interaction.user.username} deu dinheiro`);
        return interaction.reply({ content: `✅ Foi dado ${formatMoney(valor)} a **${target.username}**. Novo saldo: ${formatMoney(player.balance + valor)}` });
      }

      if (sub === "remover") {
        const valor = interaction.options.getInteger("valor", true);
        const removed = Math.min(valor, player.balance);
        await updatePlayer(player.discordId, { balance: player.balance - removed });
        await logTransaction(player.discordId, "ADMIN", removed, "admin_remove", `Adm ${interaction.user.username} removeu dinheiro`);
        return interaction.reply({ content: `✅ Removido ${formatMoney(removed)} de **${target.username}**. Novo saldo: ${formatMoney(player.balance - removed)}` });
      }

      if (sub === "resetar") {
        const total = player.balance + player.bankBalance;
        await updatePlayer(player.discordId, { balance: 0, bankBalance: 0 });
        await logTransaction(player.discordId, "ADMIN", total, "admin_reset", `Adm ${interaction.user.username} resetou dinheiro`);
        return interaction.reply({ content: `✅ Dinheiro de **${target.username}** foi resetado para ${formatMoney(0)} (carteira e banco).` });
      }
    },
  },
];
