import { SlashCommandBuilder, EmbedBuilder, type ChatInputCommandInteraction } from "discord.js";
import { eq, and } from "drizzle-orm";
import { db, schema } from "../systems/db.js";
import { getOrCreatePlayer, updatePlayer, removeMoney, formatMoney } from "../systems/player.js";
import { logTransaction } from "../systems/economy.js";
import { randomUUID } from "node:crypto";

const COMPANY_CREATE_COST = 20000;
const IPO_MIN_LEVEL = 3;

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName("bolsa")
      .setDescription("Bolsa de Valores")
      .addSubcommand(s => s.setName("lista").setDescription("Ver empresas listadas na bolsa"))
      .addSubcommand(s => s.setName("comprar").setDescription("Comprar ações")
        .addStringOption(o => o.setName("simbolo").setDescription("Símbolo da ação (ex: AMZN)").setRequired(true))
        .addIntegerOption(o => o.setName("quantidade").setDescription("Qtd de ações").setRequired(true))
      )
      .addSubcommand(s => s.setName("vender").setDescription("Vender ações")
        .addStringOption(o => o.setName("simbolo").setDescription("Símbolo da ação").setRequired(true))
        .addIntegerOption(o => o.setName("quantidade").setDescription("Qtd de ações").setRequired(true))
      )
      .addSubcommand(s => s.setName("carteira").setDescription("Ver sua carteira de investimentos"))
      .addSubcommand(s => s.setName("info").setDescription("Ver detalhes de uma ação")
        .addStringOption(o => o.setName("simbolo").setDescription("Símbolo da ação").setRequired(true))
      ),
    async execute(interaction: ChatInputCommandInteraction) {
      const player = await getOrCreatePlayer(interaction.user.id, interaction.user.username);
      const sub = interaction.options.getSubcommand();

      if (sub === "lista") {
        const publicCompanies = await db.query.companies.findMany({ where: eq(schema.companies.isPublic, true) });
        const embed = new EmbedBuilder().setTitle("📈 Bolsa de Valores").setColor(0x00aa44);

        if (publicCompanies.length === 0) {
          embed.setDescription("Nenhuma empresa listada na bolsa ainda. Empresários podem abrir capital com `/empresa ipo`.");
        } else {
          for (const c of publicCompanies) {
            const history = c.priceHistory as number[];
            const trend = history.length >= 2 ? (history[history.length - 1] > history[history.length - 2] ? "📈" : "📉") : "➡️";
            embed.addFields({
              name: `${trend} [${c.stockSymbol}] ${c.name}`,
              value: `💰 Preço: ${formatMoney(c.sharePrice)}/ação\n📦 Disponível: ${c.availableShares} ações\n🏢 Setor: ${c.sector}`,
              inline: true,
            });
          }
        }
        return interaction.reply({ embeds: [embed] });
      }

      if (sub === "info") {
        const symbol = interaction.options.getString("simbolo", true).toUpperCase();
        const company = await db.query.companies.findFirst({ where: eq(schema.companies.stockSymbol, symbol) });
        if (!company || !company.isPublic) return interaction.reply({ content: "❌ Empresa não encontrada na bolsa.", ephemeral: true });

        const history = company.priceHistory as number[];
        const trend = history.length >= 2
          ? history.slice(-5).map((p, i, arr) => i === 0 ? "➡️" : p > arr[i - 1] ? "📈" : "📉").join(" ")
          : "Dados insuficientes";

        const embed = new EmbedBuilder()
          .setTitle(`🏢 ${company.name} [${symbol}]`)
          .setColor(0x0044cc)
          .addFields(
            { name: "💰 Preço atual", value: formatMoney(company.sharePrice), inline: true },
            { name: "📊 Market Cap", value: formatMoney(company.marketCap), inline: true },
            { name: "📦 Ações disponíveis", value: `${company.availableShares}/${company.totalShares}`, inline: true },
            { name: "🏢 Setor", value: company.sector, inline: true },
            { name: "⭐ Reputação", value: `${company.reputation}/100`, inline: true },
            { name: "📉 Histórico (últimas 5)", value: trend, inline: false },
          );
        return interaction.reply({ embeds: [embed] });
      }

      if (sub === "comprar") {
        const symbol = interaction.options.getString("simbolo", true).toUpperCase();
        const qty = interaction.options.getInteger("quantidade", true);
        if (qty <= 0) return interaction.reply({ content: "❌ Quantidade inválida.", ephemeral: true });

        const company = await db.query.companies.findFirst({ where: eq(schema.companies.stockSymbol, symbol) });
        if (!company || !company.isPublic) return interaction.reply({ content: "❌ Empresa não encontrada na bolsa.", ephemeral: true });
        if (company.availableShares < qty) return interaction.reply({ content: `❌ Apenas ${company.availableShares} ações disponíveis.`, ephemeral: true });

        const total = company.sharePrice * qty;
        if (player.balance < total) return interaction.reply({ content: `❌ Você precisa de ${formatMoney(total)}. Tem: ${formatMoney(player.balance)}.`, ephemeral: true });

        await removeMoney(player.discordId, total);

        const existing = await db.query.stockPortfolios.findFirst({
          where: and(eq(schema.stockPortfolios.playerId, player.discordId), eq(schema.stockPortfolios.companyId, company.id)),
        });

        if (existing) {
          const totalShares = existing.shares + qty;
          const avgPrice = Math.floor((existing.avgBuyPrice * existing.shares + company.sharePrice * qty) / totalShares);
          await db.update(schema.stockPortfolios).set({ shares: totalShares, avgBuyPrice: avgPrice, updatedAt: new Date() })
            .where(and(eq(schema.stockPortfolios.playerId, player.discordId), eq(schema.stockPortfolios.companyId, company.id)));
        } else {
          await db.insert(schema.stockPortfolios).values({
            playerId: player.discordId, companyId: company.id, shares: qty, avgBuyPrice: company.sharePrice,
          });
        }

        await db.update(schema.companies).set({
          availableShares: company.availableShares - qty,
          sharePrice: Math.floor(company.sharePrice * (1 + qty / company.totalShares * 0.02)),
        }).where(eq(schema.companies.id, company.id));

        await db.insert(schema.stockTransactions).values({ playerId: player.discordId, companyId: company.id, type: "buy", shares: qty, pricePerShare: company.sharePrice, total });

        return interaction.reply({ content: `📈 Comprou **${qty} ações** de [${symbol}] por ${formatMoney(total)}!` });
      }

      if (sub === "vender") {
        const symbol = interaction.options.getString("simbolo", true).toUpperCase();
        const qty = interaction.options.getInteger("quantidade", true);
        if (qty <= 0) return interaction.reply({ content: "❌ Quantidade inválida.", ephemeral: true });

        const company = await db.query.companies.findFirst({ where: eq(schema.companies.stockSymbol, symbol) });
        if (!company) return interaction.reply({ content: "❌ Empresa não encontrada.", ephemeral: true });

        const portfolio = await db.query.stockPortfolios.findFirst({
          where: and(eq(schema.stockPortfolios.playerId, player.discordId), eq(schema.stockPortfolios.companyId, company.id)),
        });

        if (!portfolio || portfolio.shares < qty) return interaction.reply({ content: `❌ Você não tem ações suficientes. Tem: ${portfolio?.shares ?? 0}.`, ephemeral: true });

        const total = company.sharePrice * qty;
        await updatePlayer(player.discordId, { balance: player.balance + total });

        const remaining = portfolio.shares - qty;
        if (remaining === 0) {
          await db.delete(schema.stockPortfolios)
            .where(and(eq(schema.stockPortfolios.playerId, player.discordId), eq(schema.stockPortfolios.companyId, company.id)));
        } else {
          await db.update(schema.stockPortfolios).set({ shares: remaining, updatedAt: new Date() })
            .where(and(eq(schema.stockPortfolios.playerId, player.discordId), eq(schema.stockPortfolios.companyId, company.id)));
        }

        await db.update(schema.companies).set({
          availableShares: company.availableShares + qty,
          sharePrice: Math.max(1, Math.floor(company.sharePrice * (1 - qty / company.totalShares * 0.015))),
        }).where(eq(schema.companies.id, company.id));

        await db.insert(schema.stockTransactions).values({ playerId: player.discordId, companyId: company.id, type: "sell", shares: qty, pricePerShare: company.sharePrice, total });

        const profit = (company.sharePrice - portfolio.avgBuyPrice) * qty;
        return interaction.reply({ content: `📉 Vendeu **${qty} ações** de [${symbol}] por ${formatMoney(total)}! Lucro/Prejuízo: ${profit >= 0 ? "+" : ""}${formatMoney(profit)}` });
      }

      if (sub === "carteira") {
        const portfolios = await db.query.stockPortfolios.findMany({ where: eq(schema.stockPortfolios.playerId, player.discordId) });
        if (portfolios.length === 0) return interaction.reply({ content: "📊 Sua carteira está vazia. Use `/bolsa comprar` para investir!", ephemeral: true });

        const embed = new EmbedBuilder().setTitle("📊 Sua Carteira de Ações").setColor(0x00aaff);
        let totalValue = 0;

        for (const p of portfolios) {
          const company = await db.query.companies.findFirst({ where: eq(schema.companies.id, p.companyId) });
          if (!company) continue;
          const currentValue = company.sharePrice * p.shares;
          const profit = (company.sharePrice - p.avgBuyPrice) * p.shares;
          totalValue += currentValue;
          embed.addFields({
            name: `[${company.stockSymbol}] ${company.name}`,
            value: `📦 ${p.shares} ações @ ${formatMoney(company.sharePrice)}\n💰 Valor: ${formatMoney(currentValue)}\n${profit >= 0 ? "📈" : "📉"} ${profit >= 0 ? "+" : ""}${formatMoney(profit)}`,
            inline: true,
          });
        }
        embed.setFooter({ text: `Valor total da carteira: ${formatMoney(totalValue)}` });
        return interaction.reply({ embeds: [embed] });
      }
    },
  },
];
