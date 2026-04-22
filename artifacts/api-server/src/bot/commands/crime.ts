import { SlashCommandBuilder, EmbedBuilder, type ChatInputCommandInteraction } from "discord.js";
import { getOrCreatePlayer, updatePlayer, removeMoney, formatMoney, isJailed, isHospitalized, isDead } from "../systems/player.js";
import { logTransaction, cooldownLeft, formatCooldown } from "../systems/economy.js";

const ROB_COOLDOWN = 30 * 60 * 1000; // 30min
const CRIME_COOLDOWN = 45 * 60 * 1000; // 45min

const CRIMES = [
  { name: "Furto simples", risk: 0.25, minGain: 200, maxGain: 800, jailTime: 10, wantedIncrease: 1 },
  { name: "Roubo a pedestres", risk: 0.35, minGain: 500, maxGain: 1500, jailTime: 20, wantedIncrease: 2 },
  { name: "Roubo a estabelecimento", risk: 0.45, minGain: 1000, maxGain: 3000, jailTime: 30, wantedIncrease: 3 },
  { name: "Tráfico", risk: 0.5, minGain: 2000, maxGain: 6000, jailTime: 60, wantedIncrease: 4 },
  { name: "Assalto a banco", risk: 0.7, minGain: 5000, maxGain: 15000, jailTime: 120, wantedIncrease: 5 },
];

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName("crime")
      .setDescription("Cometer um crime")
      .addIntegerOption(o =>
        o.setName("tipo").setDescription("Tipo de crime").setRequired(true)
          .addChoices(
            { name: "1. Furto simples", value: 0 },
            { name: "2. Roubo a pedestres", value: 1 },
            { name: "3. Roubo a estabelecimento", value: 2 },
            { name: "4. Tráfico", value: 3 },
            { name: "5. Assalto a banco", value: 4 },
          )
      ),
    async execute(interaction: ChatInputCommandInteraction) {
      const player = await getOrCreatePlayer(interaction.user.id, interaction.user.username);
      if (isJailed(player)) return interaction.reply({ content: "❌ Você está preso! Use `/ficha` para ver quanto tempo falta.", ephemeral: true });
      if (isHospitalized(player)) return interaction.reply({ content: "❌ Você está hospitalizado!", ephemeral: true });
      if (isDead(player)) return interaction.reply({ content: "❌ Você está morto!", ephemeral: true });

      const cd = cooldownLeft(player.lastCrime, CRIME_COOLDOWN);
      if (cd > 0) return interaction.reply({ content: `⏳ Aguarde ${formatCooldown(cd)} antes de cometer outro crime. Planejamento é necessário!`, ephemeral: true });

      const idx = interaction.options.getInteger("tipo", true);
      const crime = CRIMES[idx];
      const baseRisk = crime.risk;
      const wantedBonus = player.wantedLevel * 0.05;
      const finalRisk = Math.min(0.95, baseRisk + wantedBonus);

      const caught = Math.random() < finalRisk;

      await updatePlayer(player.discordId, { lastCrime: new Date() });

      if (caught) {
        const jailEnd = new Date(Date.now() + crime.jailTime * 60 * 1000);
        const newWanted = Math.min(10, player.wantedLevel + crime.wantedIncrease);
        await updatePlayer(player.discordId, {
          isJailed: true,
          jailEnd,
          wantedLevel: newWanted,
          criminalRecord: player.criminalRecord + 1,
        });

        return interaction.reply({
          content: `🚔 **Foste pego!**\nCrime: ${crime.name}\nPrisão por: ${crime.jailTime} minutos\nSolto: <t:${Math.floor(jailEnd.getTime() / 1000)}:R>\nNível de procurado: ${"⭐".repeat(newWanted)}`,
        });
      }

      const gain = Math.floor(Math.random() * (crime.maxGain - crime.minGain) + crime.minGain);
      const newWanted = Math.max(0, player.wantedLevel + 1);
      await updatePlayer(player.discordId, {
        balance: player.balance + gain,
        wantedLevel: newWanted,
        criminalRecord: player.criminalRecord + 1,
      });
      await logTransaction(null, player.discordId, gain, "crime", crime.name);

      return interaction.reply({
        content: `🦹 **${crime.name} bem-sucedido!**\nGanhou: ${formatMoney(gain)}\nNível de procurado: ${"⭐".repeat(newWanted)}`,
      });
    },
  },

  {
    data: new SlashCommandBuilder()
      .setName("assaltar")
      .setDescription("Assaltar outro jogador")
      .addUserOption(o => o.setName("vitima").setDescription("Jogador a assaltar").setRequired(true)),
    async execute(interaction: ChatInputCommandInteraction) {
      const player = await getOrCreatePlayer(interaction.user.id, interaction.user.username);
      if (isJailed(player)) return interaction.reply({ content: "❌ Você está preso!", ephemeral: true });
      if (isDead(player)) return interaction.reply({ content: "❌ Você está morto!", ephemeral: true });

      const cd = cooldownLeft(player.lastRob, ROB_COOLDOWN);
      if (cd > 0) return interaction.reply({ content: `⏳ Aguarde ${formatCooldown(cd)} para assaltar novamente.`, ephemeral: true });

      const target = interaction.options.getUser("vitima", true);
      if (target.id === interaction.user.id) return interaction.reply({ content: "❌ Não pode assaltar a si mesmo.", ephemeral: true });

      const victim = await getOrCreatePlayer(target.id, target.username);
      await updatePlayer(player.discordId, { lastRob: new Date() });

      const risk = 0.4 + player.wantedLevel * 0.03;
      const caught = Math.random() < risk;

      if (caught) {
        const jailEnd = new Date(Date.now() + 15 * 60 * 1000);
        await updatePlayer(player.discordId, { isJailed: true, jailEnd, wantedLevel: Math.min(10, player.wantedLevel + 2) });
        return interaction.reply({ content: `🚔 Você tentou assaltar **${target.username}** mas foi preso! Solto: <t:${Math.floor(jailEnd.getTime() / 1000)}:R>` });
      }

      if (victim.balance <= 0) return interaction.reply({ content: `💨 **${target.username}** não tinha dinheiro algum para roubar!` });

      const stolen = Math.floor(victim.balance * (Math.random() * 0.3 + 0.1));
      await updatePlayer(target.id, { balance: Math.max(0, victim.balance - stolen) });
      await updatePlayer(player.discordId, { balance: player.balance + stolen, wantedLevel: Math.min(10, player.wantedLevel + 1) });
      await logTransaction(target.id, player.discordId, stolen, "rob", `Assalto de ${interaction.user.username}`);

      return interaction.reply({ content: `🔫 **${interaction.user.username}** assaltou **${target.username}** e roubou ${formatMoney(stolen)}!` });
    },
  },

  {
    data: new SlashCommandBuilder().setName("ficha").setDescription("Ver sua ficha criminal"),
    async execute(interaction: ChatInputCommandInteraction) {
      const player = await getOrCreatePlayer(interaction.user.id, interaction.user.username);
      const embed = new EmbedBuilder()
        .setTitle("🗂️ Ficha Criminal")
        .setColor(player.isJailed ? 0xff0000 : 0x888888)
        .addFields(
          { name: "📋 Crimes cometidos", value: `${player.criminalRecord}`, inline: true },
          { name: "⭐ Nível procurado", value: player.wantedLevel > 0 ? "⭐".repeat(player.wantedLevel) : "Nenhum", inline: true },
          { name: "⚠️ Status", value: isJailed(player) ? `🔒 Preso até <t:${Math.floor((player.jailEnd?.getTime() ?? 0) / 1000)}:R>` : "✅ Livre", inline: false },
        );
      return interaction.reply({ embeds: [embed] });
    },
  },

  {
    data: new SlashCommandBuilder()
      .setName("prender")
      .setDescription("Policial: prender um jogador")
      .addUserOption(o => o.setName("suspeito").setDescription("Jogador a prender").setRequired(true))
      .addIntegerOption(o => o.setName("minutos").setDescription("Tempo de prisão (1-120)").setRequired(true)),
    async execute(interaction: ChatInputCommandInteraction) {
      const officer = await getOrCreatePlayer(interaction.user.id, interaction.user.username);
      if (officer.profession !== "policial" || !officer.isCertified) return interaction.reply({ content: "❌ Apenas policiais certificados podem prender.", ephemeral: true });

      const target = interaction.options.getUser("suspeito", true);
      const minutes = Math.max(1, Math.min(120, interaction.options.getInteger("minutos", true)));
      const suspect = await getOrCreatePlayer(target.id, target.username);

      if (suspect.isJailed) return interaction.reply({ content: "❌ Este jogador já está preso.", ephemeral: true });

      const jailEnd = new Date(Date.now() + minutes * 60 * 1000);
      await updatePlayer(target.id, { isJailed: true, jailEnd, wantedLevel: Math.max(0, suspect.wantedLevel - 1) });

      return interaction.reply({ content: `👮 **${interaction.user.username}** prendeu **${target.username}** por ${minutes} minutos! Solto: <t:${Math.floor(jailEnd.getTime() / 1000)}:R>` });
    },
  },
];
