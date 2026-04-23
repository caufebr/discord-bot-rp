import { SlashCommandBuilder, EmbedBuilder, type ChatInputCommandInteraction } from "discord.js";
import { eq, and, sql } from "drizzle-orm";
import { db, schema } from "../systems/db.js";
import { getOrCreatePlayer, updatePlayer, removeMoney, formatMoney, isJailed } from "../systems/player.js";
import { cooldownLeft, formatCooldown } from "../systems/economy.js";
import { randomUUID } from "node:crypto";

const GANG_CREATE_COST = 10000;
const TERRITORY_COLLECT_COOLDOWN = 4 * 60 * 60 * 1000; // 4h

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName("gangue")
      .setDescription("Sistema de gangues")
      .addSubcommand(s => s.setName("criar").setDescription("Criar uma gangue")
        .addStringOption(o => o.setName("nome").setDescription("Nome da gangue").setRequired(true))
        .addStringOption(o => o.setName("tag").setDescription("Tag (3-5 letras)").setRequired(true))
      )
      .addSubcommand(s => s.setName("convidar").setDescription("Convidar jogador")
        .addUserOption(o => o.setName("jogador").setDescription("Jogador a convidar").setRequired(true))
      )
      .addSubcommand(s => s.setName("sair").setDescription("Sair da gangue"))
      .addSubcommand(s => s.setName("info").setDescription("Ver info da sua gangue"))
      .addSubcommand(s => s.setName("lista").setDescription("Listar todas as gangues"))
      .addSubcommand(s => s.setName("guerra").setDescription("Declarar guerra a outra gangue")
        .addStringOption(o => o.setName("nome").setDescription("Nome da gangue inimiga").setRequired(true))
      )
      .addSubcommand(s => s.setName("banco").setDescription("Depositar no banco da gangue")
        .addIntegerOption(o => o.setName("valor").setDescription("Valor").setRequired(true))
      ),
    async execute(interaction: ChatInputCommandInteraction) {
      const player = await getOrCreatePlayer(interaction.user.id, interaction.user.username);
      const sub = interaction.options.getSubcommand();

      if (sub === "criar") {
        if (player.gangId) return interaction.reply({ content: "❌ Você já faz parte de uma gangue.", ephemeral: true });
        if (player.balance < GANG_CREATE_COST) return interaction.reply({ content: `❌ Criar uma gangue custa ${formatMoney(GANG_CREATE_COST)}.`, ephemeral: true });

        const name = interaction.options.getString("nome", true);
        const tag = interaction.options.getString("tag", true).toUpperCase().slice(0, 5);

        const existing = await db.query.gangs.findFirst({ where: eq(schema.gangs.name, name) });
        if (existing) return interaction.reply({ content: "❌ Já existe uma gangue com esse nome.", ephemeral: true });

        const id = randomUUID();
        await db.insert(schema.gangs).values({ id, name, tag, leaderId: player.discordId });
        await removeMoney(player.discordId, GANG_CREATE_COST);
        await updatePlayer(player.discordId, { gangId: id, gangRank: "lider" });

        return interaction.reply({ content: `🏴‍☠️ Gangue **[${tag}] ${name}** criada! Custou ${formatMoney(GANG_CREATE_COST)}.` });
      }

      if (sub === "convidar") {
        if (!player.gangId || player.gangRank !== "lider") return interaction.reply({ content: "❌ Apenas o líder pode convidar.", ephemeral: true });
        const target = interaction.options.getUser("jogador", true);
        const targetPlayer = await getOrCreatePlayer(target.id, target.username);
        if (targetPlayer.gangId) return interaction.reply({ content: "❌ Este jogador já está em uma gangue.", ephemeral: true });

        await updatePlayer(target.id, { gangId: player.gangId, gangRank: "membro" });
        await db.update(schema.gangs).set({ memberCount: sql`${schema.gangs.memberCount} + 1` }).where(eq(schema.gangs.id, player.gangId!));

        return interaction.reply({ content: `✅ **${target.username}** foi recrutado para a gangue!` });
      }

      if (sub === "sair") {
        if (!player.gangId) return interaction.reply({ content: "❌ Você não está em uma gangue.", ephemeral: true });
        if (player.gangRank === "lider") return interaction.reply({ content: "❌ O líder não pode sair. Dissolva a gangue.", ephemeral: true });
        await updatePlayer(player.discordId, { gangId: null, gangRank: null });
        return interaction.reply({ content: "✅ Você saiu da gangue." });
      }

      if (sub === "info") {
        if (!player.gangId) return interaction.reply({ content: "❌ Você não está em uma gangue.", ephemeral: true });
        const gang = await db.query.gangs.findFirst({ where: eq(schema.gangs.id, player.gangId) });
        if (!gang) return interaction.reply({ content: "❌ Gangue não encontrada.", ephemeral: true });

        const territories = await db.query.territories.findMany({ where: eq(schema.territories.controlledBy, gang.id) });
        const embed = new EmbedBuilder()
          .setTitle(`🏴‍☠️ ${gang.name} [${gang.tag}]`)
          .setColor(0xff4400)
          .addFields(
            { name: "👑 Líder", value: `<@${gang.leaderId}>`, inline: true },
            { name: "👥 Membros", value: `${gang.memberCount}`, inline: true },
            { name: "💰 Banco", value: formatMoney(gang.bankBalance), inline: true },
            { name: "⭐ Reputação", value: `${gang.reputation}`, inline: true },
            { name: "🗺️ Territórios", value: territories.length > 0 ? territories.map(t => t.name).join(", ") : "Nenhum", inline: false },
            { name: "⚔️ Em guerra", value: gang.isAtWar ? `Sim (contra ${gang.warTarget})` : "Não", inline: true },
          );
        return interaction.reply({ embeds: [embed] });
      }

      if (sub === "lista") {
        const allGangs = await db.query.gangs.findMany();
        const embed = new EmbedBuilder().setTitle("🏴‍☠️ Gangues do Servidor").setColor(0x880000);
        if (allGangs.length === 0) {
          embed.setDescription("Nenhuma gangue formada ainda.");
        } else {
          for (const g of allGangs) {
            embed.addFields({ name: `[${g.tag}] ${g.name}`, value: `👥 ${g.memberCount} membros | ⭐ ${g.reputation} rep | ⚔️ ${g.isAtWar ? "Em guerra" : "Paz"}`, inline: false });
          }
        }
        return interaction.reply({ embeds: [embed] });
      }

      if (sub === "guerra") {
        if (!player.gangId || player.gangRank !== "lider") return interaction.reply({ content: "❌ Apenas o líder pode declarar guerra.", ephemeral: true });
        const targetName = interaction.options.getString("nome", true);
        const myGang = await db.query.gangs.findFirst({ where: eq(schema.gangs.id, player.gangId) });
        const enemyGang = await db.query.gangs.findFirst({ where: eq(schema.gangs.name, targetName) });

        if (!enemyGang) return interaction.reply({ content: "❌ Gangue não encontrada.", ephemeral: true });
        if (enemyGang.id === player.gangId) return interaction.reply({ content: "❌ Não pode declarar guerra a si mesmo.", ephemeral: true });

        await db.update(schema.gangs).set({ isAtWar: true, warTarget: enemyGang.name, warStarted: new Date() }).where(eq(schema.gangs.id, player.gangId!));
        return interaction.reply({ content: `⚔️ **${myGang?.name}** declarou guerra a **${enemyGang.name}**! Que o mais forte vença!` });
      }

      if (sub === "banco") {
        if (!player.gangId) return interaction.reply({ content: "❌ Você não está em uma gangue.", ephemeral: true });
        const valor = interaction.options.getInteger("valor", true);
        if (valor <= 0 || player.balance < valor) return interaction.reply({ content: "❌ Saldo insuficiente.", ephemeral: true });

        await removeMoney(player.discordId, valor);
        const gang = await db.query.gangs.findFirst({ where: eq(schema.gangs.id, player.gangId) });
        if (gang) await db.update(schema.gangs).set({ bankBalance: gang.bankBalance + valor }).where(eq(schema.gangs.id, player.gangId!));

        return interaction.reply({ content: `✅ Depositou ${formatMoney(valor)} no banco da gangue!` });
      }
    },
  },

  {
    data: new SlashCommandBuilder()
      .setName("territorio")
      .setDescription("Sistema de territórios")
      .addSubcommand(s => s.setName("lista").setDescription("Ver todos os territórios"))
      .addSubcommand(s => s.setName("invadir").setDescription("Invadir um território")
        .addStringOption(o => o.setName("nome").setDescription("Nome do território").setRequired(true))
      )
      .addSubcommand(s => s.setName("coletar").setDescription("Coletar renda dos territórios")),
    async execute(interaction: ChatInputCommandInteraction) {
      const player = await getOrCreatePlayer(interaction.user.id, interaction.user.username);
      const sub = interaction.options.getSubcommand();

      if (sub === "lista") {
        const all = await db.query.territories.findMany();
        const embed = new EmbedBuilder().setTitle("🗺️ Territórios").setColor(0x006600);
        for (const t of all) {
          const owner = t.controlledBy ? await db.query.gangs.findFirst({ where: eq(schema.gangs.id, t.controlledBy) }) : null;
          embed.addFields({
            name: t.name,
            value: `👑 ${owner ? `[${owner.tag}] ${owner.name}` : "Sem dono"}\n💰 Renda: ${formatMoney(t.passiveIncome)}/4h`,
            inline: true,
          });
        }
        return interaction.reply({ embeds: [embed] });
      }

      if (sub === "invadir") {
        if (!player.gangId) return interaction.reply({ content: "❌ Você precisa de uma gangue para invadir territórios.", ephemeral: true });
        const name = interaction.options.getString("nome", true);
        const territory = await db.query.territories.findFirst({ where: eq(schema.territories.name, name) });
        if (!territory) return interaction.reply({ content: "❌ Território não encontrado.", ephemeral: true });

        const myGang = await db.query.gangs.findFirst({ where: eq(schema.gangs.id, player.gangId) });
        if (!myGang) return interaction.reply({ content: "❌ Gangue não encontrada.", ephemeral: true });

        if (territory.controlledBy === player.gangId) return interaction.reply({ content: "❌ Vocês já controlam este território.", ephemeral: true });

        const defenseBonus = territory.controlledBy ? territory.defenseBonus : 0.5;
        const attackPower = myGang.memberCount * 0.3 + myGang.reputation * 0.01;
        const success = Math.random() * attackPower > defenseBonus;

        if (success) {
          await db.update(schema.territories).set({ controlledBy: player.gangId }).where(eq(schema.territories.id, territory.id));
          return interaction.reply({ content: `⚔️ **${myGang.name}** conquistou o território **${territory.name}**! Renda passiva: ${formatMoney(territory.passiveIncome)}/4h` });
        } else {
          return interaction.reply({ content: `💥 **${myGang.name}** tentou invadir **${territory.name}** mas falhou!` });
        }
      }

      if (sub === "coletar") {
        if (!player.gangId) return interaction.reply({ content: "❌ Você não está em uma gangue.", ephemeral: true });
        const territories = await db.query.territories.findMany({ where: eq(schema.territories.controlledBy, player.gangId) });

        if (territories.length === 0) return interaction.reply({ content: "❌ Sua gangue não controla nenhum território.", ephemeral: true });

        let total = 0;
        const now = new Date();
        for (const t of territories) {
          const cd = t.lastCollected ? now.getTime() - t.lastCollected.getTime() : TERRITORY_COLLECT_COOLDOWN + 1;
          if (cd >= TERRITORY_COLLECT_COOLDOWN) {
            total += t.passiveIncome;
            await db.update(schema.territories).set({ lastCollected: now }).where(eq(schema.territories.id, t.id));
          }
        }

        if (total === 0) return interaction.reply({ content: "⏳ Nenhum território pronto para coletar ainda.", ephemeral: true });

        const gang = await db.query.gangs.findFirst({ where: eq(schema.gangs.id, player.gangId) });
        if (gang) await db.update(schema.gangs).set({ bankBalance: gang.bankBalance + total }).where(eq(schema.gangs.id, player.gangId!));

        return interaction.reply({ content: `💰 Coletou ${formatMoney(total)} dos territórios da gangue!` });
      }
    },
  },
];
