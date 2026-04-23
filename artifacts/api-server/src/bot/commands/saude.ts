import { SlashCommandBuilder, EmbedBuilder, type ChatInputCommandInteraction } from "discord.js";
import { getOrCreatePlayer, updatePlayer, removeMoney, formatMoney, isHospitalized, isDead } from "../systems/player.js";
import { logTransaction } from "../systems/economy.js";

const HOSPITAL_COST = 500;
const INSURANCE_COST = 2000;
const INSURANCE_DURATION = 7 * 24 * 60 * 60 * 1000;

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName("saude")
      .setDescription("Ver sua saúde atual"),
    async execute(interaction: ChatInputCommandInteraction) {
      const player = await getOrCreatePlayer(interaction.user.id, interaction.user.username);
      const embed = new EmbedBuilder()
        .setTitle("❤️ Status de Saúde")
        .setColor(player.health > 60 ? 0x00ff00 : player.health > 30 ? 0xffaa00 : 0xff0000)
        .addFields(
          { name: "❤️ HP", value: `${player.health}/${player.maxHealth}`, inline: true },
          { name: "🏥 Hospitalizado", value: isHospitalized(player) ? `Sim (até <t:${Math.floor((player.hospitalizationEnd?.getTime() ?? 0) / 1000)}:R>)` : "Não", inline: true },
          { name: "💀 Morto", value: isDead(player) ? `Sim (ressurge <t:${Math.floor((player.deathEnd?.getTime() ?? 0) / 1000)}:R>)` : "Não", inline: true },
          { name: "🛡️ Seguro de vida", value: player.insurance ? "✅ Ativo" : "❌ Inativo", inline: true },
        );
      return interaction.reply({ embeds: [embed] });
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName("hospital")
      .setDescription("Ir ao hospital para se curar")
      .addSubcommand(s => s.setName("tratar").setDescription(`Tratar-se no hospital (${formatMoney(HOSPITAL_COST)})`))
      .addSubcommand(s => s.setName("seguro").setDescription(`Comprar seguro de vida (${formatMoney(INSURANCE_COST)}/semana)`)),
    async execute(interaction: ChatInputCommandInteraction) {
      const player = await getOrCreatePlayer(interaction.user.id, interaction.user.username);
      const sub = interaction.options.getSubcommand();

      if (sub === "tratar") {
        if (player.health >= 100 && !isHospitalized(player)) return interaction.reply({ content: "✅ Você está com saúde plena!", ephemeral: true });
        if (isDead(player)) return interaction.reply({ content: "❌ Você está morto. Aguarde ressurreição.", ephemeral: true });

        const cost = player.insurance ? 0 : HOSPITAL_COST;
        if (cost > 0 && player.balance < cost) return interaction.reply({ content: `❌ Tratamento custa ${formatMoney(cost)}. Você tem ${formatMoney(player.balance)}.`, ephemeral: true });

        if (cost > 0) await removeMoney(player.discordId, cost);
        await updatePlayer(player.discordId, { health: 100, isHospitalized: false, hospitalizationEnd: null });

        return interaction.reply({ content: `🏥 Você foi tratado no hospital! Saúde restaurada.${cost > 0 ? ` Custo: ${formatMoney(cost)}` : " (Seguro de vida cobriu!)"} ` });
      }

      if (sub === "seguro") {
        if (player.balance < INSURANCE_COST) return interaction.reply({ content: `❌ Seguro custa ${formatMoney(INSURANCE_COST)}.`, ephemeral: true });
        await removeMoney(player.discordId, INSURANCE_COST);
        const insuranceEnd = new Date(Date.now() + INSURANCE_DURATION);
        await updatePlayer(player.discordId, { insurance: true, insuranceEnd });
        return interaction.reply({ content: `🛡️ Seguro de vida ativado por 1 semana! Válido até: <t:${Math.floor(insuranceEnd.getTime() / 1000)}:R>` });
      }
    },
  },
];
