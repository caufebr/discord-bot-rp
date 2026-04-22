import { REST, Routes } from "discord.js";
import { commands as economiaCommands } from "./commands/economia.js";
import { commands as profissaoCommands } from "./commands/profissao.js";
import { commands as crimeCommands } from "./commands/crime.js";
import { commands as ganguesCommands } from "./commands/gangues.js";
import { commands as politicaCommands } from "./commands/politica.js";
import { commands as saudeCommands } from "./commands/saude.js";
import { commands as bolsaCommands } from "./commands/bolsa.js";
import { commands as empresaCommands } from "./commands/empresa.js";
import { commands as adminCommands } from "./commands/admin.js";
import { commands as ajudaCommands } from "./commands/ajuda.js";

const allCommands = [
  ...economiaCommands,
  ...profissaoCommands,
  ...crimeCommands,
  ...ganguesCommands,
  ...politicaCommands,
  ...saudeCommands,
  ...bolsaCommands,
  ...empresaCommands,
  ...adminCommands,
  ...ajudaCommands,
].map(c => c.data.toJSON());

function extractAppIdFromToken(token: string): string {
  const firstPart = token.split(".")[0];
  if (!firstPart) throw new Error("Invalid token format");
  return Buffer.from(firstPart, "base64").toString("utf-8");
}

export async function deployCommands() {
  const token = process.env.DISCORD_TOKEN;

  if (!token) {
    console.warn("⚠️ DISCORD_TOKEN missing, skipping command deploy.");
    return;
  }

  let clientId = process.env.DISCORD_CLIENT_ID ?? "";

  // Auto-extract application ID from token if the CLIENT_ID looks like a token
  if (!clientId || clientId.includes(".")) {
    try {
      clientId = extractAppIdFromToken(token);
      console.log(`🔧 Auto-extracted Application ID from token: ${clientId}`);
    } catch {
      console.warn("⚠️ Could not extract Application ID from token.");
      return;
    }
  }

  const rest = new REST().setToken(token);

  try {
    console.log(`🔄 Deploying ${allCommands.length} slash commands...`);
    await rest.put(Routes.applicationCommands(clientId), { body: allCommands });
    console.log(`✅ ${allCommands.length} slash commands deployed successfully!`);
  } catch (err) {
    console.error("❌ Failed to deploy commands:", err);
  }
}
