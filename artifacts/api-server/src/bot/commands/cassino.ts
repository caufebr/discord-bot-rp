import { SlashCommandBuilder, EmbedBuilder, type ChatInputCommandInteraction } from "discord.js";
import { getOrCreatePlayer, updatePlayer, removeMoney, formatMoney, isJailed } from "../systems/player.js";
import { logTransaction } from "../systems/economy.js";

const MIN_BET = 50;
const MAX_BET = 100000;

const SLOT_REELS = ["🍒", "🍋", "🍇", "🔔", "⭐", "💎", "7️⃣"];
const SLOT_PAYOUTS: Record<string, number> = {
  "7️⃣": 25,
  "💎": 15,
  "⭐": 10,
  "🔔": 6,
  "🍇": 4,
  "🍋": 3,
  "🍒": 2,
};

function checkBet(balance: number, valor: number): string | null {
  if (valor < MIN_BET) return `❌ Aposta mínima: ${formatMoney(MIN_BET)}.`;
  if (valor > MAX_BET) return `❌ Aposta máxima: ${formatMoney(MAX_BET)}.`;
  if (balance < valor) return `❌ Saldo insuficiente.`;
  return null;
}

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName("cassino")
      .setDescription("Sistema de cassino")
      .addSubcommand(s =>
        s.setName("slot").setDescription("Caça-níquel — combine 3 símbolos iguais")
          .addIntegerOption(o => o.setName("valor").setDescription("Valor da aposta").setRequired(true).setMinValue(MIN_BET).setMaxValue(MAX_BET)),
      )
      .addSubcommand(s =>
        s.setName("roleta").setDescription("Roleta — aposte em vermelho/preto/verde")
          .addStringOption(o => o.setName("cor").setDescription("Cor").setRequired(true)
            .addChoices({ name: "🔴 Vermelho (2x)", value: "vermelho" }, { name: "⚫ Preto (2x)", value: "preto" }, { name: "🟢 Verde (14x)", value: "verde" }))
          .addIntegerOption(o => o.setName("valor").setDescription("Valor").setRequired(true).setMinValue(MIN_BET).setMaxValue(MAX_BET)),
      )
      .addSubcommand(s =>
        s.setName("dado").setDescription("Cara ou coroa nos dados — aposte alto (4-6) ou baixo (1-3)")
          .addStringOption(o => o.setName("escolha").setDescription("Escolha").setRequired(true)
            .addChoices({ name: "📉 Baixo (1-3)", value: "baixo" }, { name: "📈 Alto (4-6)", value: "alto" }, { name: "🎯 Número exato", value: "exato" }))
          .addIntegerOption(o => o.setName("valor").setDescription("Valor da aposta").setRequired(true).setMinValue(MIN_BET).setMaxValue(MAX_BET))
          .addIntegerOption(o => o.setName("numero").setDescription("Número (apenas se escolha=exato)").setRequired(false).setMinValue(1).setMaxValue(6)),
      )
      .addSubcommand(s =>
        s.setName("bicho").setDescription("Jogo do bicho — aposte em um animal (1-25), paga 18x")
          .addIntegerOption(o => o.setName("animal").setDescription("Número do bicho (1-25)").setRequired(true).setMinValue(1).setMaxValue(25))
          .addIntegerOption(o => o.setName("valor").setDescription("Valor").setRequired(true).setMinValue(MIN_BET).setMaxValue(MAX_BET)),
      ),
    async execute(interaction: ChatInputCommandInteraction) {
      const player = await getOrCreatePlayer(interaction.user.id, interaction.user.username);
      if (isJailed(player)) return interaction.reply({ content: "❌ Você está preso!", ephemeral: true });

      const sub = interaction.options.getSubcommand();
      const valor = interaction.options.getInteger("valor", true);
      const err = checkBet(player.balance, valor);
      if (err) return interaction.reply({ content: err, ephemeral: true });

      await removeMoney(player.discordId, valor);

      if (sub === "slot") {
        const reels = [SLOT_REELS[Math.floor(Math.random() * SLOT_REELS.length)], SLOT_REELS[Math.floor(Math.random() * SLOT_REELS.length)], SLOT_REELS[Math.floor(Math.random() * SLOT_REELS.length)]];
        const display = `🎰 | ${reels.join(" | ")} | 🎰`;

        let win = 0;
        if (reels[0] === reels[1] && reels[1] === reels[2]) {
          win = valor * (SLOT_PAYOUTS[reels[0]!] ?? 2);
        } else if (reels[0] === reels[1] || reels[1] === reels[2] || reels[0] === reels[2]) {
          win = Math.floor(valor * 1.5);
        }

        if (win > 0) {
          await updatePlayer(player.discordId, { balance: player.balance - valor + win });
          await logTransaction(null, player.discordId, win - valor, "casino_slot", "Slot win");
          return interaction.reply({ content: `${display}\n✨ **GANHOU ${formatMoney(win)}!** (lucro: ${formatMoney(win - valor)})` });
        }
        await logTransaction(player.discordId, "CASINO", valor, "casino_slot", "Slot loss");
        return interaction.reply({ content: `${display}\n💸 Perdeu ${formatMoney(valor)}.` });
      }

      if (sub === "roleta") {
        const cor = interaction.options.getString("cor", true);
        const r = Math.random();
        let result: string;
        if (r < 1 / 15) result = "verde";
        else if (r < (1 + 7) / 15) result = "vermelho";
        else result = "preto";

        const emojiMap: Record<string, string> = { vermelho: "🔴", preto: "⚫", verde: "🟢" };
        if (cor === result) {
          const mult = result === "verde" ? 14 : 2;
          const win = valor * mult;
          await updatePlayer(player.discordId, { balance: player.balance - valor + win });
          await logTransaction(null, player.discordId, win - valor, "casino_roleta", "Roleta win");
          return interaction.reply({ content: `🎡 Caiu em ${emojiMap[result]} **${result}**!\n✨ **GANHOU ${formatMoney(win)}!**` });
        }
        await logTransaction(player.discordId, "CASINO", valor, "casino_roleta", "Roleta loss");
        return interaction.reply({ content: `🎡 Caiu em ${emojiMap[result]} **${result}**.\n💸 Perdeu ${formatMoney(valor)}.` });
      }

      if (sub === "dado") {
        const escolha = interaction.options.getString("escolha", true);
        const numero = interaction.options.getInteger("numero");
        const roll = Math.floor(Math.random() * 6) + 1;

        let win = 0;
        if (escolha === "exato") {
          if (!numero) return interaction.reply({ content: "❌ Informe um número de 1 a 6.", ephemeral: true });
          if (roll === numero) win = valor * 5;
        } else if (escolha === "alto" && roll >= 4) win = valor * 2;
        else if (escolha === "baixo" && roll <= 3) win = valor * 2;

        if (win > 0) {
          await updatePlayer(player.discordId, { balance: player.balance - valor + win });
          await logTransaction(null, player.discordId, win - valor, "casino_dado", "Dado win");
          return interaction.reply({ content: `🎲 Resultado: **${roll}**\n✨ **GANHOU ${formatMoney(win)}!**` });
        }
        await logTransaction(player.discordId, "CASINO", valor, "casino_dado", "Dado loss");
        return interaction.reply({ content: `🎲 Resultado: **${roll}**\n💸 Perdeu ${formatMoney(valor)}.` });
      }

      if (sub === "bicho") {
        const animal = interaction.options.getInteger("animal", true);
        const sorteado = Math.floor(Math.random() * 25) + 1;
        if (sorteado === animal) {
          const win = valor * 18;
          await updatePlayer(player.discordId, { balance: player.balance - valor + win });
          await logTransaction(null, player.discordId, win - valor, "casino_bicho", "Bicho win");
          return interaction.reply({ content: `🐾 Bicho sorteado: **${sorteado}**\n✨ **GANHOU ${formatMoney(win)}!**` });
        }
        await logTransaction(player.discordId, "CASINO", valor, "casino_bicho", "Bicho loss");
        return interaction.reply({ content: `🐾 Bicho sorteado: **${sorteado}**\n💸 Perdeu ${formatMoney(valor)}.` });
      }
    },
  },
];
