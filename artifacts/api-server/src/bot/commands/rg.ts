import { SlashCommandBuilder, EmbedBuilder, type ChatInputCommandInteraction } from "discord.js";
import { getOrCreatePlayer, updatePlayer, formatMoney } from "../systems/player.js";
import { BR_STATES, POLITICAL_SIDES, GENDERS } from "../systems/shop.js";

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName("perfil")
      .setDescription("Criar/editar seu RG (estado, cidade, gênero, política)")
      .addStringOption(o => o.setName("estado").setDescription("Sigla do estado (ex: SP, RJ, MG, BA, CE)").setRequired(true).setMinLength(2).setMaxLength(2))
      .addStringOption(o => o.setName("cidade").setDescription("Nome da cidade").setRequired(true))
      .addStringOption(o => o.setName("genero").setDescription("Gênero").setRequired(true)
        .addChoices(...GENDERS.map(g => ({ name: g, value: g }))))
      .addStringOption(o => o.setName("politica").setDescription("Lado político").setRequired(true)
        .addChoices(...POLITICAL_SIDES.map(p => ({ name: p, value: p })))),
    async execute(interaction: ChatInputCommandInteraction) {
      const player = await getOrCreatePlayer(interaction.user.id, interaction.user.username);
      const estado = interaction.options.getString("estado", true).toUpperCase();
      if (!BR_STATES[estado]) return interaction.reply({ content: `❌ Estado **${estado}** inválido. Use a sigla (ex: SP, RJ, MG, BA, CE, RS, PR, PE, GO, AM...).`, ephemeral: true });
      const cidade = interaction.options.getString("cidade", true);
      const genero = interaction.options.getString("genero", true);
      const politica = interaction.options.getString("politica", true);

      const cities = BR_STATES[estado] ?? [];
      const matched = cities.find(c => c.toLowerCase() === cidade.toLowerCase()) ?? cidade;

      await updatePlayer(player.discordId, {
        state: estado,
        city: matched,
        gender: genero,
        politicalSide: politica,
        rgCreatedAt: player.rgCreatedAt ?? new Date(),
      });

      return interaction.reply({ content: `🪪 RG ${player.rgCreatedAt ? "atualizado" : "criado"}! Use \`/rg\` para ver.`, ephemeral: true });
    },
  },
  {
    data: new SlashCommandBuilder().setName("rg").setDescription("Ver seu RG / ficha de personagem")
      .addUserOption(o => o.setName("jogador").setDescription("Ver RG de outro jogador")),
    async execute(interaction: ChatInputCommandInteraction) {
      const target = interaction.options.getUser("jogador") ?? interaction.user;
      const p = await getOrCreatePlayer(target.id, target.username);

      if (!p.state) {
        return interaction.reply({
          content: target.id === interaction.user.id
            ? "🪪 Você ainda não criou seu RG. Use `/perfil` para começar."
            : `🪪 **${target.username}** ainda não criou o RG.`,
          ephemeral: true,
        });
      }

      const cities = BR_STATES[p.state] ?? [];
      const cityList = cities.length > 0 ? `\n*Cidades disponíveis em ${p.state}:* ${cities.slice(0, 5).join(", ")}` : "";

      const embed = new EmbedBuilder()
        .setTitle(`🪪 RG — ${target.username}`)
        .setColor(0x4488cc)
        .setThumbnail(target.displayAvatarURL())
        .addFields(
          { name: "📍 Estado", value: p.state, inline: true },
          { name: "🏙️ Cidade", value: p.city ?? "—", inline: true },
          { name: "⚧ Gênero", value: p.gender ?? "—", inline: true },
          { name: "🗳️ Lado Político", value: p.politicalSide ?? "—", inline: true },
          { name: "💼 Profissão", value: p.profession ?? "Desempregado", inline: true },
          { name: "🏴‍☠️ Gangue", value: p.gangId ? `Sim (${p.gangRank})` : "Não", inline: true },
          { name: "💍 Estado civil", value: p.partnerId ? `Casado(a) com <@${p.partnerId}>` : "Solteiro(a)", inline: true },
          { name: "🎓 Certificações", value: (p.certifications && p.certifications.length > 0) ? p.certifications.join(", ") : "Nenhuma", inline: false },
          { name: "⭐ Reputação", value: `${p.reputation}`, inline: true },
          { name: "❤️ Saúde", value: `${p.health}/${p.maxHealth}`, inline: true },
          { name: "⚡ Energia", value: `${p.energy}/100`, inline: true },
        )
        .setFooter({ text: `RG emitido em ${(p.rgCreatedAt ?? p.createdAt).toLocaleDateString("pt-BR")}` });

      return interaction.reply({ embeds: [embed] });
    },
  },
  {
    data: new SlashCommandBuilder().setName("mochila").setDescription("Ver os itens da sua mochila"),
    async execute(interaction: ChatInputCommandInteraction) {
      const p = await getOrCreatePlayer(interaction.user.id, interaction.user.username);
      const inv = p.inventory ?? {};
      const { SHOP_ITEMS } = await import("../systems/shop.js");
      const entries = Object.entries(inv).filter(([, q]) => q > 0);

      const embed = new EmbedBuilder()
        .setTitle(`🎒 Mochila — ${interaction.user.username}`)
        .setColor(0x885500);

      if (entries.length === 0) {
        embed.setDescription("Mochila vazia. Compre algo na `/loja`.");
      } else {
        const lines = entries.map(([k, q]) => {
          const item = (SHOP_ITEMS as any)[k];
          if (item) return `${item.emoji} **${item.name}** × ${q}`;
          return `📦 ${k} × ${q}`;
        });
        embed.setDescription(lines.join("\n"));
      }

      embed.addFields(
        { name: "🔫 Arma equipada", value: p.weapon ?? "Nenhuma", inline: true },
        { name: "💰 Dinheiro", value: formatMoney(p.balance), inline: true },
        { name: "🏦 Banco", value: formatMoney(p.bankBalance), inline: true },
      );

      return interaction.reply({ embeds: [embed], ephemeral: true });
    },
  },
];
