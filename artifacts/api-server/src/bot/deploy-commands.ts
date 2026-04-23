import { REST, Routes } from "discord.js";
import { logger } from "../lib/logger.js";

/**
 * Apaga TODOS os slash commands (globais e por guild) que estavam registrados.
 * O bot agora usa apenas prefixo "!".
 */
export async function clearSlashCommands() {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID;
  if (!token || !clientId) {
    logger.warn("DISCORD_TOKEN ou DISCORD_CLIENT_ID não configurados — pulando limpeza de slash.");
    return;
  }

  const rest = new REST({ version: "10" }).setToken(token);

  try {
    // Limpa globais
    await rest.put(Routes.applicationCommands(clientId), { body: [] });
    logger.info("🧹 Slash commands globais apagados.");

    // Limpa também por guild se DISCORD_GUILD_ID(s) estiver definido
    const guildIds = (process.env.DISCORD_GUILD_ID ?? process.env.DISCORD_GUILD_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    for (const gid of guildIds) {
      await rest.put(Routes.applicationGuildCommands(clientId, gid), { body: [] });
      logger.info(`🧹 Slash commands da guild ${gid} apagados.`);
    }
  } catch (err) {
    logger.error({ err }, "Falha ao limpar slash commands");
  }
}
