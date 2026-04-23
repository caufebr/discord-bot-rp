import { Client, GatewayIntentBits, Collection, type ChatInputCommandInteraction } from "discord.js";
import { commands as economiaCommands } from "./commands/economia.js";
import { commands as adminCommands } from "./commands/admin.js";
import { commands as ajudaCommands } from "./commands/ajuda.js";
import { commands as lojaCommands } from "./commands/loja.js";
import { commands as recompensasCommands } from "./commands/recompensas.js";
import { commands as rgCommands } from "./commands/rg.js";
import { deployCommands } from "./deploy-commands.js";
import { seedDatabase } from "./systems/seed.js";
import { logger } from "../lib/logger.js";

interface BotCommand {
  data: { name: string; toJSON(): object };
  execute(interaction: ChatInputCommandInteraction): Promise<unknown>;
}

const allCommands: BotCommand[] = [
  ...economiaCommands,
  ...adminCommands,
  ...ajudaCommands,
  ...lojaCommands,
  ...recompensasCommands,
  ...rgCommands,
];

export async function startBot() {
  const token = process.env.DISCORD_TOKEN;

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
