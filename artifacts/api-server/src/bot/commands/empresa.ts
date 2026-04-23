import { SlashCommandBuilder, EmbedBuilder, type ChatInputCommandInteraction } from "discord.js";
import { eq } from "drizzle-orm";
import { db, schema } from "../systems/db.js";
import { getOrCreatePlayer, updatePlayer, removeMoney, formatMoney } from "../systems/player.js";
import { PROFESSIONS } from "../systems/economy.js";
import { randomUUID } from "node:crypto";

const COMPANY_CREATE_COST = 20000;
const IPO_COST = 50000;
const ADVERTISE_COST = 2000;
const EMPLOYEE_SALARY = 1500;

const SECTORS = ["Tecnologia", "Saúde", "Alimentação", "Transporte", "Segurança", "Entretenimento", "Construção", "Finanças"];

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName("empresa")
      .setDescription("Sistema empresarial para empresários")
      .addSubcommand(s => s.setName("criar").setDescription(`Criar uma empresa (${formatMoney(COMPANY_CREATE_COST)})`)
        .addStringOption(o => o.setName("nome").setDescription("Nome da empresa").setRequired(true))
        .addStringOption(o => o.setName("setor").setDescription("Setor de atuação").setRequired(true)
          .addChoices(...SECTORS.map(s => ({ name: s, value: s })))
        )
        .addStringOption(o => o.setName("descricao").setDescription("Descrição da empresa").setRequired(true))
      )
      .addSubcommand(s => s.setName("info").setDescription("Ver info da sua empresa"))
      .addSubcommand(s => s.setName("contratar").setDescription("Contratar um funcionário")
        .addUserOption(o => o.setName("jogador").setDescription("Jogador a contratar").setRequired(true))
      )
      .addSubcommand(s => s.setName("demitir").setDescription("Demitir um funcionário")
        .addUserOption(o => o.setName("jogador").setDescription("Jogador a demitir").setRequired(true))
      )
      .addSubcommand(s => s.setName("pagar_funcionarios").setDescription("Pagar salários dos funcionários"))
      .addSubcommand(s => s.setName("anunciar").setDescription(`Anunciar sua empresa (${formatMoney(ADVERTISE_COST)}) para aumentar reputação`))
      .addSubcommand(s => s.setName("ipo").setDescription(`Abrir capital na bolsa (${formatMoney(IPO_COST)})`)
        .addStringOption(o => o.setName("simbolo").setDescription("Símbolo (3-5 letras, ex: MINHA)").setRequired(true))
        .addIntegerOption(o => o.setName("preco_inicial").setDescription("Preço inicial por ação").setRequired(true))
      )
      .addSubcommand(s => s.setName("upgrade").setDescription("Melhorar nível da empresa"))
      .addSubcommand(s => s.setName("lista").setDescription("Ver todas as empresas")),

    async execute(interaction: ChatInputCommandInteraction) {
      const player = await getOrCreatePlayer(interaction.user.id, interaction.user.username);
      const sub = interaction.options.getSubcommand();

      if (sub === "criar") {
        if (player.profession !== "empresario" || !player.isCertified) {
          return interaction.reply({ content: "❌ Apenas empresários certificados podem criar empresas. Use `/profissao curso empresario`.", ephemeral: true });
        }

        const existingOwned = await db.query.companies.findFirst({ where: eq(schema.companies.ownerId, player.discordId) });
        if (existingOwned) return interaction.reply({ content: "❌ Você já possui uma empresa.", ephemeral: true });

        const nome = interaction.options.getString("nome", true);
        const setor = interaction.options.getString("setor", true);
        const descricao = interaction.options.getString("descricao", true);

        const existing = await db.query.companies.findFirst({ where: eq(schema.companies.name, nome) });
        if (existing) return interaction.reply({ content: "❌ Já existe uma empresa com esse nome.", ephemeral: true });

        if (player.balance < COMPANY_CREATE_COST) return interaction.reply({ content: `❌ Criar empresa custa ${formatMoney(COMPANY_CREATE_COST)}.`, ephemeral: true });

        await removeMoney(player.discordId, COMPANY_CREATE_COST);
        const id = randomUUID();
        await db.insert(schema.companies).values({
          id, name: nome, ownerId: player.discordId, sector: setor, description: descricao,
          employees: [], revenue: 0, expenses: 0, totalShares: 1000, availableShares: 1000,
          sharePrice: 100, marketCap: 100000, isPublic: false, level: 1, reputation: 50,
        });

        return interaction.reply({
          content: `🏢 Empresa **${nome}** criada no setor de **${setor}**!\nCusto: ${formatMoney(COMPANY_CREATE_COST)}\n\nPróximos passos:\n• \`/empresa contratar\` — contratar funcionários\n• \`/empresa anunciar\` — aumentar reputação\n• \`/empresa upgrade\` — melhorar nível\n• \`/empresa ipo\` — abrir capital na bolsa`,
        });
      }

      if (sub === "info") {
        const company = await db.query.companies.findFirst({ where: eq(schema.companies.ownerId, player.discordId) });
        if (!company) return interaction.reply({ content: "❌ Você não tem empresa. Use `/empresa criar`.", ephemeral: true });

        const employees = company.employees as string[];
        const embed = new EmbedBuilder()
          .setTitle(`🏢 ${company.name}`)
          .setColor(0x003388)
          .addFields(
            { name: "🏭 Setor", value: company.sector, inline: true },
            { name: "📊 Nível", value: `${company.level}`, inline: true },
            { name: "⭐ Reputação", value: `${company.reputation}/100`, inline: true },
            { name: "💰 Receita total", value: formatMoney(company.revenue), inline: true },
            { name: "💸 Despesas", value: formatMoney(company.expenses), inline: true },
            { name: "👥 Funcionários", value: `${employees.length}`, inline: true },
            { name: "📈 Na bolsa", value: company.isPublic ? `Sim [${company.stockSymbol}] @ ${formatMoney(company.sharePrice)}` : "Não (use `/empresa ipo`)", inline: false },
            { name: "📝 Descrição", value: company.description ?? "Sem descrição", inline: false },
          );
        return interaction.reply({ embeds: [embed] });
      }

      if (sub === "contratar") {
        const company = await db.query.companies.findFirst({ where: eq(schema.companies.ownerId, player.discordId) });
        if (!company) return interaction.reply({ content: "❌ Você não tem empresa.", ephemeral: true });

        const target = interaction.options.getUser("jogador", true);
        const employees = company.employees as string[];
        if (employees.includes(target.id)) return interaction.reply({ content: "❌ Este jogador já é funcionário.", ephemeral: true });

        const maxEmployees = company.level * 3;
        if (employees.length >= maxEmployees) return interaction.reply({ content: `❌ Nível ${company.level} suporta até ${maxEmployees} funcionários. Faça upgrade!`, ephemeral: true });

        employees.push(target.id);
        await db.update(schema.companies).set({ employees }).where(eq(schema.companies.id, company.id));
        return interaction.reply({ content: `✅ **${target.username}** foi contratado para **${company.name}**!\nSalário: ${formatMoney(EMPLOYEE_SALARY)}/dia (pago manualmente pelo dono)` });
      }

      if (sub === "demitir") {
        const company = await db.query.companies.findFirst({ where: eq(schema.companies.ownerId, player.discordId) });
        if (!company) return interaction.reply({ content: "❌ Você não tem empresa.", ephemeral: true });

        const target = interaction.options.getUser("jogador", true);
        const employees = (company.employees as string[]).filter(e => e !== target.id);
        await db.update(schema.companies).set({ employees }).where(eq(schema.companies.id, company.id));
        return interaction.reply({ content: `❌ **${target.username}** foi demitido de **${company.name}**.` });
      }

      if (sub === "pagar_funcionarios") {
        const company = await db.query.companies.findFirst({ where: eq(schema.companies.ownerId, player.discordId) });
        if (!company) return interaction.reply({ content: "❌ Você não tem empresa.", ephemeral: true });

        const employees = company.employees as string[];
        if (employees.length === 0) return interaction.reply({ content: "❌ Sem funcionários para pagar.", ephemeral: true });

        const lastPayroll = company.lastPayroll ? new Date(company.lastPayroll) : null;
        if (lastPayroll && Date.now() - lastPayroll.getTime() < 24 * 60 * 60 * 1000) {
          return interaction.reply({ content: "⏳ Folha de pagamento já foi paga hoje.", ephemeral: true });
        }

        const total = employees.length * EMPLOYEE_SALARY;
        if (player.balance < total) return interaction.reply({ content: `❌ Folha total: ${formatMoney(total)}. Você tem ${formatMoney(player.balance)}.`, ephemeral: true });

        await removeMoney(player.discordId, total);
        for (const empId of employees) {
          const emp = await db.query.players.findFirst({ where: eq(schema.players.discordId, empId) });
          if (emp) await updatePlayer(empId, { balance: emp.balance + EMPLOYEE_SALARY });
        }

        await db.update(schema.companies).set({
          expenses: company.expenses + total,
          revenue: company.revenue,
          lastPayroll: new Date(),
        }).where(eq(schema.companies.id, company.id));

        return interaction.reply({ content: `💸 Folha de pagamento paga! **${employees.length} funcionários** × ${formatMoney(EMPLOYEE_SALARY)} = ${formatMoney(total)}` });
      }

      if (sub === "anunciar") {
        const company = await db.query.companies.findFirst({ where: eq(schema.companies.ownerId, player.discordId) });
        if (!company) return interaction.reply({ content: "❌ Você não tem empresa.", ephemeral: true });
        if (player.balance < ADVERTISE_COST) return interaction.reply({ content: `❌ Anunciar custa ${formatMoney(ADVERTISE_COST)}.`, ephemeral: true });

        await removeMoney(player.discordId, ADVERTISE_COST);
        const repGain = Math.floor(Math.random() * 10 + 5);
        const newRep = Math.min(100, company.reputation + repGain);
        await db.update(schema.companies).set({ reputation: newRep, expenses: company.expenses + ADVERTISE_COST }).where(eq(schema.companies.id, company.id));

        return interaction.reply({ content: `📣 **${company.name}** anunciou! Reputação: ${company.reputation} → ${newRep} (+${repGain})` });
      }

      if (sub === "ipo") {
        const company = await db.query.companies.findFirst({ where: eq(schema.companies.ownerId, player.discordId) });
        if (!company) return interaction.reply({ content: "❌ Você não tem empresa.", ephemeral: true });
        if (company.isPublic) return interaction.reply({ content: "❌ Sua empresa já está na bolsa.", ephemeral: true });
        if (company.level < 3) return interaction.reply({ content: `❌ Sua empresa precisa ser nível 3 para abrir capital. Atual: ${company.level}. Use \`/empresa upgrade\`.`, ephemeral: true });
        if (player.balance < IPO_COST) return interaction.reply({ content: `❌ IPO custa ${formatMoney(IPO_COST)}.`, ephemeral: true });

        const symbol = interaction.options.getString("simbolo", true).toUpperCase().slice(0, 5);
        const preco = Math.max(1, interaction.options.getInteger("preco_inicial", true));

        const symbolExists = await db.query.companies.findFirst({ where: eq(schema.companies.stockSymbol, symbol) });
        if (symbolExists) return interaction.reply({ content: "❌ Este símbolo já está em uso.", ephemeral: true });

        await removeMoney(player.discordId, IPO_COST);
        await db.update(schema.companies).set({
          isPublic: true,
          stockSymbol: symbol,
          sharePrice: preco,
          marketCap: preco * 1000,
          availableShares: 800,
          priceHistory: [preco],
          expenses: company.expenses + IPO_COST,
        }).where(eq(schema.companies.id, company.id));

        return interaction.reply({
          content: `🚀 **${company.name}** [${symbol}] entrou na bolsa!\nPreço inicial: ${formatMoney(preco)}/ação\n800 ações disponíveis para compra.\n\nVeja em: \`/bolsa info ${symbol}\``,
        });
      }

      if (sub === "upgrade") {
        const company = await db.query.companies.findFirst({ where: eq(schema.companies.ownerId, player.discordId) });
        if (!company) return interaction.reply({ content: "❌ Você não tem empresa.", ephemeral: true });
        if (company.level >= 10) return interaction.reply({ content: "✅ Sua empresa já está no nível máximo!", ephemeral: true });

        const upgradeCost = company.level * 15000;
        if (player.balance < upgradeCost) return interaction.reply({ content: `❌ Upgrade para nível ${company.level + 1} custa ${formatMoney(upgradeCost)}.`, ephemeral: true });

        await removeMoney(player.discordId, upgradeCost);
        const newLevel = company.level + 1;
        await db.update(schema.companies).set({
          level: newLevel,
          reputation: Math.min(100, company.reputation + 5),
          totalShares: newLevel >= 3 ? 1000 : company.totalShares,
          expenses: company.expenses + upgradeCost,
        }).where(eq(schema.companies.id, company.id));

        return interaction.reply({
          content: `🏗️ **${company.name}** subiu para **nível ${newLevel}**!\n• Capacidade de funcionários: ${newLevel * 3}\n${newLevel === 3 ? "• Desbloqueou: IPO na bolsa de valores!" : ""}`,
        });
      }

      if (sub === "lista") {
        const all = await db.query.companies.findMany();
        const embed = new EmbedBuilder().setTitle("🏢 Empresas do Servidor").setColor(0x004488);
        if (all.length === 0) {
          embed.setDescription("Nenhuma empresa criada ainda.");
        } else {
          for (const c of all) {
            embed.addFields({
              name: `${c.name} (Nível ${c.level})`,
              value: `🏭 ${c.sector} | 👥 ${(c.employees as string[]).length} func. | ⭐ ${c.reputation}/100${c.isPublic ? ` | 📈 [${c.stockSymbol}]` : ""}`,
              inline: false,
            });
          }
        }
        return interaction.reply({ embeds: [embed] });
      }
    },
  },
];
