import { SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { getOrCreatePlayer, updatePlayer, formatMoney } from "../systems/player.js";
import { logTransaction } from "../systems/economy.js";

const DAY = 24 * 60 * 60 * 1000;

function timeLeft(last: Date | null, cooldown: number): number {
  if (!last) return 0;
  const elapsed = Date.now() - last.getTime();
  return Math.max(0, cooldown - elapsed);
}

function fmtDuration(ms: number): string {
  const s = Math.ceil(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}min`;
  if (m > 0) return `${m}min`;
  return `${s}s`;
}

export const commands = [
  {
    data: new SlashCommandBuilder().setName("daily").setDescription("Recompensa diária (com streak crescente)"),
    async execute(interaction: ChatInputCommandInteraction) {
      const player = await getOrCreatePlayer(interaction.user.id, interaction.user.username);
      const left = timeLeft(player.lastDaily, DAY);
      if (left > 0) return interaction.reply({ content: `⏳ Próxima recompensa diária em ${fmtDuration(left)}.`, ephemeral: true });

      let streak = player.dailyStreak ?? 0;
      if (player.lastDaily && Date.now() - player.lastDaily.getTime() <= 2 * DAY) streak += 1;
      else streak = 1;

      const base = 1000;
      const bonus = Math.min(streak - 1, 14) * 250;
      const total = base + bonus;

      await updatePlayer(player.discordId, { balance: player.balance + total, lastDaily: new Date(), dailyStreak: streak });
      await logTransaction(null, player.discordId, total, "daily", `Daily streak ${streak}`);

      return interaction.reply({ content: `🎁 **Recompensa diária:** ${formatMoney(total)}\n🔥 Streak: **${streak}** dia(s) consecutivos.` });
    },
  },
];
