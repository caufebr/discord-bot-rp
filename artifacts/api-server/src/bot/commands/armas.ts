import { SlashCommandBuilder, EmbedBuilder, type ChatInputCommandInteraction } from "discord.js";
import { getOrCreatePlayer, updatePlayer, removeMoney, killPlayer, formatMoney, isDead, isJailed, isHospitalized } from "../systems/player.js";
import { WEAPONS } from "../systems/shop.js";

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName("armas")
      .setDescription("Loja de armas e gerenciamento")
      .addSubcommand(s => s.setName("loja").setDescription("Ver armas à venda"))
      .addSubcommand(s => s.setName("comprar").setDescription("Comprar uma arma")
        .addStringOption(o => o.setName("arma").setDescription("Arma").setRequired(true)
          .addChoices(...Object.values(WEAPONS).map(w => ({ name: `${w.emoji} ${w.name}`, value: w.key })))))
      .addSubcommand(s => s.setName("vender").setDescription("Vender sua arma equipada (50% do valor)"))
      .addSubcommand(s => s.setName("equipada").setDescription("Ver sua arma atual")),
    async execute(interaction: ChatInputCommandInteraction) {
      const player = await getOrCreatePlayer(interaction.user.id, interaction.user.username);
      const sub = interaction.options.getSubcommand();

      if (sub === "loja") {
        const embed = new EmbedBuilder().setTitle("🔫 Loja de Armas").setColor(0x222222)
          .setDescription("⚠️ Armas dão dano em duelos. Cuidado: morrer faz você perder TODO o dinheiro.");
        for (const w of Object.values(WEAPONS)) {
          embed.addFields({ name: `${w.emoji} ${w.name}`, value: `${w.description}\n💰 ${formatMoney(w.price)} | 💥 Dano: ${w.damage}`, inline: false });
        }
        return interaction.reply({ embeds: [embed], ephemeral: true });
      }

      if (sub === "comprar") {
        const key = interaction.options.getString("arma", true);
        const w = WEAPONS[key];
        if (!w) return interaction.reply({ content: "❌ Arma inválida.", ephemeral: true });
        if (player.balance < w.price) return interaction.reply({ content: `❌ Você precisa de ${formatMoney(w.price)}.`, ephemeral: true });
        await removeMoney(player.discordId, w.price);
        await updatePlayer(player.discordId, { weapon: w.key });
        return interaction.reply({ content: `✅ Comprou ${w.emoji} **${w.name}** por ${formatMoney(w.price)}!`, ephemeral: true });
      }

      if (sub === "vender") {
        if (!player.weapon) return interaction.reply({ content: "❌ Você não tem arma equipada.", ephemeral: true });
        const w = WEAPONS[player.weapon];
        if (!w) { await updatePlayer(player.discordId, { weapon: null }); return interaction.reply({ content: "❌ Arma inválida.", ephemeral: true }); }
        const refund = Math.floor(w.price * 0.5);
        await updatePlayer(player.discordId, { weapon: null, balance: player.balance + refund });
        return interaction.reply({ content: `💰 Vendeu ${w.emoji} ${w.name} por ${formatMoney(refund)}.`, ephemeral: true });
      }

      if (sub === "equipada") {
        if (!player.weapon) return interaction.reply({ content: "🔫 Nenhuma arma equipada. Vá em `/armas loja`.", ephemeral: true });
        const w = WEAPONS[player.weapon];
        return interaction.reply({ content: `🔫 Arma equipada: ${w?.emoji} **${w?.name}** (Dano: ${w?.damage})`, ephemeral: true });
      }
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName("duelar")
      .setDescription("Desafiar um jogador para um duelo (com armas, pode resultar em morte!)")
      .addUserOption(o => o.setName("jogador").setDescription("Alvo").setRequired(true)),
    async execute(interaction: ChatInputCommandInteraction) {
      const attacker = await getOrCreatePlayer(interaction.user.id, interaction.user.username);
      const target = interaction.options.getUser("jogador", true);
      if (target.id === attacker.discordId) return interaction.reply({ content: "❌ Não dá para duelar consigo mesmo.", ephemeral: true });
      if (target.bot) return interaction.reply({ content: "❌ Bots não duelam.", ephemeral: true });

      const defender = await getOrCreatePlayer(target.id, target.username);
      if (isDead(attacker) || isJailed(attacker) || isHospitalized(attacker)) return interaction.reply({ content: "❌ Você não está em condições de duelar.", ephemeral: true });
      if (isDead(defender) || isJailed(defender) || isHospitalized(defender)) return interaction.reply({ content: "❌ O alvo não está disponível para duelo.", ephemeral: true });

      const aWeapon = attacker.weapon ? WEAPONS[attacker.weapon] : null;
      const dWeapon = defender.weapon ? WEAPONS[defender.weapon] : null;
      const aDamage = (aWeapon?.damage ?? 10) + Math.floor(Math.random() * 20);
      const dDamage = (dWeapon?.damage ?? 10) + Math.floor(Math.random() * 20);

      // Both take damage simultaneously
      const aHealth = Math.max(0, attacker.health - dDamage);
      const dHealth = Math.max(0, defender.health - aDamage);

      const lines: string[] = [
        `⚔️ **${attacker.username}** ${aWeapon ? `usando ${aWeapon.emoji} ${aWeapon.name}` : "com as próprias mãos"} causou **${aDamage}** de dano!`,
        `⚔️ **${defender.username}** ${dWeapon ? `usando ${dWeapon.emoji} ${dWeapon.name}` : "com as próprias mãos"} causou **${dDamage}** de dano!`,
      ];

      const deaths: string[] = [];
      if (aHealth <= 0) {
        const r = await killPlayer(attacker.discordId, `morto em duelo por ${defender.username}`);
        deaths.push(`💀 **${attacker.username}** morreu! Perdeu ${formatMoney(r.lostMoney)} (mas mantém certificações).`);
      } else {
        await updatePlayer(attacker.discordId, { health: aHealth });
      }
      if (dHealth <= 0) {
        const r = await killPlayer(defender.discordId, `morto em duelo por ${attacker.username}`);
        deaths.push(`💀 **${defender.username}** morreu! Perdeu ${formatMoney(r.lostMoney)} (mas mantém certificações).`);
      } else {
        await updatePlayer(defender.discordId, { health: dHealth });
      }

      const embed = new EmbedBuilder()
        .setTitle(`⚔️ Duelo: ${attacker.username} vs ${defender.username}`)
        .setColor(deaths.length > 0 ? 0xff0000 : 0xff8800)
        .setDescription(lines.join("\n") + (deaths.length > 0 ? `\n\n${deaths.join("\n")}` : ""))
        .addFields(
          { name: `❤️ ${attacker.username}`, value: `${aHealth}/100`, inline: true },
          { name: `❤️ ${defender.username}`, value: `${dHealth}/100`, inline: true },
        )
        .setFooter({ text: "💡 Mortes não podem ser roubadas — você só perde o dinheiro." });

      return interaction.reply({ embeds: [embed] });
    },
  },
];
