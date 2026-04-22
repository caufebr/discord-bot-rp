import { SlashCommandBuilder, EmbedBuilder, type ChatInputCommandInteraction } from "discord.js";
import { getOrCreatePlayer, updatePlayer, removeMoney, formatMoney, isJailed } from "../systems/player.js";
import { PROFESSIONS, type ProfessionKey, cooldownLeft } from "../systems/economy.js";

const profList = Object.entries(PROFESSIONS);

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName("profissao")
      .setDescription("Sistema de profissões")
      .addSubcommand(s => s.setName("lista").setDescription("Ver todas as profissões"))
      .addSubcommand(s =>
        s.setName("curso").setDescription("Pagar curso para uma profissão")
          .addStringOption(o => o.setName("nome").setDescription("Nome da profissão").setRequired(true)
            .addChoices(...profList.map(([k, v]) => ({ name: `${v.emoji} ${v.name}`, value: k })))
          )
      )
      .addSubcommand(s => s.setName("treinar").setDescription("Concluir o treinamento"))
      .addSubcommand(s => s.setName("status").setDescription("Ver status da sua profissão")),

    async execute(interaction: ChatInputCommandInteraction) {
      const player = await getOrCreatePlayer(interaction.user.id, interaction.user.username);
      const sub = interaction.options.getSubcommand();

      if (sub === "lista") {
        const embed = new EmbedBuilder()
          .setTitle("💼 Profissões Disponíveis")
          .setColor(0xffaa00)
          .setDescription("Use `/profissao curso <nome>` para se inscrever");
        for (const [k, v] of profList) {
          embed.addFields({
            name: `${v.emoji} ${v.name}`,
            value: `💰 Salário: ${formatMoney(v.baseSalary)}/turno\n💸 Curso: ${formatMoney(v.courseCost)}\n⏱️ Treino: ${v.trainDays} dia(s)`,
            inline: true,
          });
        }
        return interaction.reply({ embeds: [embed] });
      }

      if (sub === "curso") {
        const profKey = interaction.options.getString("nome", true) as ProfessionKey;
        const prof = PROFESSIONS[profKey];
        if (!prof) return interaction.reply({ content: "❌ Profissão inválida.", ephemeral: true });
        if (player.profession === profKey && player.isCertified) return interaction.reply({ content: `✅ Você já é um ${prof.name} certificado!`, ephemeral: true });
        if (player.isTraining) return interaction.reply({ content: "❌ Você já está em treinamento!", ephemeral: true });

        if (player.balance < prof.courseCost) return interaction.reply({ content: `❌ Você precisa de ${formatMoney(prof.courseCost)} para o curso. Você tem ${formatMoney(player.balance)}.`, ephemeral: true });

        const success = await removeMoney(player.discordId, prof.courseCost);
        if (!success) return interaction.reply({ content: "❌ Saldo insuficiente.", ephemeral: true });

        const trainEnd = new Date(Date.now() + prof.trainDays * 24 * 60 * 60 * 1000);
        await updatePlayer(player.discordId, {
          profession: profKey,
          isTraining: true,
          trainingEnd: trainEnd,
          trainingFor: profKey,
          isCertified: false,
        });

        return interaction.reply({
          content: `📚 Você se inscreveu no curso de **${prof.name}**!\nPagou: ${formatMoney(prof.courseCost)}\nTreinamento termina: <t:${Math.floor(trainEnd.getTime() / 1000)}:R>\nUse \`/profissao treinar\` quando o tempo acabar!`,
        });
      }

      if (sub === "treinar") {
        if (!player.isTraining || !player.trainingEnd) return interaction.reply({ content: "❌ Você não está em treinamento.", ephemeral: true });
        if (new Date() < player.trainingEnd) {
          const left = player.trainingEnd.getTime() - Date.now();
          return interaction.reply({ content: `⏳ Treinamento termina em <t:${Math.floor(player.trainingEnd.getTime() / 1000)}:R>`, ephemeral: true });
        }

        const profKey = player.trainingFor as ProfessionKey;
        const prof = PROFESSIONS[profKey];
        await updatePlayer(player.discordId, {
          isTraining: false,
          trainingEnd: null,
          isCertified: true,
          profession: profKey,
          professionLevel: 1,
        });

        return interaction.reply({
          content: `🎓 **Parabéns!** Você concluiu o treinamento e agora é um **${prof.emoji} ${prof.name}** certificado!\nUse \`/salario\` a cada 8h para receber ${formatMoney(prof.baseSalary)}!`,
        });
      }

      if (sub === "status") {
        const embed = new EmbedBuilder().setTitle("🧑‍💼 Sua Carreira").setColor(0x9900ff);
        if (!player.profession) {
          embed.setDescription("Você não tem profissão ainda. Use `/profissao lista` para ver opções.");
        } else {
          const prof = PROFESSIONS[player.profession as ProfessionKey];
          embed.addFields(
            { name: "Profissão", value: `${prof.emoji} ${prof.name}`, inline: true },
            { name: "Status", value: player.isCertified ? "✅ Certificado" : player.isTraining ? "📚 Em treinamento" : "❌ Não certificado", inline: true },
          );
          if (player.isTraining && player.trainingEnd) {
            embed.addFields({ name: "Treino termina", value: `<t:${Math.floor(player.trainingEnd.getTime() / 1000)}:R>`, inline: true });
          }
        }
        return interaction.reply({ embeds: [embed] });
      }
    },
  },

  {
    data: new SlashCommandBuilder()
      .setName("curar")
      .setDescription("Médico: curar um jogador")
      .addUserOption(o => o.setName("jogador").setDescription("Jogador a curar").setRequired(true)),
    async execute(interaction: ChatInputCommandInteraction) {
      const doctor = await getOrCreatePlayer(interaction.user.id, interaction.user.username);
      if (doctor.profession !== "medico" || !doctor.isCertified) return interaction.reply({ content: "❌ Apenas médicos certificados podem curar.", ephemeral: true });

      const target = interaction.options.getUser("jogador", true);
      const targetPlayer = await getOrCreatePlayer(target.id, target.username);

      if (!targetPlayer.isHospitalized && targetPlayer.health >= 100) return interaction.reply({ content: "❌ Este jogador não precisa de cura.", ephemeral: true });

      await updatePlayer(target.id, { health: 100, isHospitalized: false, hospitalizationEnd: null });
      return interaction.reply({ content: `🏥 Dr. ${interaction.user.username} curou **${target.username}**! Saúde restaurada a 100%.` });
    },
  },

  {
    data: new SlashCommandBuilder()
      .setName("defender")
      .setDescription("Advogado: defender jogador preso")
      .addUserOption(o => o.setName("jogador").setDescription("Jogador para defender").setRequired(true)),
    async execute(interaction: ChatInputCommandInteraction) {
      const lawyer = await getOrCreatePlayer(interaction.user.id, interaction.user.username);
      if (lawyer.profession !== "advogado" || !lawyer.isCertified) return interaction.reply({ content: "❌ Apenas advogados certificados podem defender.", ephemeral: true });

      const target = interaction.options.getUser("jogador", true);
      const targetPlayer = await getOrCreatePlayer(target.id, target.username);

      if (!targetPlayer.isJailed) return interaction.reply({ content: "❌ Este jogador não está preso.", ephemeral: true });

      const success = Math.random() > 0.3;
      if (success) {
        await updatePlayer(target.id, { isJailed: false, jailEnd: null });
        return interaction.reply({ content: `⚖️ **${interaction.user.username}** conseguiu liberar **${target.username}** da prisão!` });
      } else {
        return interaction.reply({ content: `⚖️ **${interaction.user.username}** tentou defender **${target.username}**, mas perdeu o caso!` });
      }
    },
  },
];
