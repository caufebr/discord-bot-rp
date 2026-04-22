import { Client, GatewayIntentBits, Collection, type ChatInputCommandInteraction } from "discord.js";
import { commands as economiaCommands } from "./commands/economia.js";
import { commands as profissaoCommands } from "./commands/profissao.js";
import { commands as crimeCommands } from "./commands/crime.js";
import { commands as ganguesCommands } from "./commands/gangues.js";
import { commands as politicaCommands } from "./commands/politica.js";
import { commands as saudeCommands } from "./commands/saude.js";
import { commands as bolsaCommands } from "./commands/bolsa.js";
import { commands as empresaCommands } from "./commands/empresa.js";
import { deployCommands } from "./deploy-commands.js";
import { startWorldEngine } from "./systems/worldEvents.js";
import { seedDatabase } from "./systems/seed.js";
import { logger } from "../lib/logger.js";

interface BotCommand {
  data: { name: string; toJSON(): object };
  execute(interaction: ChatInputCommandInteraction): Promise<void>;
}

const allCommands: BotCommand[] = [
  ...economiaCommands,
  ...profissaoCommands,
  ...crimeCommands,
  ...ganguesCommands,
  ...politicaCommands,
  ...saudeCommands,
  ...bolsaCommands,
  ...empresaCommands,
];

export async function startBot() {
  const token = process.env.DISCORD_TOKEN;
  const eventChannelId = process.env.DISCORD_EVENT_CHANNEL_ID ?? "";

  if (!token) {
    logger.warn("DISCORD_TOKEN not set — bot not started.");
    return;
  }

  await deployCommands();
  await seedDatabase();

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  });

  const commandMap = new Collection<string, BotCommand>();
  for (const cmd of allCommands) {
    commandMap.set(cmd.data.name, cmd);
  }

  client.once("clientReady", (c) => {
    logger.info(`🤖 Bot online: ${c.user.tag}`);
    if (eventChannelId) {
      startWorldEngine(client, eventChannelId);
      logger.info("🌍 World engine started.");
    } else {
      logger.warn("DISCORD_EVENT_CHANNEL_ID não configurado — eventos globais desativados. Defina DISCORD_EVENT_CHANNEL_ID com o ID de um canal de texto.");
    }
  });

  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const command = commandMap.get(interaction.commandName);
    if (!command) return;

    try {
      await command.execute(interaction);
    } catch (err) {
      logger.error({ err, command: interaction.commandName }, "Error executing command");
      const reply = { content: "❌ Ocorreu um erro ao executar este comando.", ephemeral: true };
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(reply).catch(() => {});
      } else {
        await interaction.reply(reply).catch(() => {});
      }
    }
  });

  client.on("error", (err) => logger.error({ err }, "Discord client error"));
  client.on("warn", (msg) => logger.warn(msg));

  const reconnect = async (attempt = 1) => {
    try {
      await client.login(token);
    } catch (err) {
      const delay = Math.min(attempt * 5000, 60000);
      logger.error({ err, attempt }, `Login failed, retrying in ${delay / 1000}s...`);
      setTimeout(() => reconnect(attempt + 1), delay);
    }
  };

  client.on("disconnect", () => {
    logger.warn("Bot disconnected. Reconnecting...");
    reconnect();
  });

  await reconnect();
}
