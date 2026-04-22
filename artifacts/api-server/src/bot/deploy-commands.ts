import { REST, Routes } from "discord.js";
import { commands as economiaCommands } from "./commands/economia.js";
import { commands as profissaoCommands } from "./commands/profissao.js";
import { commands as crimeCommands } from "./commands/crime.js";
import { commands as ganguesCommands } from "./commands/gangues.js";
import { commands as politicaCommands } from "./commands/politica.js";
import { commands as saudeCommands } from "./commands/saude.js";
import { commands as bolsaCommands } from "./commands/bolsa.js";
import { commands as empresaCommands } from "./commands/empresa.js";

const allCommands = [
  ...economiaCommands,
  ...profissaoCommands,
  ...crimeCommands,
  ...ganguesCommands,
  ...politicaCommands,
  ...saudeCommands,
  ...bolsaCommands,
  ...empresaCommands,
].map(c => c.data.toJSON());

export async function deployCommands() {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID;

  if (!token || !clientId) {
    console.warn("⚠️ DISCORD_TOKEN or DISCORD_CLIENT_ID missing, skipping command deploy.");
    return;
  }

  const rest = new REST().setToken(token);

  try {
    console.log(`🔄 Deploying ${allCommands.length} slash commands...`);
    await rest.put(Routes.applicationCommands(clientId), { body: allCommands });
    console.log(`✅ ${allCommands.length} slash commands deployed successfully.`);
  } catch (err) {
    console.error("❌ Failed to deploy commands:", err);
  }
}
