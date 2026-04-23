import { SlashCommandBuilder, EmbedBuilder, type ChatInputCommandInteraction } from "discord.js";
import { getOrCreatePlayer, getPlayer, updatePlayer, removeMoney, formatMoney, isJailed, isHospitalized, isDead } from "../systems/player.js";
import { getEconomy, logTransaction, cooldownLeft, formatCooldown, applyTax } from "../systems/economy.js";

const WORK_COOLDOWN = 60 * 60 * 1000; // 1h

export const commands = [
  {
    data: new SlashCommandBuilder().setName("saldo").setDescription("Ver seu saldo atual"),
    async execute(interaction: ChatInputCommandInteraction) {
      const player = await getOrCreatePlayer(interaction.user.id, interaction.user.username);
      const eco = await getEconomy();
      const embed = new EmbedBuilder()
        .setTitle("💰 Carteira")
        .setColor(0x00ff88)
        .addFields(
          { name: "💵 Dinheiro em mãos", value: formatMoney(player.balance), inline: true },
          { name: "🏦 No banco", value: formatMoney(player.bankBalance), inline: true },
          { name: "📊 Inflação atual", value: `${((eco.inflation - 1) * 100).toFixed(1)}%`, inline: true },
        )
        .setFooter({ text: `Jogador: ${interaction.user.username}` })
        .setTimestamp();
      await interaction.reply({ embeds: [embed] });
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName("banco")
      .setDescription("Operações bancárias")
      .addSubcommand(s => s.setName("depositar").setDescription("Depositar dinheiro").addIntegerOption(o => o.setName("valor").setDescription("Valor a depositar").setRequired(true)))
      .addSubcommand(s => s.setName("sacar").setDescription("Sacar dinheiro").addIntegerOption(o => o.setName("valor").setDescription("Valor a sacar").setRequired(true)))
      .addSubcommand(s => s.setName("saldo").setDescription("Ver saldo bancário")),
    async execute(interaction: ChatInputCommandInteraction) {
      const player = await getOrCreatePlayer(interaction.user.id, interaction.user.username);
      const sub = interaction.options.getSubcommand();
      const eco = await getEconomy();

      if (sub === "saldo") {
        const embed = new EmbedBuilder().setTitle("🏦 Banco").setColor(0x0099ff)
          .addFields(
            { name: "💵 Em mãos", value: formatMoney(player.balance), inline: true },
            { name: "🏦 No banco", value: formatMoney(player.bankBalance), inline: true },
            { name: "💸 Taxa bancária", value: `${(eco.bankTaxRate * 100).toFixed(1)}% ao dia`, inline: true },
          );
        return interaction.reply({ embeds: [embed] });
      }

      const valor = interaction.options.getInteger("valor", true);
      if (valor <= 0) return interaction.reply({ content: "❌ Valor inválido.", ephemeral: true });

      if (sub === "depositar") {
        if (player.balance < valor) return interaction.reply({ content: "❌ Saldo insuficiente.", ephemeral: true });
        await updatePlayer(player.discordId, { balance: player.balance - valor, bankBalance: player.bankBalance + valor });
        await logTransaction(player.discordId, "BANK", valor, "deposit", "Depósito bancário");
        return interaction.reply({ content: `✅ ${formatMoney(valor)} depositado no banco!` });
      }

      if (sub === "sacar") {
        if (player.bankBalance < valor) return interaction.reply({ content: "❌ Saldo bancário insuficiente.", ephemeral: true });
        const tax = Math.floor(valor * eco.bankTaxRate);
        const net = valor - tax;
        await updatePlayer(player.discordId, { balance: player.balance + net, bankBalance: player.bankBalance - valor });
        await logTransaction("BANK", player.discordId, net, "withdraw", `Saque com taxa de ${formatMoney(tax)}`);
        return interaction.reply({ content: `✅ Sacou ${formatMoney(valor)} (taxa: ${formatMoney(tax)}) → Recebeu ${formatMoney(net)}` });
      }
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName("transferir")
      .setDescription("Transferir dinheiro para outro jogador")
      .addUserOption(o => o.setName("usuario").setDescription("Para quem transferir").setRequired(true))
      .addIntegerOption(o => o.setName("valor").setDescription("Valor").setRequired(true)),
    async execute(interaction: ChatInputCommandInteraction) {
      const player = await getOrCreatePlayer(interaction.user.id, interaction.user.username);
      const target = interaction.options.getUser("usuario", true);
      const valor = interaction.options.getInteger("valor", true);

      if (target.id === interaction.user.id) return interaction.reply({ content: "❌ Não pode transferir para si mesmo.", ephemeral: true });
      if (valor <= 0) return interaction.reply({ content: "❌ Valor inválido.", ephemeral: true });
      if (player.balance < valor) return interaction.reply({ content: "❌ Saldo insuficiente.", ephemeral: true });

      const eco = await getEconomy();
      const tax = Math.floor(valor * eco.taxRate);
      const net = valor - tax;

      const targetPlayer = await getOrCreatePlayer(target.id, target.username);
      await updatePlayer(player.discordId, { balance: player.balance - valor });
      await updatePlayer(targetPlayer.discordId, { balance: targetPlayer.balance + net });
      await logTransaction(player.discordId, target.id, net, "transfer", `Transferência (imposto: ${formatMoney(tax)})`);

      return interaction.reply({ content: `✅ Transferiu ${formatMoney(valor)} para ${target.username}! (imposto: ${formatMoney(tax)}, recebeu: ${formatMoney(net)})` });
    },
  },
  {
    data: new SlashCommandBuilder().setName("trabalhar").setDescription("Fazer um bico (sem profissão)"),
    async execute(interaction: ChatInputCommandInteraction) {
      const player = await getOrCreatePlayer(interaction.user.id, interaction.user.username);
      if (isJailed(player)) return interaction.reply({ content: "❌ Você está preso!", ephemeral: true });
      if (isHospitalized(player)) return interaction.reply({ content: "❌ Você está hospitalizado!", ephemeral: true });
      if (isDead(player)) return interaction.reply({ content: "❌ Você está morto!", ephemeral: true });

      const cd = cooldownLeft(player.lastWork, WORK_COOLDOWN);
      if (cd > 0) return interaction.reply({ content: `⏳ Aguarde ${formatCooldown(cd)} para trabalhar novamente.`, ephemeral: true });

      const eco = await getEconomy();
      const base = Math.floor(Math.random() * 300 + 100);
      const amount = Math.floor(await applyTax(base));
      await updatePlayer(player.discordId, { balance: player.balance + amount, lastWork: new Date() });
      await logTransaction(null, player.discordId, amount, "work", "Bico");

      return interaction.reply({ content: `💼 Você fez um bico e ganhou ${formatMoney(amount)} (após impostos)!` });
    },
  },
];
