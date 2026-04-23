import { SlashCommandBuilder, EmbedBuilder, type ChatInputCommandInteraction } from "discord.js";
import { eq, and } from "drizzle-orm";
import { db, schema } from "../systems/db.js";
import { getOrCreatePlayer, updatePlayer, removeMoney, formatMoney } from "../systems/player.js";
import { PET_SPECIES } from "../systems/shop.js";

const PET_PRICE = 1500;

function calcHunger(lastFed: Date, current: number): number {
  const hours = (Date.now() - lastFed.getTime()) / (1000 * 60 * 60);
  return Math.max(0, current - Math.floor(hours * 5));
}

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName("pet")
      .setDescription("Sistema de pets")
      .addSubcommand(s => s.setName("comprar").setDescription("Adotar um pet")
        .addStringOption(o => o.setName("especie").setDescription("Espécie").setRequired(true)
          .addChoices(...PET_SPECIES.map(s => ({ name: s, value: s }))))
        .addStringOption(o => o.setName("nome").setDescription("Nome do pet").setRequired(true)))
      .addSubcommand(s => s.setName("info").setDescription("Ver seus pets"))
      .addSubcommand(s => s.setName("alimentar").setDescription("Alimentar um pet com ração"))
      .addSubcommand(s => s.setName("renomear").setDescription("Renomear seu pet")
        .addStringOption(o => o.setName("novo_nome").setDescription("Novo nome").setRequired(true)))
      .addSubcommand(s => s.setName("sepultar").setDescription("Enterrar pet morto e liberar slot")),
    async execute(interaction: ChatInputCommandInteraction) {
      const player = await getOrCreatePlayer(interaction.user.id, interaction.user.username);
      const sub = interaction.options.getSubcommand();
      const myPets = await db.query.pets.findMany({ where: eq(schema.pets.ownerId, player.discordId) });
      const alive = myPets.filter(p => p.alive);

      if (sub === "comprar") {
        if (alive.length >= 3) return interaction.reply({ content: "❌ Você já tem 3 pets vivos. Espere um morrer ou sepulte.", ephemeral: true });
        if (player.balance < PET_PRICE) return interaction.reply({ content: `❌ Adoção custa ${formatMoney(PET_PRICE)}.`, ephemeral: true });
        const especie = interaction.options.getString("especie", true);
        const nome = interaction.options.getString("nome", true).slice(0, 30);
        await removeMoney(player.discordId, PET_PRICE);
        await db.insert(schema.pets).values({ ownerId: player.discordId, name: nome, species: especie });
        return interaction.reply({ content: `🐾 Você adotou **${nome}** (${especie}) por ${formatMoney(PET_PRICE)}! Não esqueça de alimentá-lo com \`/pet alimentar\`.` });
      }

      if (sub === "info") {
        if (myPets.length === 0) return interaction.reply({ content: "🐾 Você não tem pets. Use `/pet comprar`.", ephemeral: true });
        const embed = new EmbedBuilder().setTitle(`🐾 Pets de ${interaction.user.username}`).setColor(0x88aacc);
        for (const pet of myPets) {
          if (!pet.alive) {
            embed.addFields({ name: `💀 ${pet.name} (${pet.species})`, value: "Morreu de fome. Use `/pet sepultar`.", inline: false });
            continue;
          }
          const hunger = calcHunger(pet.lastFed, pet.hunger);
          if (hunger <= 0) {
            await db.update(schema.pets).set({ alive: false, hunger: 0 }).where(eq(schema.pets.id, pet.id));
            embed.addFields({ name: `💀 ${pet.name} (${pet.species})`, value: "Acabou de morrer de fome! 😢", inline: false });
          } else {
            embed.addFields({ name: `🐾 ${pet.name} (${pet.species})`, value: `🍖 Fome: ${hunger}/100\n${hunger < 30 ? "⚠️ FOME CRÍTICA!" : "✅ Saudável"}`, inline: true });
          }
        }
        return interaction.reply({ embeds: [embed], ephemeral: true });
      }

      if (sub === "alimentar") {
        if (alive.length === 0) return interaction.reply({ content: "🐾 Você não tem pets vivos.", ephemeral: true });
        const inv = { ...(player.inventory ?? {}) };
        if ((inv["racao_pet"] ?? 0) <= 0) return interaction.reply({ content: "❌ Você não tem ração. Compre na `/loja`.", ephemeral: true });

        const lines: string[] = [];
        for (const pet of alive) {
          if ((inv["racao_pet"] ?? 0) <= 0) break;
          const cur = calcHunger(pet.lastFed, pet.hunger);
          const newHunger = Math.min(100, cur + 50);
          await db.update(schema.pets).set({ hunger: newHunger, lastFed: new Date() }).where(eq(schema.pets.id, pet.id));
          inv["racao_pet"] = (inv["racao_pet"] ?? 1) - 1;
          lines.push(`🦴 **${pet.name}** alimentado! Fome: ${newHunger}/100`);
        }
        await updatePlayer(player.discordId, { inventory: inv });
        return interaction.reply({ content: lines.join("\n"), ephemeral: true });
      }

      if (sub === "renomear") {
        if (alive.length === 0) return interaction.reply({ content: "🐾 Sem pets vivos.", ephemeral: true });
        const novo = interaction.options.getString("novo_nome", true).slice(0, 30);
        const pet = alive[0];
        await db.update(schema.pets).set({ name: novo }).where(eq(schema.pets.id, pet.id));
        return interaction.reply({ content: `✅ Pet renomeado para **${novo}**.`, ephemeral: true });
      }

      if (sub === "sepultar") {
        const dead = myPets.filter(p => !p.alive);
        if (dead.length === 0) return interaction.reply({ content: "🐾 Nenhum pet para sepultar.", ephemeral: true });
        for (const p of dead) await db.delete(schema.pets).where(eq(schema.pets.id, p.id));
        return interaction.reply({ content: `⚰️ ${dead.length} pet(s) sepultado(s). Descansem em paz.`, ephemeral: true });
      }
    },
  },
];
