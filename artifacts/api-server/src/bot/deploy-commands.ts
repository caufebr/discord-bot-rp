import { REST, Routes } from "discord.js";
import { commands as economiaCommands } from "./commands/economia.js";
import { commands as adminCommands } from "./commands/admin.js";
import { commands as ajudaCommands } from "./commands/ajuda.js";
import { commands as lojaCommands } from "./commands/loja.js";
import { commands as recompensasCommands } from "./commands/recompensas.js";
import { commands as rgCommands } from "./commands/rg.js";

const allCommands = [
  ...economiaCommands,
  ...adminCommands,
  ...ajudaCommands,
  ...lojaCommands,
  ...recompensasCommands,
  ...rgCommands,
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
