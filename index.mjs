import { Client, GatewayIntentBits } from "discord.js";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Anti-crash (ESSENCIAL no Railway)
process.on("unhandledRejection", console.error);
process.on("uncaughtException", console.error);

// Bot online
client.once("ready", () => {
  console.log(`Bot online como ${client.user.tag}`);
});

// Login seguro via Railway
client.login(process.env.DISCORD_TOKEN);
