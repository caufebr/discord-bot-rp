import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, type ChatInputCommandInteraction } from "discord.js";
import { getOrCreatePlayer, updatePlayer, isJailed } from "../systems/player.js";

interface QA { q: string; opts: string[]; correct: number; }

const QUESTIONS: QA[] = [
  { q: "Qual é a capital do estado do Pará?", opts: ["Manaus", "Belém", "São Luís", "Macapá"], correct: 1 },
  { q: "Quem escreveu 'Memórias Póstumas de Brás Cubas'?", opts: ["José de Alencar", "Machado de Assis", "Clarice Lispector", "Carlos Drummond"], correct: 1 },
  { q: "Em que ano o Brasil foi descoberto?", opts: ["1492", "1500", "1504", "1488"], correct: 1 },
  { q: "Qual a fórmula química da água?", opts: ["H2O", "CO2", "O2", "NaCl"], correct: 0 },
  { q: "Quantos planetas tem o sistema solar?", opts: ["7", "8", "9", "10"], correct: 1 },
  { q: "Capital da Austrália?", opts: ["Sydney", "Melbourne", "Camberra", "Perth"], correct: 2 },
  { q: "Quem pintou a Mona Lisa?", opts: ["Van Gogh", "Picasso", "Da Vinci", "Monet"], correct: 2 },
  { q: "Qual o maior rio do mundo em volume?", opts: ["Nilo", "Amazonas", "Yangtzé", "Mississippi"], correct: 1 },
  { q: "Quantos lados tem um hexágono?", opts: ["5", "6", "7", "8"], correct: 1 },
  { q: "Em que continente fica o Egito?", opts: ["Ásia", "Europa", "África", "Oceania"], correct: 2 },
  { q: "Qual elemento químico tem o símbolo Au?", opts: ["Prata", "Ouro", "Cobre", "Alumínio"], correct: 1 },
  { q: "Capital do estado de Minas Gerais?", opts: ["Belo Horizonte", "Vitória", "Curitiba", "Salvador"], correct: 0 },
];

export const commands = [
  {
    data: new SlashCommandBuilder().setName("fugir").setDescription("Tentar fugir da prisão respondendo perguntas difíceis"),
    async execute(interaction: ChatInputCommandInteraction) {
      const player = await getOrCreatePlayer(interaction.user.id, interaction.user.username);
      if (!isJailed(player)) return interaction.reply({ content: "❌ Você não está preso.", ephemeral: true });

      const q = QUESTIONS[Math.floor(Math.random() * QUESTIONS.length)];
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        ...q.opts.map((opt, i) => new ButtonBuilder().setCustomId(`fugir_${i}`).setLabel(opt.slice(0, 80)).setStyle(ButtonStyle.Primary))
      );

      const embed = new EmbedBuilder()
        .setTitle("🔓 Tentativa de fuga — responda corretamente!")
        .setColor(0xffaa00)
        .setDescription(`**${q.q}**\n\n⚠️ Errar mantém você preso. Acertar reduz 30 minutos da pena.`);

      const reply = await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
      try {
        const click = await reply.awaitMessageComponent({ componentType: ComponentType.Button, time: 30_000, filter: i => i.user.id === player.discordId });
        const chosen = parseInt(click.customId.replace("fugir_", ""), 10);
        if (chosen === q.correct) {
          const newEnd = player.jailEnd ? new Date(player.jailEnd.getTime() - 30 * 60 * 1000) : new Date();
          if (newEnd.getTime() <= Date.now()) {
            await updatePlayer(player.discordId, { isJailed: false, jailEnd: null });
            await click.update({ content: "🎉 **VOCÊ FUGIU!** Resposta correta e tempo zerado.", embeds: [], components: [] });
          } else {
            await updatePlayer(player.discordId, { jailEnd: newEnd });
            await click.update({ content: `✅ Acertou! 30 minutos reduzidos. Saída: <t:${Math.floor(newEnd.getTime() / 1000)}:R>`, embeds: [], components: [] });
          }
        } else {
          await click.update({ content: `❌ Errou! A resposta era **${q.opts[q.correct]}**. Continua preso.`, embeds: [], components: [] });
        }
      } catch {
        await interaction.editReply({ content: "⏰ Tempo esgotado. Você continua preso.", embeds: [], components: [] });
      }
    },
  },
];
