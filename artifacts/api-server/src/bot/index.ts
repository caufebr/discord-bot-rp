import { Client, GatewayIntentBits, Partials } from "discord.js";
import { handleMessage } from "./messages.js";
import { startWorldEngine } from "./systems/worldEvents.js";
import { startRadio } from "./systems/radio.js";
import { ensureSeason, startSeasonChecker } from "./systems/seasons.js";
import { startDebtCron } from "./systems/debts.js";
import { startLotteryCron } from "./systems/lottery.js";
import { startEventCron } from "./systems/economicEvents.js";
import { seedDatabase } from "./systems/seed.js";
import { clearSlashCommands } from "./deploy-commands.js";
import { logger } from "../lib/logger.js";

const RADIO_CHANNEL_ID = "1496352320194220113";

export async function startBot() {
  const token = process.env.DISCORD_TOKEN;
  const eventChannelId = process.env.DISCORD_EVENT_CHANNEL_ID ?? "";

  if (!token) {
    logger.warn("DISCORD_TOKEN not set — bot not started.");
    return;
  }

  await clearSlashCommands();
  await seedDatabase();
  await ensureSeason();

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent, // PRIVILEGED — habilite no Discord Developer Portal
    ],
    partials: [Partials.Channel, Partials.Message],
  });

  client.once("clientReady", (c) => {
    logger.info(`🤖 Bot online: ${c.user.tag} (prefixo: !)`);
    if (eventChannelId) {
      startWorldEngine(client, eventChannelId);
      logger.info("🌍 World engine iniciado.");
    } else {
      logger.warn("DISCORD_EVENT_CHANNEL_ID não configurado — eventos globais desativados.");
    }
    startRadio(client, RADIO_CHANNEL_ID);
    logger.info(`📻 Rádio iniciada (canal ${RADIO_CHANNEL_ID}).`);
    startSeasonChecker(client, eventChannelId || RADIO_CHANNEL_ID);
    logger.info("🔄 Verificador de temporadas iniciado.");
    startDebtCron();
    logger.info("📜 Cron de dívidas iniciado.");
    startLotteryCron(client, eventChannelId || RADIO_CHANNEL_ID);
    logger.info("🎰 Cron de loteria iniciado.");
    startEventCron(client, eventChannelId || RADIO_CHANNEL_ID);
    logger.info("📊 Cron de eventos econômicos iniciado.");
  });

  client.on("messageCreate", async (msg) => {
    try {
      await handleMessage(msg);
    } catch (err) {
      logger.error({ err }, "messageCreate handler error");
    }
  });

  client.on("error", (err) => logger.error({ err }, "Discord client error"));
  client.on("warn", (m) => logger.warn(m));

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
