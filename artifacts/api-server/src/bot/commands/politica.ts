import { SlashCommandBuilder, EmbedBuilder, type ChatInputCommandInteraction } from "discord.js";
import { eq } from "drizzle-orm";
import { db, schema } from "../systems/db.js";
import { getOrCreatePlayer, updatePlayer, formatMoney } from "../systems/player.js";
import { getGovernment } from "../systems/economy.js";
import { randomUUID } from "node:crypto";

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName("politica")
      .setDescription("Sistema político")
      .addSubcommand(s => s.setName("governo").setDescription("Ver o governo atual"))
      .addSubcommand(s => s.setName("eleicao").setDescription("Iniciar eleição (admin)")
        .addStringOption(o => o.setName("cargo").setDescription("Cargo").setRequired(true)
          .addChoices({ name: "Presidente", value: "presidente" }, { name: "Prefeito", value: "prefeito" })
        )
      )
      .addSubcommand(s => s.setName("candidatar").setDescription("Candidatar-se à eleição"))
      .addSubcommand(s => s.setName("votar").setDescription("Votar em um candidato")
        .addUserOption(o => o.setName("candidato").setDescription("Candidato").setRequired(true))
      )
      .addSubcommand(s => s.setName("propor_lei").setDescription("Propor uma lei (presidente/prefeito)")
        .addStringOption(o => o.setName("nome").setDescription("Nome da lei").setRequired(true))
        .addStringOption(o => o.setName("descricao").setDescription("Descrição").setRequired(true))
        .addStringOption(o => o.setName("efeito").setDescription("Efeito").setRequired(true)
          .addChoices(
            { name: "Aumentar impostos 10%", value: "tax_up" },
            { name: "Reduzir impostos 10%", value: "tax_down" },
            { name: "Legalizar crime menor", value: "crime_easy" },
            { name: "Aumentar segurança pública", value: "police_up" },
            { name: "Reduzir salário policial 20%", value: "police_pay_down" },
            { name: "Aumentar salário policial 20%", value: "police_pay_up" },
          )
        )
      ),
    async execute(interaction: ChatInputCommandInteraction) {
      const player = await getOrCreatePlayer(interaction.user.id, interaction.user.username);
      const sub = interaction.options.getSubcommand();

      if (sub === "governo") {
        const gov = await getGovernment();
        const eco = await db.query.worldEconomy.findFirst();
        const laws = await db.query.laws.findMany({ where: eq(schema.laws.isActive, true) });
        const embed = new EmbedBuilder()
          .setTitle("🏛️ Governo Atual")
          .setColor(0x003399)
          .addFields(
            { name: "🇧🇷 Presidente", value: gov.presidentId ? `<@${gov.presidentId}>` : "Vago", inline: true },
            { name: "🏙️ Prefeito", value: gov.mayorId ? `<@${gov.mayorId}>` : "Vago", inline: true },
            { name: "💸 Multiplicador de impostos", value: `${gov.taxMultiplier}%`, inline: true },
            { name: "🚔 Salário policial mult.", value: `${gov.policeSalaryMultiplier}%`, inline: true },
            { name: "📜 Leis ativas", value: laws.length > 0 ? laws.map(l => `• ${l.name}`).join("\n") : "Nenhuma", inline: false },
          );
        return interaction.reply({ embeds: [embed] });
      }

      if (sub === "eleicao") {
        if (!interaction.memberPermissions?.has("Administrator")) return interaction.reply({ content: "❌ Apenas administradores podem iniciar eleições.", ephemeral: true });
        const cargo = interaction.options.getString("cargo", true);
        const existing = await db.query.elections.findFirst({ where: eq(schema.elections.isActive, true) });
        if (existing) return interaction.reply({ content: "❌ Já existe uma eleição em andamento.", ephemeral: true });

        const endTime = new Date(Date.now() + 24 * 60 * 60 * 1000);
        await db.insert(schema.elections).values({
          position: cargo, candidates: [], votes: {},
          isActive: true, startTime: new Date(), endTime,
        });
        return interaction.reply({ content: `🗳️ Eleição para **${cargo}** iniciada! Termina: <t:${Math.floor(endTime.getTime() / 1000)}:R>\nUse \`/politica candidatar\` para entrar na corrida!` });
      }

      if (sub === "candidatar") {
        const election = await db.query.elections.findFirst({ where: eq(schema.elections.isActive, true) });
        if (!election) return interaction.reply({ content: "❌ Não há eleição ativa no momento.", ephemeral: true });
        const candidates = election.candidates as string[];
        if (candidates.includes(player.discordId)) return interaction.reply({ content: "❌ Você já é candidato.", ephemeral: true });
        candidates.push(player.discordId);
        await db.update(schema.elections).set({ candidates }).where(eq(schema.elections.id, election.id));
        return interaction.reply({ content: `🗳️ Você se candidatou para **${election.position}**! Boa sorte!` });
      }

      if (sub === "votar") {
        const election = await db.query.elections.findFirst({ where: eq(schema.elections.isActive, true) });
        if (!election) return interaction.reply({ content: "❌ Não há eleição ativa.", ephemeral: true });
        const target = interaction.options.getUser("candidato", true);
        const votes = election.votes as Record<string, string>;
        if (votes[player.discordId]) return interaction.reply({ content: "❌ Você já votou nesta eleição.", ephemeral: true });
        const candidates = election.candidates as string[];
        if (!candidates.includes(target.id)) return interaction.reply({ content: "❌ Este jogador não é candidato.", ephemeral: true });

        votes[player.discordId] = target.id;
        await db.update(schema.elections).set({ votes }).where(eq(schema.elections.id, election.id));

        if (new Date() >= (election.endTime ?? new Date())) {
          const tally: Record<string, number> = {};
          for (const v of Object.values(votes)) tally[v] = (tally[v] ?? 0) + 1;
          const winner = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
          if (winner) {
            const gov = await getGovernment();
            const update: any = { isActive: false, winnerId: winner[0] };
            await db.update(schema.elections).set(update).where(eq(schema.elections.id, election.id));
            const govUpdate: any = election.position === "presidente" ? { presidentId: winner[0] } : { mayorId: winner[0] };
            await db.update(schema.government).set(govUpdate).where(eq(schema.government.id, 1));
            return interaction.reply({ content: `🗳️ Você votou em <@${target.id}>!\n🏆 Eleição encerrada! Novo ${election.position}: <@${winner[0]}>` });
          }
        }
        return interaction.reply({ content: `🗳️ Você votou em **${target.username}**!` });
      }

      if (sub === "propor_lei") {
        const gov = await getGovernment();
        if (gov.presidentId !== player.discordId && gov.mayorId !== player.discordId) {
          return interaction.reply({ content: "❌ Apenas o presidente ou prefeito podem propor leis.", ephemeral: true });
        }
        const nome = interaction.options.getString("nome", true);
        const descricao = interaction.options.getString("descricao", true);
        const efeito = interaction.options.getString("efeito", true);

        await db.insert(schema.laws).values({ name: nome, description: descricao, effect: efeito, proposedBy: player.discordId, approvedAt: new Date() });

        const updates: any = {};
        if (efeito === "tax_up") updates.taxMultiplier = Math.min(200, gov.taxMultiplier + 10);
        if (efeito === "tax_down") updates.taxMultiplier = Math.max(0, gov.taxMultiplier - 10);
        if (efeito === "police_pay_up") updates.policeSalaryMultiplier = Math.min(200, gov.policeSalaryMultiplier + 20);
        if (efeito === "police_pay_down") updates.policeSalaryMultiplier = Math.max(0, gov.policeSalaryMultiplier - 20);
        if (efeito === "crime_easy") updates.crimeMultiplier = Math.max(0, gov.crimeMultiplier - 20);
        if (efeito === "police_up") updates.crimeMultiplier = Math.min(200, gov.crimeMultiplier + 20);

        if (Object.keys(updates).length > 0) {
          await db.update(schema.government).set({ ...updates, updatedAt: new Date() }).where(eq(schema.government.id, 1));
        }

        return interaction.reply({ content: `📜 Lei **"${nome}"** aprovada e em vigor!\nEfeito: ${efeito.replace(/_/g, " ")}` });
      }
    },
  },
];
