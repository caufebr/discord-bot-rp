import type { Client, Message, TextChannel } from "discord.js";
import { EmbedBuilder } from "discord.js";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, schema } from "./systems/db.js";
import {
  getOrCreatePlayer,
  getPlayer,
  updatePlayer,
  addMoney,
  removeMoney,
  formatMoney,
  isJailed,
  isHospitalized,
  isDead,
  killPlayer,
} from "./systems/player.js";
import {
  getEconomy,
  getGovernment,
  logTransaction,
  cooldownLeft,
  formatCooldown,
  applyTax,
  PROFESSIONS,
  calcSalary,
  type ProfessionKey,
} from "./systems/economy.js";
import { SHOP_ITEMS, CROPS, WEAPONS, BR_STATES, POLITICAL_SIDES, GENDERS, PET_SPECIES } from "./systems/shop.js";
import { CAR_MODELS, depreciate, repairCost, MAINTENANCE_INTERVAL_MS, topSpeedFor, CATEGORY_TOP_SPEED } from "./systems/cars.js";
import { HOUSE_TYPES, HOUSE_UPGRADES } from "./systems/houses.js";
import { ANIMAL_SPECIES, HUNGER_DECAY_PER_HOUR } from "./systems/farmAnimals.js";
import { createDebt, listDebts, payDebt, checkBankruptcy, declareBankruptcy, DEFAULT_INTEREST, DEFAULT_DUE_DAYS } from "./systems/debts.js";
import { TICKET_PRICE, NUMBER_RANGE, getCurrentDraw, buyTicket } from "./systems/lottery.js";
import { MORAL_SCENARIOS, pickRandomScenario } from "./systems/morality.js";
import { BLACK_MARKET, MIN_RECORD_TO_ACCESS } from "./systems/blackmarket.js";
import { EVENT_DEFS, type EventType, getActiveEvent, startEvent } from "./systems/economicEvents.js";
import {
  BRANCHES,
  BRANCH_KEYS,
  FACTORY_BUILD_COST,
  FACTORY_UPGRADE_BASE,
  MAX_FACTORY_LEVEL,
  getBranch,
  findProduct,
  findMaterial,
} from "./systems/companyBranches.js";
import { logger } from "../lib/logger.js";

const PREFIX = "!";

type Handler = (msg: Message, args: string[]) => Promise<unknown>;
const commands = new Map<string, Handler>();

function reg(names: string[], h: Handler) {
  for (const n of names) commands.set(n.toLowerCase(), h);
}

const reply = (msg: Message, content: string | { embeds: EmbedBuilder[] }) =>
  typeof content === "string"
    ? msg.reply({ content }).catch(() => {})
    : msg.reply(content).catch(() => {});

function getMentionId(msg: Message, args: string[], idx: number): string | null {
  const first = msg.mentions.users.first();
  if (first) return first.id;
  const a = args[idx];
  if (a && /^\d{15,22}$/.test(a)) return a;
  return null;
}

function intArg(args: string[], idx: number): number | null {
  const v = parseInt((args[idx] ?? "").replace(/\D/g, ""), 10);
  return Number.isFinite(v) && v > 0 ? v : null;
}

// ============ HELPERS GLOBAIS ============
// GIFs animados (URLs públicas Tenor — Discord renderiza no embed.setImage)
export const GIFS: Record<string, string> = {
  work:    "https://media.tenor.com/L2EZkXKp9DkAAAAC/working-hard-simpsons.gif",
  plant:   "https://media.tenor.com/AKpukQwSDmcAAAAC/farming-game.gif",
  harvest: "https://media.tenor.com/Wu0w2cYABaAAAAAC/wheat-harvest.gif",
  farm:    "https://media.tenor.com/lB-IoDaTDjkAAAAC/farm-animals.gif",
  race:    "https://media.tenor.com/HG6gAOTKnHwAAAAC/fast-and-furious.gif",
  vote:    "https://media.tenor.com/Bt1PTpYNXukAAAAC/voting.gif",
  company: "https://media.tenor.com/r1RpXp0nfkkAAAAC/business-meeting.gif",
  money:   "https://media.tenor.com/m2MK1mOQ_OkAAAAC/money-rain.gif",
  level:   "https://media.tenor.com/n_Vk1NqI8oQAAAAC/level-up.gif",
  fight:   "https://media.tenor.com/lXMU0VhU8oQAAAAC/fight.gif",
};

// Confirmação por reação ✅ / ❌
export async function awaitConfirm(targetMsg: any, userId: string, timeoutMs = 30000): Promise<boolean | null> {
  if (!targetMsg) return null;
  await targetMsg.react("✅").catch(() => {});
  await targetMsg.react("❌").catch(() => {});
  try {
    const collected = await targetMsg.awaitReactions({
      filter: (r: any, u: any) => u.id === userId && (r.emoji.name === "✅" || r.emoji.name === "❌"),
      max: 1, time: timeoutMs, errors: ["time"],
    });
    const r = collected.first();
    if (!r) return null;
    return r.emoji.name === "✅";
  } catch { return null; }
}

// Reação 1️⃣ 2️⃣ 3️⃣ — escolhas múltiplas
export async function awaitChoice(targetMsg: any, userId: string, n: number, timeoutMs = 30000): Promise<number | null> {
  if (!targetMsg) return null;
  const NUMS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣"];
  const valid = NUMS.slice(0, Math.min(n, NUMS.length));
  for (const e of valid) await targetMsg.react(e).catch(() => {});
  try {
    const collected = await targetMsg.awaitReactions({
      filter: (r: any, u: any) => u.id === userId && valid.includes(r.emoji.name),
      max: 1, time: timeoutMs, errors: ["time"],
    });
    const r = collected.first();
    if (!r) return null;
    return valid.indexOf(r.emoji.name);
  } catch { return null; }
}

// Animação por edição de mensagem (multi-frame)
export async function animate(msg: Message, frames: { content?: string; image?: string; title?: string; color?: number }[], delayMs = 700): Promise<void> {
  const buildEmbed = (f: any) => {
    const e = new EmbedBuilder().setColor(f.color ?? 0x5865f2);
    if (f.title) e.setTitle(f.title);
    if (f.content) e.setDescription(f.content);
    if (f.image) e.setImage(f.image);
    return e;
  };
  const sent = await msg.reply({ embeds: [buildEmbed(frames[0])] }).catch(() => null);
  if (!sent) return;
  for (let i = 1; i < frames.length; i++) {
    await new Promise(r => setTimeout(r, delayMs));
    await sent.edit({ embeds: [buildEmbed(frames[i])] }).catch(() => {});
  }
}

// ============ XP / NÍVEL DO JOGADOR ============
const XP_PER_LEVEL = 200;
export function getXp(p: any): number { return (p.inventory?._xp as number) ?? 0; }
export function getPlayerLevel(p: any): number { return Math.floor(getXp(p) / XP_PER_LEVEL); }
export async function addXp(playerId: string, amount: number): Promise<{ leveled: boolean; newLevel: number }> {
  const fresh = await getPlayer(playerId);
  if (!fresh) return { leveled: false, newLevel: 0 };
  const inv = { ...(fresh.inventory ?? {}) };
  const oldXp = (inv._xp as number) ?? 0;
  const newXp = oldXp + amount;
  inv._xp = newXp;
  await updatePlayer(playerId, { inventory: inv });
  const oldLevel = Math.floor(oldXp / XP_PER_LEVEL);
  const newLevel = Math.floor(newXp / XP_PER_LEVEL);
  return { leveled: newLevel > oldLevel, newLevel };
}

// Escala social: nível mínimo pra exercer cada profissão
export const PROFESSION_REQUIRED_LEVEL: Record<string, number> = {
  faxineiro: 0, entregador: 0, atendente: 0,
  garcom: 3, mecanico: 3, bombeiro: 3, aeromoca: 3,
  policial: 5, professor: 5,
  engenheiro: 10, advogado: 10, medico: 10,
  piloto: 15, juiz: 15, empresario: 15,
};

// Profissões expandidas (mescla com PROFESSIONS de economy.ts; se faltar usa fallback)
export const EXTRA_PROFESSIONS: Record<string, { name: string; emoji: string; baseSalary: number; courseCost: number }> = {
  faxineiro:  { name: "Faxineiro",  emoji: "🧹", baseSalary: 800,  courseCost: 0 },
  entregador: { name: "Entregador", emoji: "📦", baseSalary: 1200, courseCost: 0 },
  atendente:  { name: "Atendente",  emoji: "🛎️", baseSalary: 1500, courseCost: 0 },
  garcom:     { name: "Garçom",     emoji: "🍽️", baseSalary: 2200, courseCost: 0 },
  professor:  { name: "Professor",  emoji: "📚", baseSalary: 4500, courseCost: 0 },
  engenheiro: { name: "Engenheiro", emoji: "👷", baseSalary: 9000, courseCost: 0 },
  juiz:       { name: "Juiz",       emoji: "⚖️", baseSalary: 15000, courseCost: 0 },
};
function getProfMeta(k: string): { name: string; emoji: string; baseSalary: number } | null {
  return (PROFESSIONS as any)[k] ?? EXTRA_PROFESSIONS[k] ?? null;
}

// Slots de plantação/animal armazenados no inventory
export const DEFAULT_SLOTS = { planta: 3, animal: 2 };
export function getSlots(p: any, kind: "planta" | "animal"): number {
  const key = `_slot_${kind}`;
  return (p.inventory?.[key] as number) ?? DEFAULT_SLOTS[kind];
}

// ============ ECONOMIA ============
reg(["saldo", "bal"], async (msg) => {
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const eco = await getEconomy();
  const e = new EmbedBuilder().setTitle("💰 Carteira").setColor(0x00ff88).addFields(
    { name: "💵 Em mãos", value: formatMoney(p.balance), inline: true },
    { name: "🏦 Banco", value: formatMoney(p.bankBalance), inline: true },
    { name: "📊 Inflação", value: `${((eco.inflation - 1) * 100).toFixed(1)}%`, inline: true },
  );
  return reply(msg, { embeds: [e] });
});

reg(["dep", "depositar"], async (msg, args) => {
  const v = intArg(args, 0);
  if (!v) return reply(msg, "❌ Uso: `!dep <valor>`");
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  if (p.balance < v) return reply(msg, "❌ Saldo insuficiente.");
  await updatePlayer(p.discordId, { balance: p.balance - v, bankBalance: p.bankBalance + v });
  await logTransaction(p.discordId, "BANK", v, "deposit", "Depósito");
  return reply(msg, `✅ Depositou ${formatMoney(v)} no banco.`);
});

reg(["sac", "sacar"], async (msg, args) => {
  const v = intArg(args, 0);
  if (!v) return reply(msg, "❌ Uso: `!sac <valor>`");
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  if (p.bankBalance < v) return reply(msg, "❌ Saldo bancário insuficiente.");
  const eco = await getEconomy();
  const tax = Math.floor(v * eco.bankTaxRate);
  const net = v - tax;
  await updatePlayer(p.discordId, { balance: p.balance + net, bankBalance: p.bankBalance - v });
  await logTransaction("BANK", p.discordId, net, "withdraw", `Saque (taxa ${formatMoney(tax)})`);
  return reply(msg, `✅ Sacou ${formatMoney(v)} (taxa ${formatMoney(tax)}) → recebeu ${formatMoney(net)}.`);
});

reg(["banco"], async (msg) => {
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const eco = await getEconomy();
  const e = new EmbedBuilder().setTitle("🏦 Banco").setColor(0x0099ff).addFields(
    { name: "💵 Em mãos", value: formatMoney(p.balance), inline: true },
    { name: "🏦 Banco", value: formatMoney(p.bankBalance), inline: true },
    { name: "💸 Taxa de saque", value: `${(eco.bankTaxRate * 100).toFixed(1)}%`, inline: true },
  ).setFooter({ text: "Use !dep <valor> ou !sac <valor>" });
  return reply(msg, { embeds: [e] });
});

reg(["pix", "transferir"], async (msg, args) => {
  const targetId = getMentionId(msg, args, 0);
  const v = intArg(args, msg.mentions.users.size > 0 ? 0 : 1);
  if (!targetId || !v) return reply(msg, "❌ Uso: `!pix @user <valor>`");
  if (targetId === msg.author.id) return reply(msg, "❌ Não pode transferir para si.");
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  if (p.balance < v) return reply(msg, "❌ Saldo insuficiente.");
  const eco = await getEconomy();
  const tax = Math.floor(v * eco.taxRate);
  const net = v - tax;
  const target = await getOrCreatePlayer(targetId, msg.mentions.users.first()?.username ?? "user");
  await updatePlayer(p.discordId, { balance: p.balance - v });
  await updatePlayer(target.discordId, { balance: target.balance + net });
  await logTransaction(p.discordId, target.discordId, net, "transfer", `PIX (imposto ${formatMoney(tax)})`);
  return reply(msg, `✅ Enviou ${formatMoney(v)} → recebido ${formatMoney(net)} (imposto ${formatMoney(tax)}).`);
});

reg(["work", "trabalhar"], async (msg) => {
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  if (isJailed(p)) return reply(msg, "❌ Você está preso!");
  if (isHospitalized(p)) return reply(msg, "❌ Você está hospitalizado!");
  if (isDead(p)) return reply(msg, "❌ Você está morto!");
  const cd = cooldownLeft(p.lastWork, 60 * 60 * 1000);
  if (cd > 0) return reply(msg, `⏳ Aguarde ${formatCooldown(cd)} pro próximo expediente.`);
  const lvl = getPlayerLevel(p);
  // Quanto maior o nível, mais ganha por turno
  const base = Math.floor(Math.random() * 200 + 150) * (1 + lvl * 0.15);
  const amount = Math.floor(await applyTax(base));
  const xpGain = 15 + Math.floor(Math.random() * 6);
  await updatePlayer(p.discordId, { balance: p.balance + amount, lastWork: new Date() });
  await logTransaction(null, p.discordId, amount, "work", "Expediente");
  const { leveled, newLevel } = await addXp(p.discordId, xpGain);
  // Se já tem profissão exercendo, ganha 1 nível de prática (rumo a certificação)
  if (p.profession) {
    const newProfLvl = (p.professionLevel ?? 0) + 1;
    await updatePlayer(p.discordId, { professionLevel: newProfLvl, isCertified: newProfLvl >= 10 });
  }
  await animate(msg, [
    { title: "💼 Indo trabalhar...", content: `${msg.author.username} bate o ponto.`, image: GIFS.work, color: 0x4488cc },
    { title: "💼 Trabalhando...", content: `Esforçando-se no expediente... \`${"█".repeat(3)}${"░".repeat(7)}\``, image: GIFS.work, color: 0x4488cc },
    { title: "💼 Quase lá...", content: `Última hora do turno... \`${"█".repeat(7)}${"░".repeat(3)}\``, image: GIFS.work, color: 0x4488cc },
    {
      title: "✅ Expediente concluído!",
      content: `💰 +${formatMoney(amount)}\n✨ +${xpGain} XP (Nível ${getPlayerLevel({ inventory: { _xp: getXp(p) + xpGain } })})${leveled ? `\n🎉 **SUBIU PARA NÍVEL ${newLevel}!**` : ""}\n⏳ Próximo expediente em 1h`,
      image: leveled ? GIFS.level : GIFS.money,
      color: leveled ? 0xffaa00 : 0x00aa44,
    },
  ], 800);
});

reg(["sal", "salario"], async (msg) => {
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  if (!p.profession) return reply(msg, "❌ Você não tem profissão. Veja `!profs` e use `!curso <profissão>` (sem custo).");
  if (isJailed(p)) return reply(msg, "❌ Você está preso!");
  const cd = cooldownLeft(p.lastSalary, 8 * 60 * 60 * 1000);
  if (cd > 0) return reply(msg, `⏳ Próximo salário em ${formatCooldown(cd)}.`);
  const meta = getProfMeta(p.profession);
  if (!meta) return reply(msg, "❌ Profissão inválida.");
  const lvl = getPlayerLevel(p);
  const profLvl = p.professionLevel ?? 0;
  // Salário escala com nível social + prática na profissão
  const salary = Math.floor(meta.baseSalary * (1 + lvl * 0.1) * (1 + profLvl * 0.05));
  const net = await applyTax(salary);
  await updatePlayer(p.discordId, { balance: p.balance + net, lastSalary: new Date() });
  await logTransaction(null, p.discordId, net, "salary", `Salário ${meta.name}`);
  return reply(msg, `${meta.emoji} **Salário recebido**\n💰 ${formatMoney(net)} (bruto ${formatMoney(salary)})\n📊 Nv ${lvl} · Prática Nv ${profLvl}${profLvl >= 10 ? " · 🎖️ Certificado" : ""}\n⏳ Próximo em 8h`);
});

// ============ RECOMPENSAS ============
const DAY_MS = 24 * 60 * 60 * 1000;

reg(["day", "daily"], async (msg) => {
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const left = p.lastDaily ? Math.max(0, DAY_MS - (Date.now() - p.lastDaily.getTime())) : 0;
  if (left > 0) return reply(msg, `⏳ Próxima daily em ${formatCooldown(left)}.`);
  let streak = p.dailyStreak ?? 0;
  if (p.lastDaily && Date.now() - p.lastDaily.getTime() <= 2 * DAY_MS) streak += 1;
  else streak = 1;
  const total = 1000 + Math.min(streak - 1, 14) * 250;
  await updatePlayer(p.discordId, { balance: p.balance + total, lastDaily: new Date(), dailyStreak: streak });
  await logTransaction(null, p.discordId, total, "daily", `Streak ${streak}`);
  return reply(msg, `🎁 Daily: ${formatMoney(total)} | 🔥 Streak: ${streak}`);
});

reg(["week", "weekly"], async (msg) => {
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const left = p.lastWeekly ? Math.max(0, 7 * DAY_MS - (Date.now() - p.lastWeekly.getTime())) : 0;
  if (left > 0) return reply(msg, `⏳ Próxima semanal em ${formatCooldown(left)}.`);
  await updatePlayer(p.discordId, { balance: p.balance + 12000, lastWeekly: new Date() });
  await logTransaction(null, p.discordId, 12000, "weekly", "Semanal");
  return reply(msg, `📦 Recompensa semanal: ${formatMoney(12000)}.`);
});

reg(["bonus"], async (msg) => {
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const left = p.lastBonus ? Math.max(0, 4 * 60 * 60 * 1000 - (Date.now() - p.lastBonus.getTime())) : 0;
  if (left > 0) return reply(msg, `⏳ Próximo bônus em ${formatCooldown(left)}.`);
  const total = Math.floor(Math.random() * 1500 + 500);
  await updatePlayer(p.discordId, { balance: p.balance + total, lastBonus: new Date() });
  await logTransaction(null, p.discordId, total, "bonus", "Bônus");
  return reply(msg, `🎰 Bônus: ${formatMoney(total)}.`);
});

// ============ LOJA / INVENTÁRIO ============
reg(["loja"], async (msg) => {
  const e = new EmbedBuilder().setTitle("🛒 Loja").setColor(0xffaa00);
  for (const [k, item] of Object.entries(SHOP_ITEMS)) {
    e.addFields({ name: `${item.emoji} ${item.name} — ${formatMoney(item.price)}`, value: `\`!comprar ${k}\` — ${item.description}`, inline: false });
  }
  return reply(msg, { embeds: [e] });
});

reg(["comprar"], async (msg, args) => {
  const itemKey = args[0]?.toLowerCase();
  const qty = intArg(args, 1) ?? 1;
  if (!itemKey || !(itemKey in SHOP_ITEMS)) return reply(msg, "❌ Uso: `!comprar <item> [qtd]`. Veja `!loja`.");
  const item = (SHOP_ITEMS as any)[itemKey];
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const total = item.price * qty;
  if (p.balance < total) return reply(msg, `❌ Custa ${formatMoney(total)}, você tem ${formatMoney(p.balance)}.`);
  await removeMoney(p.discordId, total);
  const inv = { ...(p.inventory ?? {}) };
  inv[itemKey] = (inv[itemKey] ?? 0) + qty;
  await updatePlayer(p.discordId, { inventory: inv });
  await logTransaction(p.discordId, "SHOP", total, "shop_buy", `${qty}x ${item.name}`);
  return reply(msg, `✅ Comprou ${qty}x ${item.emoji} ${item.name} por ${formatMoney(total)}.`);
});

reg(["inv", "mochila", "inventario"], async (msg) => {
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const inv = p.inventory ?? {};
  const entries = Object.entries(inv).filter(([, q]) => (q as number) > 0);
  const e = new EmbedBuilder().setTitle(`🎒 Mochila — ${msg.author.username}`).setColor(0x885500);
  if (entries.length === 0) e.setDescription("Vazia. Use `!loja`.");
  else e.setDescription(entries.map(([k, q]) => {
    const it = (SHOP_ITEMS as any)[k];
    return it ? `${it.emoji} **${it.name}** × ${q}` : `📦 ${k} × ${q}`;
  }).join("\n"));
  e.addFields(
    { name: "🔫 Arma", value: p.weapon ?? "Nenhuma", inline: true },
    { name: "💵 Dinheiro", value: formatMoney(p.balance), inline: true },
    { name: "🏦 Banco", value: formatMoney(p.bankBalance), inline: true },
  );
  return reply(msg, { embeds: [e] });
});

// ============ RG / PERFIL ============
reg(["perfil"], async (msg, args) => {
  if (args.length < 4) return reply(msg, "❌ Uso: `!perfil <UF> <cidade> <gênero> <politica>`\nEx: `!perfil SP \"São Paulo\" Masculino Direita`");
  const estado = (args[0] ?? "").toUpperCase();
  const cidade = args[1]!;
  const genero = args[2]!;
  const politica = args[3]!;
  if (!BR_STATES[estado]) return reply(msg, `❌ UF inválida. Ex: SP, RJ, MG, BA.`);
  if (!GENDERS.includes(genero as any)) return reply(msg, `❌ Gênero inválido. Opções: ${GENDERS.join(", ")}`);
  if (!POLITICAL_SIDES.includes(politica as any)) return reply(msg, `❌ Lado político inválido. Opções: ${POLITICAL_SIDES.join(", ")}`);
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  await updatePlayer(p.discordId, { state: estado, city: cidade, gender: genero, politicalSide: politica, rgCreatedAt: p.rgCreatedAt ?? new Date() });
  return reply(msg, `🪪 RG ${p.rgCreatedAt ? "atualizado" : "criado"}! Use \`!rg\`.`);
});

reg(["rg"], async (msg, args) => {
  const targetId = getMentionId(msg, args, 0) ?? msg.author.id;
  const username = msg.mentions.users.first()?.username ?? msg.author.username;
  const p = await getOrCreatePlayer(targetId, username);
  if (!p.state) return reply(msg, targetId === msg.author.id ? "🪪 RG não criado. Use `!perfil`." : `🪪 ${username} não tem RG.`);
  const e = new EmbedBuilder().setTitle(`🪪 RG — ${username}`).setColor(0x4488cc).addFields(
    { name: "📍 Estado", value: p.state, inline: true },
    { name: "🏙️ Cidade", value: p.city ?? "—", inline: true },
    { name: "⚧ Gênero", value: p.gender ?? "—", inline: true },
    { name: "🗳️ Política", value: p.politicalSide ?? "—", inline: true },
    { name: "💼 Profissão", value: p.profession ?? "Desempregado", inline: true },
    { name: "🏴 Gangue", value: p.gangId ? `Sim (${p.gangRank})` : "Não", inline: true },
    { name: "💍 Estado civil", value: p.partnerId ? `Casado com <@${p.partnerId}>` : "Solteiro", inline: true },
    { name: "🎓 Certificações", value: (p.certifications && p.certifications.length > 0) ? p.certifications.join(", ") : "Nenhuma", inline: false },
    { name: "❤️ Saúde", value: `${p.health}/${p.maxHealth}`, inline: true },
    { name: "⚡ Energia", value: `${p.energy}/100`, inline: true },
    { name: "⭐ Reputação", value: `${p.reputation}`, inline: true },
  );
  return reply(msg, { embeds: [e] });
});

// ============ PROFISSÕES (escala social por nível) ============
reg(["profs", "profissoes"], async (msg) => {
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const lvl = getPlayerLevel(p);
  const all = { ...PROFESSIONS, ...EXTRA_PROFESSIONS } as Record<string, { name: string; emoji: string; baseSalary: number }>;
  const tiers: Record<string, string[]> = { "🟢 Tier 1 (Nv 0+)": [], "🔵 Tier 2 (Nv 3+)": [], "🟡 Tier 3 (Nv 5+)": [], "🟠 Tier 4 (Nv 10+)": [], "🔴 Tier 5 (Nv 15+)": [] };
  for (const [k, prof] of Object.entries(all)) {
    const req = PROFESSION_REQUIRED_LEVEL[k] ?? 0;
    const lock = lvl >= req ? "" : " 🔒";
    const line = `${prof.emoji} **${prof.name}** — ${formatMoney(prof.baseSalary)}/turno · \`!curso ${k}\`${lock}`;
    if (req >= 15) tiers["🔴 Tier 5 (Nv 15+)"].push(line);
    else if (req >= 10) tiers["🟠 Tier 4 (Nv 10+)"].push(line);
    else if (req >= 5) tiers["🟡 Tier 3 (Nv 5+)"].push(line);
    else if (req >= 3) tiers["🔵 Tier 2 (Nv 3+)"].push(line);
    else tiers["🟢 Tier 1 (Nv 0+)"].push(line);
  }
  const e = new EmbedBuilder().setTitle("👔 Escala Social de Profissões").setColor(0x00aaff)
    .setDescription(`Seu nível atual: **${lvl}** · XP: ${getXp(p)}/${(lvl + 1) * XP_PER_LEVEL}\nUse \`!work\` (a cada 1h) pra ganhar XP e subir de nível.`);
  for (const [tier, lines] of Object.entries(tiers)) {
    if (lines.length > 0) e.addFields({ name: tier, value: lines.join("\n"), inline: false });
  }
  return reply(msg, { embeds: [e] });
});

reg(["curso", "escolherprof"], async (msg, args) => {
  const k = args[0]?.toLowerCase();
  if (!k) return reply(msg, "❌ Uso: `!curso <profissao>`. Veja `!profs`.");
  const meta = getProfMeta(k);
  if (!meta) return reply(msg, "❌ Profissão desconhecida. Veja `!profs`.");
  const req = PROFESSION_REQUIRED_LEVEL[k] ?? 0;
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const lvl = getPlayerLevel(p);
  if (lvl < req) return reply(msg, `🔒 Precisa de nível **${req}** pra exercer **${meta.name}**. Você está no nível ${lvl}. Use \`!work\` pra subir.`);
  // Trocar de profissão zera o nível de prática (mas mantém XP global)
  await updatePlayer(p.discordId, { profession: k, professionLevel: 0, isCertified: false, isTraining: false, trainingEnd: null, trainingFor: null });
  return reply(msg, `${meta.emoji} Agora você exerce **${meta.name}**!\n📈 A cada \`!work\` você ganha 1 nível de prática. No nível 10 vira certificado oficial.\n💰 Salário base: ${formatMoney(meta.baseSalary)} (a cada 8h via \`!sal\`)`);
});

reg(["treinar"], async (msg) => {
  return reply(msg, "ℹ️ O sistema de cursos foi substituído. Agora basta usar `!work` pra ganhar prática na sua profissão. No nível 10 de prática você vira certificado.");
});

// ============ SAÚDE ============
reg(["saude"], async (msg) => {
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const e = new EmbedBuilder().setTitle("❤️ Saúde").setColor(0xff5577).addFields(
    { name: "Saúde", value: `${p.health}/${p.maxHealth}`, inline: true },
    { name: "Energia", value: `${p.energy}/100`, inline: true },
    { name: "Hospitalizado", value: p.isHospitalized ? "Sim" : "Não", inline: true },
    { name: "Seguro", value: p.insurance ? "✅" : "❌", inline: true },
  );
  return reply(msg, { embeds: [e] });
});

reg(["hospital"], async (msg) => {
  const COST = 2000;
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  if (p.balance < COST) return reply(msg, `❌ Tratamento custa ${formatMoney(COST)}.`);
  await removeMoney(p.discordId, COST);
  await updatePlayer(p.discordId, { health: p.maxHealth, isHospitalized: false, hospitalizationEnd: null });
  return reply(msg, `🏥 Tratado. Saúde restaurada por ${formatMoney(COST)}.`);
});

reg(["seguro"], async (msg) => {
  const COST = 3000;
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  if (p.balance < COST) return reply(msg, `❌ Seguro custa ${formatMoney(COST)}/semana.`);
  await removeMoney(p.discordId, COST);
  await updatePlayer(p.discordId, { insurance: true, insuranceEnd: new Date(Date.now() + 7 * DAY_MS) });
  return reply(msg, `🛡️ Seguro adquirido por 7 dias.`);
});

reg(["curar"], async (msg, args) => {
  const tid = getMentionId(msg, args, 0);
  if (!tid) return reply(msg, "❌ Uso: `!curar @user`");
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  if (p.profession !== "medico" || !p.isCertified) return reply(msg, "❌ Só médicos certificados.");
  const t = await getPlayer(tid);
  if (!t) return reply(msg, "❌ Jogador não encontrado.");
  await updatePlayer(t.discordId, { health: t.maxHealth });
  return reply(msg, `💉 ${t.username} foi curado.`);
});

reg(["defender"], async (msg, args) => {
  const tid = getMentionId(msg, args, 0);
  if (!tid) return reply(msg, "❌ Uso: `!defender @user`");
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  if (p.profession !== "advogado" || !p.isCertified) return reply(msg, "❌ Só advogados certificados.");
  const t = await getPlayer(tid);
  if (!t || !t.isJailed) return reply(msg, "❌ Jogador não está preso.");
  await updatePlayer(t.discordId, { isJailed: false, jailEnd: null });
  return reply(msg, `⚖️ ${t.username} foi solto.`);
});

// ============ CRIME ============
const CRIMES = [
  { tipo: "furto", min: 100, max: 300, risk: 0.2, desc: "Pequeno furto" },
  { tipo: "assalto", min: 400, max: 900, risk: 0.4, desc: "Assalto a mão armada" },
  { tipo: "trafico", min: 1500, max: 4000, risk: 0.6, desc: "Tráfico" },
  { tipo: "banco", min: 5000, max: 15000, risk: 0.85, desc: "Roubo a banco" },
];

reg(["crime"], async (msg, args) => {
  const tipo = args[0]?.toLowerCase();
  const c = CRIMES.find(x => x.tipo === tipo);
  if (!c) return reply(msg, `❌ Uso: \`!crime <tipo>\`. Tipos: ${CRIMES.map(x => x.tipo).join(", ")}`);
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  if (isJailed(p)) return reply(msg, "❌ Você está preso!");
  const cd = cooldownLeft(p.lastCrime, 30 * 60 * 1000);
  if (cd > 0) return reply(msg, `⏳ Aguarde ${formatCooldown(cd)}.`);
  await updatePlayer(p.discordId, { lastCrime: new Date() });
  if (Math.random() < c.risk) {
    const jailMin = 5 + Math.floor(c.risk * 30);
    await updatePlayer(p.discordId, { isJailed: true, jailEnd: new Date(Date.now() + jailMin * 60 * 1000), wantedLevel: p.wantedLevel + 1, criminalRecord: p.criminalRecord + 1 });
    return reply(msg, `🚔 Pego! Preso por ${jailMin} min. Use \`!fugir\`.`);
  }
  const reward = Math.floor(Math.random() * (c.max - c.min) + c.min);
  await addMoney(p.discordId, reward);
  await logTransaction(null, p.discordId, reward, "crime", c.desc);
  return reply(msg, `💰 ${c.desc} bem-sucedido! Ganhou ${formatMoney(reward)}.`);
});

reg(["roubar", "assaltar"], async (msg, args) => {
  const tid = getMentionId(msg, args, 0);
  if (!tid) return reply(msg, "❌ Uso: `!roubar @user`");
  if (tid === msg.author.id) return reply(msg, "❌ Não pode se roubar.");
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  if (isJailed(p)) return reply(msg, "❌ Está preso!");
  const cd = cooldownLeft(p.lastRob, 30 * 60 * 1000);
  if (cd > 0) return reply(msg, `⏳ Aguarde ${formatCooldown(cd)}.`);
  const t = await getPlayer(tid);
  if (!t) return reply(msg, "❌ Alvo inválido.");
  if (t.balance < 100) return reply(msg, "❌ Alvo sem dinheiro.");
  await updatePlayer(p.discordId, { lastRob: new Date() });
  if (Math.random() < 0.5) {
    await updatePlayer(p.discordId, { isJailed: true, jailEnd: new Date(Date.now() + 20 * 60 * 1000) });
    return reply(msg, `🚔 Foi pego e preso por 20 min!`);
  }
  const stolen = Math.floor(t.balance * (0.1 + Math.random() * 0.2));
  await updatePlayer(t.discordId, { balance: t.balance - stolen });
  await addMoney(p.discordId, stolen);
  await logTransaction(t.discordId, p.discordId, stolen, "rob", "Assalto");
  return reply(msg, `💰 Roubou ${formatMoney(stolen)} de ${t.username}.`);
});

reg(["ficha"], async (msg) => {
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const e = new EmbedBuilder().setTitle(`🦹 Ficha — ${msg.author.username}`).setColor(0xff5555).addFields(
    { name: "Procurado", value: `${"⭐".repeat(Math.min(5, p.wantedLevel)) || "Limpo"}`, inline: true },
    { name: "Crimes", value: `${p.criminalRecord}`, inline: true },
    { name: "Preso", value: p.isJailed ? `Sim (${p.jailEnd ? formatCooldown(p.jailEnd.getTime() - Date.now()) : "?"})` : "Não", inline: true },
  );
  return reply(msg, { embeds: [e] });
});

reg(["prender"], async (msg, args) => {
  const tid = getMentionId(msg, args, 0);
  const min = intArg(args, msg.mentions.users.size > 0 ? 0 : 1) ?? 30;
  if (!tid) return reply(msg, "❌ Uso: `!prender @user [min]`");
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  if (p.profession !== "policial" || !p.isCertified) return reply(msg, "❌ Só policiais certificados.");
  const t = await getPlayer(tid);
  if (!t) return reply(msg, "❌ Suspeito não encontrado.");
  await updatePlayer(t.discordId, { isJailed: true, jailEnd: new Date(Date.now() + Math.min(120, min) * 60 * 1000), wantedLevel: 0 });
  return reply(msg, `👮 ${t.username} preso por ${Math.min(120, min)} min.`);
});

// ============ FUGA DA PRISÃO ============
const QUIZ = [
  { q: "Quanto é 13 × 17?", a: "221" },
  { q: "Capital da Austrália?", a: "canberra" },
  { q: "Em que ano caiu o muro de Berlim?", a: "1989" },
  { q: "Qual o maior planeta do sistema solar?", a: "jupiter" },
  { q: "Quanto é a raiz quadrada de 144?", a: "12" },
  { q: "Quem pintou a Mona Lisa?", a: "da vinci" },
  { q: "Qual é o elemento Au na tabela periódica?", a: "ouro" },
  { q: "Quantos lados tem um decágono?", a: "10" },
];

reg(["fugir"], async (msg) => {
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  if (!isJailed(p)) return reply(msg, "❌ Você não está preso.");
  const q = QUIZ[Math.floor(Math.random() * QUIZ.length)]!;
  await reply(msg, `🚪 **Fuga!** Responda em 30s:\n**${q.q}**`);
  const filter = (m: Message) => m.author.id === msg.author.id;
  const channel = msg.channel as TextChannel;
  try {
    const collected = await channel.awaitMessages({ filter, max: 1, time: 30_000, errors: ["time"] });
    const ans = collected.first()!.content.trim().toLowerCase();
    if (ans === q.a.toLowerCase()) {
      const newEnd = p.jailEnd ? new Date(p.jailEnd.getTime() - 30 * 60 * 1000) : null;
      const stillJailed = newEnd && newEnd > new Date();
      await updatePlayer(p.discordId, { isJailed: !!stillJailed, jailEnd: stillJailed ? newEnd : null });
      return reply(msg, stillJailed ? `✅ Acertou! Pena reduzida em 30 min. Restam ${formatCooldown(newEnd!.getTime() - Date.now())}.` : `✅ Acertou e fugiu! Está livre!`);
    }
    return reply(msg, `❌ Errado. Resposta: **${q.a}**. Continua preso.`);
  } catch {
    return reply(msg, `⏰ Tempo esgotado. Continua preso.`);
  }
});

// ============ FAZENDA VEGETAL ============
reg(["plantar"], async (msg, args) => {
  const seed = args[0]?.toLowerCase();
  if (!seed) return reply(msg, "❌ Uso: `!plantar <semente>` (ex: semente_milho). Veja `!loja`.");
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const inv = { ...(p.inventory ?? {}) };
  if (!inv[seed] || inv[seed]! <= 0) return reply(msg, "❌ Você não tem essa semente.");
  const item = (SHOP_ITEMS as any)[seed];
  if (!item || item.type !== "seed") return reply(msg, "❌ Item não é semente.");
  // Verifica slots
  const activePlots = await db.query.plots.findMany({ where: and(eq(schema.plots.ownerId, p.discordId), eq(schema.plots.harvested, false)) });
  const maxSlots = getSlots(p, "planta");
  if (activePlots.length >= maxSlots) {
    return reply(msg, `🚫 Você já tem **${activePlots.length}/${maxSlots}** canteiros ocupados. Compre mais com \`!comprarslot planta\`.`);
  }
  const crop = CROPS[item.cropKey!]!;
  let minutes = crop.growMinutes;
  if (inv["fertilizante"] && inv["fertilizante"]! > 0) {
    minutes = Math.floor(minutes * 0.6);
    inv["fertilizante"]! -= 1;
  }
  inv[seed]! -= 1;
  const ready = new Date(Date.now() + minutes * 60 * 1000);
  await db.insert(schema.plots).values({ ownerId: p.discordId, crop: item.cropKey!, readyAt: ready });
  await updatePlayer(p.discordId, { inventory: inv });
  await animate(msg, [
    { title: "🌍 Preparando o solo...", content: "Removendo pedras e ervas daninhas.", image: GIFS.plant, color: 0x88aa44 },
    { title: "🚜 Arando o terreno...", content: "Revolvendo a terra...", image: GIFS.plant, color: 0x88aa44 },
    { title: "🌱 Plantando a semente...", content: `${crop.emoji} ${crop.name}`, image: GIFS.plant, color: 0x88aa44 },
    { title: "💧 Regando...", content: "Água fresquinha...", image: GIFS.plant, color: 0x4488cc },
    {
      title: "✅ Plantado com sucesso!",
      content: `${crop.emoji} **${crop.name}** plantado.\n⏳ Pronto em ${minutes} min${inv["fertilizante"] !== undefined ? " (com fertilizante)" : ""}.\n🪴 Canteiros: ${activePlots.length + 1}/${maxSlots}`,
      image: GIFS.plant, color: 0x00aa44,
    },
  ], 700);
});

reg(["plant", "plantacao"], async (msg) => {
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const plots = await db.query.plots.findMany({ where: and(eq(schema.plots.ownerId, p.discordId), eq(schema.plots.harvested, false)) });
  if (plots.length === 0) return reply(msg, "🌾 Nenhuma plantação ativa.");
  const e = new EmbedBuilder().setTitle("🌾 Plantações").setColor(0x88cc44);
  for (const pl of plots) {
    const crop = CROPS[pl.crop]!;
    const left = pl.readyAt.getTime() - Date.now();
    e.addFields({ name: `${crop.emoji} ${crop.name}`, value: left > 0 ? `⏳ ${formatCooldown(left)}` : "✅ Pronto!", inline: true });
  }
  return reply(msg, { embeds: [e] });
});

reg(["colher"], async (msg) => {
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const ready = await db.query.plots.findMany({ where: and(eq(schema.plots.ownerId, p.discordId), eq(schema.plots.harvested, false)) });
  const harvestable = ready.filter(r => r.readyAt.getTime() <= Date.now());
  if (harvestable.length === 0) return reply(msg, "🌾 Nada pronto ainda.");
  let total = 0;
  const cropNames: string[] = [];
  for (const pl of harvestable) {
    const crop = CROPS[pl.crop]!;
    const earn = Math.floor(Math.random() * (crop.sellMax - crop.sellMin) + crop.sellMin);
    total += earn;
    cropNames.push(`${crop.emoji} ${crop.name}`);
    await db.update(schema.plots).set({ harvested: true }).where(eq(schema.plots.id, pl.id));
  }
  const net = await applyTax(total);
  await addMoney(p.discordId, net);
  await logTransaction(null, p.discordId, net, "harvest", `Colheita ${harvestable.length}`);
  await animate(msg, [
    { title: "🌾 Indo até a roça...", content: "Pegando a foice e os baldes.", image: GIFS.harvest, color: 0xddaa00 },
    { title: "🌾 Colhendo...", content: cropNames.slice(0, 5).join(", "), image: GIFS.harvest, color: 0xddaa00 },
    { title: "🛒 Vendendo no mercado...", content: "Carregando o caminhão...", image: GIFS.money, color: 0x44aa00 },
    { title: "✅ Colheita finalizada!", content: `📦 **${harvestable.length}** colheita(s)\n💰 +${formatMoney(net)} (após impostos)`, image: GIFS.money, color: 0x00aa44 },
  ], 700);
});

// ============ SLOTS DA FAZENDA ============
reg(["comprarslot", "comprarslots"], async (msg, args) => {
  const kind = args[0]?.toLowerCase();
  if (kind !== "planta" && kind !== "animal") return reply(msg, "❌ Uso: `!comprarslot <planta|animal>`");
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const cur = getSlots(p, kind);
  // Custo dobra a cada slot extra
  const extras = cur - DEFAULT_SLOTS[kind];
  const cost = 5000 * Math.pow(2, extras);
  if (p.balance < cost) return reply(msg, `❌ Custa ${formatMoney(cost)} pra ir de ${cur}→${cur + 1} slots de ${kind}. Você tem ${formatMoney(p.balance)}.`);
  await removeMoney(p.discordId, cost);
  const inv = { ...(p.inventory ?? {}) };
  inv[`_slot_${kind}`] = cur + 1;
  await updatePlayer(p.discordId, { inventory: inv });
  await logTransaction(p.discordId, "FARM", cost, "slot_buy", `+1 slot ${kind}`);
  return reply(msg, `✅ Comprou +1 slot de **${kind}** por ${formatMoney(cost)}. Total: **${cur + 1}** slots.`);
});

// ============ CASSINO ============
const MIN_BET = 50, MAX_BET = 100000;

reg(["slot"], async (msg, args) => {
  const v = intArg(args, 0);
  if (!v || v < MIN_BET || v > MAX_BET) return reply(msg, `❌ Aposta entre ${formatMoney(MIN_BET)} e ${formatMoney(MAX_BET)}. Uso: \`!slot <valor>\``);
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  if (p.balance < v) return reply(msg, "❌ Sem saldo.");
  const symbols = ["🍒", "🍋", "🍇", "🔔", "💎", "7️⃣"];
  const r = [0, 0, 0].map(() => symbols[Math.floor(Math.random() * symbols.length)]);
  let mult = 0;
  if (r[0] === r[1] && r[1] === r[2]) mult = r[0] === "7️⃣" ? 25 : r[0] === "💎" ? 10 : 5;
  else if (r[0] === r[1] || r[1] === r[2]) mult = 1.5;
  const win = Math.floor(v * mult);
  await updatePlayer(p.discordId, { balance: p.balance - v + win });
  await logTransaction(null, p.discordId, win - v, "casino", "slot");
  return reply(msg, `🎰 ${r.join(" | ")}\n${win > v ? `🎉 Ganhou ${formatMoney(win)}` : win > 0 ? `Recuperou ${formatMoney(win)}` : `💸 Perdeu ${formatMoney(v)}`}`);
});

reg(["roleta"], async (msg, args) => {
  const cor = args[0]?.toLowerCase();
  const v = intArg(args, 1);
  if (!cor || !["vermelho", "preto", "verde"].includes(cor) || !v) return reply(msg, "❌ Uso: `!roleta <vermelho|preto|verde> <valor>`");
  if (v < MIN_BET || v > MAX_BET) return reply(msg, `❌ Aposta entre ${formatMoney(MIN_BET)} e ${formatMoney(MAX_BET)}.`);
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  if (p.balance < v) return reply(msg, "❌ Sem saldo.");
  const roll = Math.random();
  const result = roll < 0.05 ? "verde" : roll < 0.525 ? "vermelho" : "preto";
  const mult = result === cor ? (cor === "verde" ? 14 : 2) : 0;
  const win = v * mult;
  await updatePlayer(p.discordId, { balance: p.balance - v + win });
  return reply(msg, `🎡 Saiu **${result}**! ${win > 0 ? `🎉 Ganhou ${formatMoney(win)}` : `💸 Perdeu ${formatMoney(v)}`}`);
});

reg(["dado"], async (msg, args) => {
  const esc = args[0]?.toLowerCase();
  const v = intArg(args, 1);
  if (!esc || !["alto", "baixo", "exato"].includes(esc) || !v) return reply(msg, "❌ Uso: `!dado <alto|baixo|exato> <valor> [num]`");
  if (v < MIN_BET || v > MAX_BET) return reply(msg, `❌ Aposta entre ${formatMoney(MIN_BET)} e ${formatMoney(MAX_BET)}.`);
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  if (p.balance < v) return reply(msg, "❌ Sem saldo.");
  const roll = Math.floor(Math.random() * 6) + 1;
  let win = 0;
  if (esc === "alto" && roll >= 4) win = v * 2;
  if (esc === "baixo" && roll <= 3) win = v * 2;
  if (esc === "exato") {
    const num = intArg(args, 2);
    if (!num || num < 1 || num > 6) return reply(msg, "❌ Para `exato` informe um número 1-6.");
    if (roll === num) win = v * 5;
  }
  await updatePlayer(p.discordId, { balance: p.balance - v + win });
  return reply(msg, `🎲 Saiu **${roll}**! ${win > 0 ? `🎉 Ganhou ${formatMoney(win)}` : `💸 Perdeu ${formatMoney(v)}`}`);
});

reg(["bicho"], async (msg, args) => {
  const num = intArg(args, 0);
  const v = intArg(args, 1);
  if (!num || num < 1 || num > 25 || !v) return reply(msg, "❌ Uso: `!bicho <1-25> <valor>`");
  if (v < MIN_BET || v > MAX_BET) return reply(msg, `❌ Aposta entre ${formatMoney(MIN_BET)} e ${formatMoney(MAX_BET)}.`);
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  if (p.balance < v) return reply(msg, "❌ Sem saldo.");
  const roll = Math.floor(Math.random() * 25) + 1;
  const win = roll === num ? v * 18 : 0;
  await updatePlayer(p.discordId, { balance: p.balance - v + win });
  return reply(msg, `🐯 Saiu o bicho **${roll}**! ${win > 0 ? `🎉 Ganhou ${formatMoney(win)}` : `💸 Perdeu ${formatMoney(v)}`}`);
});

// ============ ARMAS / DUELO ============
reg(["arma", "armas"], async (msg, args) => {
  const sub = args[0]?.toLowerCase();
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  if (!sub || sub === "loja") {
    const e = new EmbedBuilder().setTitle("🔫 Lojinha de Armas").setColor(0x880000);
    for (const w of Object.values(WEAPONS)) {
      e.addFields({ name: `${w.emoji} ${w.name} — ${formatMoney(w.price)}`, value: `Dano ${w.damage} · ${w.description}\n\`!compraarma ${w.key}\``, inline: false });
    }
    return reply(msg, { embeds: [e] });
  }
  if (sub === "vender") {
    if (!p.weapon) return reply(msg, "❌ Sem arma equipada.");
    const w = WEAPONS[p.weapon];
    if (!w) return reply(msg, "❌ Arma inválida.");
    const v = Math.floor(w.price * 0.5);
    await addMoney(p.discordId, v);
    await updatePlayer(p.discordId, { weapon: null });
    return reply(msg, `💸 Vendeu ${w.name} por ${formatMoney(v)}.`);
  }
  if (sub === "equipada") {
    return reply(msg, p.weapon ? `🔫 Equipada: ${WEAPONS[p.weapon]?.name}` : "Nenhuma arma equipada.");
  }
  return reply(msg, "❌ Uso: `!arma loja | vender | equipada`");
});

reg(["compraarma"], async (msg, args) => {
  const k = args[0]?.toLowerCase();
  if (!k || !WEAPONS[k]) return reply(msg, "❌ Uso: `!compraarma <faca|bastao|pistola|escopeta|fuzil>`");
  const w = WEAPONS[k]!;
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  if (p.balance < w.price) return reply(msg, `❌ Custa ${formatMoney(w.price)}.`);
  await removeMoney(p.discordId, w.price);
  await updatePlayer(p.discordId, { weapon: k });
  return reply(msg, `${w.emoji} Comprou e equipou **${w.name}**.`);
});

reg(["duelo", "duelar"], async (msg, args) => {
  const tid = getMentionId(msg, args, 0);
  if (!tid || tid === msg.author.id) return reply(msg, "❌ Uso: `!duelo @user`");
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const t = await getPlayer(tid);
  if (!t) return reply(msg, "❌ Alvo inválido.");
  if (!p.weapon || !t.weapon) return reply(msg, "❌ Os dois precisam ter arma equipada.");
  const dmgP = WEAPONS[p.weapon]?.damage ?? 0;
  const dmgT = WEAPONS[t.weapon]?.damage ?? 0;
  const rollP = Math.random() * dmgP;
  const rollT = Math.random() * dmgT;
  const winnerId = rollP >= rollT ? p.discordId : t.discordId;
  const loserId = winnerId === p.discordId ? t.discordId : p.discordId;
  const loser = await getPlayer(loserId);
  if (loser) {
    const lostMoney = loser.balance + loser.bankBalance;
    await killPlayer(loser.discordId, "Morte em duelo");
    await updatePlayer(loser.discordId, { balance: 0, bankBalance: 0 });
    await logTransaction(loser.discordId, "VOID", lostMoney, "death", "Morte em duelo (não roubado)");
  }
  return reply(msg, `⚔️ Duelo! Vencedor: <@${winnerId}> 💀 Perdedor: <@${loserId}> perdeu TODO o dinheiro (mantém certificações).`);
});

// ============ GANGUES ============
reg(["gcriar"], async (msg, args) => {
  const nome = args[0];
  const tag = args[1]?.toUpperCase();
  if (!nome || !tag) return reply(msg, "❌ Uso: `!gcriar <nome> <tag>`");
  if (tag.length < 3 || tag.length > 5) return reply(msg, "❌ Tag deve ter 3-5 letras.");
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  if (p.gangId) return reply(msg, "❌ Já está em uma gangue.");
  if (p.balance < 5000) return reply(msg, "❌ Custa R$ 5.000.");
  const existsName = await db.query.gangs.findFirst({ where: sql`lower(${schema.gangs.name}) = lower(${nome})` });
  if (existsName) return reply(msg, `❌ Nome **${nome}** indisponível — já existe uma facção com esse nome. Escolha outro.`);
  const existsTag = await db.query.gangs.findFirst({ where: sql`lower(${schema.gangs.tag}) = lower(${tag})` });
  if (existsTag) return reply(msg, `❌ Tag **[${tag}]** indisponível — já está em uso. Escolha outra.`);
  await removeMoney(p.discordId, 5000);
  const id = `g_${Date.now()}`;
  await db.insert(schema.gangs).values({ id, name: nome, tag, leaderId: p.discordId });
  await updatePlayer(p.discordId, { gangId: id, gangRank: "lider" });
  return reply(msg, `🏴 Gangue **${nome}** [${tag}] criada!`);
});

reg(["ginvitar", "gconvidar"], async (msg, args) => {
  const tid = getMentionId(msg, args, 0);
  if (!tid) return reply(msg, "❌ Uso: `!ginvitar @user`");
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  if (!p.gangId || p.gangRank !== "lider") return reply(msg, "❌ Só líder convida.");
  const t = await getPlayer(tid);
  if (!t) return reply(msg, "❌ Alvo inválido.");
  if (t.gangId) return reply(msg, "❌ Alvo já está em uma gangue.");
  const gang = await db.query.gangs.findFirst({ where: eq(schema.gangs.id, p.gangId) });
  const e = new EmbedBuilder().setTitle("📨 Convite de Gangue").setColor(0x880088)
    .setDescription(`<@${tid}>, você foi convidado para **${gang?.name ?? "?"}** [${gang?.tag ?? "?"}] por <@${msg.author.id}>.\n\nReaja ✅ pra aceitar ou ❌ pra recusar (60s).`);
  const sent = await msg.reply({ content: `<@${tid}>`, embeds: [e] }).catch(() => null);
  if (!sent) return;
  await db.insert(schema.gangInvites).values({ gangId: p.gangId, targetId: tid, inviterId: p.discordId });
  const ok = await awaitConfirm(sent, tid, 60000);
  const inv = await db.query.gangInvites.findFirst({ where: and(eq(schema.gangInvites.targetId, tid), eq(schema.gangInvites.status, "pending")) });
  if (!inv) return;
  if (ok === true) {
    const t2 = await getPlayer(tid);
    if (t2?.gangId) return sent.reply("❌ Esse alvo já entrou em outra gangue.").catch(() => {});
    await updatePlayer(tid, { gangId: p.gangId, gangRank: "membro" });
    await db.update(schema.gangInvites).set({ status: "accepted" }).where(eq(schema.gangInvites.id, inv.id));
    if (gang) await db.update(schema.gangs).set({ memberCount: gang.memberCount + 1 }).where(eq(schema.gangs.id, gang.id));
    return sent.reply(`✅ <@${tid}> entrou na gangue **${gang?.name ?? "?"}**!`).catch(() => {});
  }
  await db.update(schema.gangInvites).set({ status: "rejected" }).where(eq(schema.gangInvites.id, inv.id));
  return sent.reply(ok === false ? `❌ <@${tid}> recusou o convite.` : `⏰ Tempo esgotado — convite expirado.`).catch(() => {});
});

reg(["gaceitar"], async (msg) => {
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  if (p.gangId) return reply(msg, "❌ Já está em uma gangue.");
  const inv = await db.query.gangInvites.findFirst({ where: and(eq(schema.gangInvites.targetId, p.discordId), eq(schema.gangInvites.status, "pending")) });
  if (!inv) return reply(msg, "❌ Sem convites.");
  const gang = await db.query.gangs.findFirst({ where: eq(schema.gangs.id, inv.gangId) });
  if (!gang) return reply(msg, "❌ Gangue não existe mais.");
  await updatePlayer(p.discordId, { gangId: inv.gangId, gangRank: "membro" });
  await db.update(schema.gangInvites).set({ status: "accepted" }).where(eq(schema.gangInvites.id, inv.id));
  await db.update(schema.gangs).set({ memberCount: gang.memberCount + 1 }).where(eq(schema.gangs.id, gang.id));
  return reply(msg, `✅ Entrou na gangue **${gang.name}**!`);
});

reg(["grejeitar"], async (msg) => {
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const inv = await db.query.gangInvites.findFirst({ where: and(eq(schema.gangInvites.targetId, p.discordId), eq(schema.gangInvites.status, "pending")) });
  if (!inv) return reply(msg, "❌ Sem convites.");
  await db.update(schema.gangInvites).set({ status: "rejected" }).where(eq(schema.gangInvites.id, inv.id));
  return reply(msg, `❌ Convite rejeitado.`);
});

reg(["gconvites"], async (msg) => {
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const invs = await db.query.gangInvites.findMany({ where: and(eq(schema.gangInvites.targetId, p.discordId), eq(schema.gangInvites.status, "pending")) });
  if (invs.length === 0) return reply(msg, "📭 Nenhum convite pendente.");
  const lines = await Promise.all(invs.map(async (i) => {
    const g = await db.query.gangs.findFirst({ where: eq(schema.gangs.id, i.gangId) });
    return `🏴 ${g?.name ?? "?"} [${g?.tag ?? "?"}]`;
  }));
  return reply(msg, lines.join("\n") + "\n\nUse `!gaceitar` ou `!grejeitar`.");
});

reg(["gbanir"], async (msg, args) => {
  const tid = getMentionId(msg, args, 0);
  if (!tid) return reply(msg, "❌ Uso: `!gbanir @user`");
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  if (!p.gangId || p.gangRank !== "lider") return reply(msg, "❌ Só líder bane.");
  const t = await getPlayer(tid);
  if (!t || t.gangId !== p.gangId) return reply(msg, "❌ Alvo não é da sua gangue.");
  await updatePlayer(t.discordId, { gangId: null, gangRank: null });
  const gang = await db.query.gangs.findFirst({ where: eq(schema.gangs.id, p.gangId) });
  if (gang) await db.update(schema.gangs).set({ memberCount: Math.max(1, gang.memberCount - 1) }).where(eq(schema.gangs.id, gang.id));
  return reply(msg, `👢 ${t.username} foi expulso.`);
});

reg(["gmembros"], async (msg) => {
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  if (!p.gangId) return reply(msg, "❌ Sem gangue.");
  const members = await db.query.players.findMany({ where: eq(schema.players.gangId, p.gangId) });
  return reply(msg, `🏴 Membros: ${members.map(m => `${m.username} (${m.gangRank})`).join(", ")}`);
});

reg(["gsair"], async (msg) => {
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  if (!p.gangId) return reply(msg, "❌ Sem gangue.");
  if (p.gangRank === "lider") return reply(msg, "❌ Líder não pode sair (use !gdissolver futuro).");
  await updatePlayer(p.discordId, { gangId: null, gangRank: null });
  return reply(msg, `🚪 Saiu da gangue.`);
});

reg(["ginfo"], async (msg) => {
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  if (!p.gangId) return reply(msg, "❌ Sem gangue.");
  const g = await db.query.gangs.findFirst({ where: eq(schema.gangs.id, p.gangId) });
  if (!g) return reply(msg, "❌ Gangue não encontrada.");
  const e = new EmbedBuilder().setTitle(`🏴 ${g.name} [${g.tag}]`).setColor(0x222222).addFields(
    { name: "Líder", value: `<@${g.leaderId}>`, inline: true },
    { name: "Membros", value: `${g.memberCount}`, inline: true },
    { name: "Banco", value: formatMoney(g.bankBalance), inline: true },
    { name: "Reputação", value: `${g.reputation}`, inline: true },
    { name: "Em guerra", value: g.isAtWar ? "Sim" : "Não", inline: true },
  );
  return reply(msg, { embeds: [e] });
});

reg(["glista"], async (msg) => {
  const all = await db.query.gangs.findMany({ limit: 15 });
  if (all.length === 0) return reply(msg, "Nenhuma gangue.");
  return reply(msg, all.map(g => `🏴 [${g.tag}] ${g.name} — ${g.memberCount} membros`).join("\n"));
});

// ============ CARROS ============
reg(["autos", "concessionaria"], async (msg) => {
  const e = new EmbedBuilder().setTitle("🚗 Concessionária").setColor(0x336699);
  for (const c of Object.values(CAR_MODELS)) {
    e.addFields({ name: `${c.emoji} ${c.name} (${c.category})`, value: `${formatMoney(c.price)}\n\`!comprarauto ${c.key}\``, inline: true });
  }
  return reply(msg, { embeds: [e] });
});

reg(["comprarauto"], async (msg, args) => {
  const k = args[0]?.toLowerCase();
  if (!k || !CAR_MODELS[k]) return reply(msg, "❌ Uso: `!comprarauto <modelo>`. Veja `!autos`.");
  const m = CAR_MODELS[k]!;
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  if (p.balance < m.price) return reply(msg, `❌ Custa ${formatMoney(m.price)}.`);
  await removeMoney(p.discordId, m.price);
  const [car] = await db.insert(schema.cars).values({ ownerId: p.discordId, model: m.name, category: m.category, basePrice: m.price, currentValue: m.price }).returning();
  await logTransaction(p.discordId, "DEALER", m.price, "car_buy", m.name);
  return reply(msg, `${m.emoji} Comprou **${m.name}** (#${car.id}) por ${formatMoney(m.price)}!`);
});

reg(["garagem"], async (msg) => {
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const list = await db.query.cars.findMany({ where: eq(schema.cars.ownerId, p.discordId) });
  if (list.length === 0) return reply(msg, "🚗 Garagem vazia. Veja `!autos`.");
  const e = new EmbedBuilder().setTitle("🅿️ Garagem").setColor(0x666666);
  for (const c of list) {
    const daysSince = (Date.now() - c.lastMaintenance.getTime()) / DAY_MS;
    const cond = Math.max(0, c.condition - Math.floor(daysSince * 5));
    e.addFields({ name: `#${c.id} ${c.model}`, value: `Estado ${cond}% · Valor ${formatMoney(depreciate(c.currentValue, c.basePrice, cond))}\n\`!consertar ${c.id}\` · \`!vendercarro ${c.id}\``, inline: false });
  }
  return reply(msg, { embeds: [e] });
});

reg(["consertar"], async (msg, args) => {
  const id = intArg(args, 0);
  if (!id) return reply(msg, "❌ Uso: `!consertar <id>`");
  const car = await db.query.cars.findFirst({ where: eq(schema.cars.id, id) });
  if (!car) return reply(msg, "❌ Carro não encontrado.");
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const isMechanic = p.profession === "mecanico" && p.isCertified;
  const daysSince = (Date.now() - car.lastMaintenance.getTime()) / DAY_MS;
  const cond = Math.max(0, car.condition - Math.floor(daysSince * 5));
  const cost = repairCost(cond);
  if (cost === 0) return reply(msg, "✅ Carro está perfeito.");
  const finalCost = isMechanic && car.ownerId === p.discordId ? Math.floor(cost * 0.4) : cost;
  if (car.ownerId !== p.discordId) {
    if (!isMechanic) return reply(msg, "❌ Só o dono ou um mecânico certificado pode consertar.");
    const owner = await getPlayer(car.ownerId);
    if (!owner || owner.balance < cost) return reply(msg, "❌ Dono sem saldo.");
    await updatePlayer(owner.discordId, { balance: owner.balance - cost });
    await addMoney(p.discordId, Math.floor(cost * 0.6));
    await db.update(schema.cars).set({ condition: 100, lastMaintenance: new Date(), currentValue: car.basePrice }).where(eq(schema.cars.id, id));
    return reply(msg, `🔧 Consertado para ${owner.username}. Você ganhou ${formatMoney(Math.floor(cost * 0.6))}.`);
  }
  if (p.balance < finalCost) return reply(msg, `❌ Custa ${formatMoney(finalCost)}.`);
  await removeMoney(p.discordId, finalCost);
  await db.update(schema.cars).set({ condition: 100, lastMaintenance: new Date(), currentValue: car.basePrice }).where(eq(schema.cars.id, id));
  return reply(msg, `🔧 Carro consertado por ${formatMoney(finalCost)}${isMechanic ? " (desconto de mecânico)" : ""}.`);
});

reg(["vendercarro"], async (msg, args) => {
  const id = intArg(args, 0);
  if (!id) return reply(msg, "❌ Uso: `!vendercarro <id>`");
  const car = await db.query.cars.findFirst({ where: eq(schema.cars.id, id) });
  if (!car || car.ownerId !== msg.author.id) return reply(msg, "❌ Carro não é seu.");
  const daysSince = (Date.now() - car.lastMaintenance.getTime()) / DAY_MS;
  const cond = Math.max(0, car.condition - Math.floor(daysSince * 5));
  const value = depreciate(car.currentValue, car.basePrice, cond);
  await addMoney(msg.author.id, value);
  await db.delete(schema.cars).where(eq(schema.cars.id, id));
  return reply(msg, `💰 Vendido por ${formatMoney(value)}.`);
});

// ============ CASA / TERRITÓRIO PESSOAL ============
reg(["casa"], async (msg) => {
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const h = await db.query.houses.findFirst({ where: eq(schema.houses.ownerId, p.discordId) });
  if (!h) {
    const e = new EmbedBuilder().setTitle("🏠 Imobiliária").setColor(0x884422).setDescription("Você ainda não tem imóvel. Tipos disponíveis:");
    for (const t of Object.values(HOUSE_TYPES)) {
      e.addFields({ name: `${t.emoji} ${t.name}`, value: `${formatMoney(t.basePrice)} · Renda ${formatMoney(t.passiveIncome)}/h\n\`!casacomprar ${t.key}\``, inline: true });
    }
    return reply(msg, { embeds: [e] });
  }
  const t = HOUSE_TYPES[h.type] ?? HOUSE_TYPES["barraco"]!;
  const ups = Object.entries(h.upgrades ?? {}).map(([k]) => HOUSE_UPGRADES[k]?.emoji ?? "").join(" ");
  const e = new EmbedBuilder().setTitle(`${t.emoji} ${t.name} (Nível ${h.level})`).setColor(0x884422).addFields(
    { name: "Valor", value: formatMoney(h.baseValue), inline: true },
    { name: "Upgrades", value: ups || "Nenhum", inline: true },
    { name: "Coletar renda", value: "`!coletar`", inline: true },
  );
  return reply(msg, { embeds: [e] });
});

reg(["casacomprar"], async (msg, args) => {
  const k = args[0]?.toLowerCase();
  if (!k || !HOUSE_TYPES[k]) return reply(msg, "❌ Uso: `!casacomprar <tipo>`. Veja `!casa`.");
  const t = HOUSE_TYPES[k]!;
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const exists = await db.query.houses.findFirst({ where: eq(schema.houses.ownerId, p.discordId) });
  if (exists) return reply(msg, "❌ Já tem imóvel. Venda ou faça upgrade.");
  if (p.balance < t.basePrice) return reply(msg, `❌ Custa ${formatMoney(t.basePrice)}.`);
  await removeMoney(p.discordId, t.basePrice);
  await db.insert(schema.houses).values({ ownerId: p.discordId, type: k, baseValue: t.basePrice });
  return reply(msg, `${t.emoji} Comprou ${t.name} por ${formatMoney(t.basePrice)}!`);
});

reg(["casaupgrade"], async (msg, args) => {
  const k = args[0]?.toLowerCase();
  if (!k || !HOUSE_UPGRADES[k]) return reply(msg, `❌ Uso: \`!casaupgrade <upgrade>\`. Opções: ${Object.keys(HOUSE_UPGRADES).join(", ")}`);
  const u = HOUSE_UPGRADES[k]!;
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const h = await db.query.houses.findFirst({ where: eq(schema.houses.ownerId, p.discordId) });
  if (!h) return reply(msg, "❌ Sem imóvel.");
  if ((h.upgrades as any)[k]) return reply(msg, "❌ Já instalado.");
  if (p.balance < u.price) return reply(msg, `❌ Custa ${formatMoney(u.price)}.`);
  await removeMoney(p.discordId, u.price);
  const newUps = { ...(h.upgrades as any), [k]: 1 };
  await db.update(schema.houses).set({ upgrades: newUps }).where(eq(schema.houses.id, h.id));
  return reply(msg, `${u.emoji} ${u.name} instalado! ${u.description}`);
});

reg(["coletar"], async (msg) => {
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const cd = cooldownLeft(p.lastBonus, 60 * 60 * 1000); // reuse lastBonus for hourly collect
  if (cd > 0) return reply(msg, `⏳ Próxima coleta em ${formatCooldown(cd)}.`);
  const h = await db.query.houses.findFirst({ where: eq(schema.houses.ownerId, p.discordId) });
  if (!h) return reply(msg, "❌ Você não tem imóvel.");
  const t = HOUSE_TYPES[h.type] ?? HOUSE_TYPES["barraco"]!;
  let income = t.passiveIncome;
  for (const k of Object.keys(h.upgrades ?? {})) income += HOUSE_UPGRADES[k]?.bonusIncome ?? 0;
  await addMoney(p.discordId, income);
  await updatePlayer(p.discordId, { lastBonus: new Date() });
  return reply(msg, `📥 Renda do imóvel: ${formatMoney(income)}.`);
});

// ============ FAZENDA ANIMAL ============
reg(["fazenda"], async (msg) => {
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const list = await db.query.farmAnimals.findMany({ where: and(eq(schema.farmAnimals.ownerId, p.discordId), eq(schema.farmAnimals.alive, true)) });
  const e = new EmbedBuilder().setTitle("🚜 Fazenda").setColor(0x88aa44);
  if (list.length === 0) e.setDescription("Vazia. Compre animais com `!animal <espécie> [nome]`.");
  else for (const a of list) {
    const sp = ANIMAL_SPECIES[a.species]!;
    const hoursSince = (Date.now() - a.lastFed.getTime()) / (60 * 60 * 1000);
    const hunger = Math.max(0, a.hunger - Math.floor(hoursSince * HUNGER_DECAY_PER_HOUR));
    const ready = a.readyAt && Date.now() >= a.readyAt.getTime();
    e.addFields({ name: `#${a.id} ${sp.emoji} ${a.name ?? sp.name}`, value: `Fome ${hunger}/100${ready ? " · ✅ pronto" : ""}\n\`!alimentar ${a.id}\` · \`!abater ${a.id}\``, inline: false });
  }
  e.addFields({ name: "Espécies", value: Object.values(ANIMAL_SPECIES).map(s => `${s.emoji} ${s.key} ${formatMoney(s.buyPrice)}`).join("\n"), inline: false });
  return reply(msg, { embeds: [e] });
});

reg(["animal"], async (msg, args) => {
  const sp = args[0]?.toLowerCase();
  const nome = args.slice(1).join(" ") || null;
  if (!sp || !ANIMAL_SPECIES[sp]) return reply(msg, `❌ Uso: \`!animal <galinha|porco|vaca|ovelha> [nome]\``);
  const s = ANIMAL_SPECIES[sp]!;
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  if (p.balance < s.buyPrice) return reply(msg, `❌ Custa ${formatMoney(s.buyPrice)}.`);
  // Verifica slots
  const liveAnimals = await db.query.farmAnimals.findMany({ where: and(eq(schema.farmAnimals.ownerId, p.discordId), eq(schema.farmAnimals.alive, true)) });
  const maxSlots = getSlots(p, "animal");
  if (liveAnimals.length >= maxSlots) {
    return reply(msg, `🚫 Você já tem **${liveAnimals.length}/${maxSlots}** animais vivos. Compre mais com \`!comprarslot animal\`.`);
  }
  await removeMoney(p.discordId, s.buyPrice);
  await db.insert(schema.farmAnimals).values({ ownerId: p.discordId, species: sp, name: nome, readyAt: new Date(Date.now() + s.growHours * 60 * 60 * 1000) });
  await animate(msg, [
    { title: "🚛 Indo ao mercado pecuário...", content: "Negociando com o vendedor.", image: GIFS.farm, color: 0x88aa44 },
    { title: `${s.emoji} Trazendo o animal pra fazenda...`, content: `${s.name}${nome ? ` "${nome}"` : ""}`, image: GIFS.farm, color: 0x88aa44 },
    { title: "✅ Animal comprado!", content: `${s.emoji} ${s.name}${nome ? ` "${nome}"` : ""} adicionado.\n⏳ Pronto em ${s.growHours}h\n🐾 Animais: ${liveAnimals.length + 1}/${maxSlots}`, image: GIFS.farm, color: 0x00aa44 },
  ], 800);
});

reg(["alimentar"], async (msg, args) => {
  const id = intArg(args, 0);
  if (!id) return reply(msg, "❌ Uso: `!alimentar <id>`");
  const a = await db.query.farmAnimals.findFirst({ where: eq(schema.farmAnimals.id, id) });
  if (!a || a.ownerId !== msg.author.id || !a.alive) return reply(msg, "❌ Animal inválido.");
  const sp = ANIMAL_SPECIES[a.species]!;
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  if (p.balance < sp.feedCost) return reply(msg, `❌ Ração custa ${formatMoney(sp.feedCost)}.`);
  await removeMoney(p.discordId, sp.feedCost);
  await db.update(schema.farmAnimals).set({ hunger: 100, lastFed: new Date() }).where(eq(schema.farmAnimals.id, id));
  return reply(msg, `${sp.emoji} ${a.name ?? sp.name} alimentado por ${formatMoney(sp.feedCost)}.`);
});

reg(["abater"], async (msg, args) => {
  const id = intArg(args, 0);
  if (!id) return reply(msg, "❌ Uso: `!abater <id>`");
  const a = await db.query.farmAnimals.findFirst({ where: eq(schema.farmAnimals.id, id) });
  if (!a || a.ownerId !== msg.author.id || !a.alive) return reply(msg, "❌ Animal inválido.");
  if (a.readyAt && Date.now() < a.readyAt.getTime()) return reply(msg, "⏳ Animal ainda não engordou.");
  const sp = ANIMAL_SPECIES[a.species]!;
  await db.update(schema.farmAnimals).set({ alive: false }).where(eq(schema.farmAnimals.id, id));
  await addMoney(msg.author.id, sp.meatYield);
  await logTransaction(null, msg.author.id, sp.meatYield, "slaughter", `Carne de ${sp.name}`);
  return reply(msg, `🥩 Abateu ${sp.name} e ganhou ${formatMoney(sp.meatYield)} em carne.`);
});

// ============ PETS ============
reg(["pet"], async (msg, args) => {
  const sp = args[0];
  const nome = args.slice(1).join(" ");
  if (!sp || !nome || !PET_SPECIES.includes(sp as any)) return reply(msg, `❌ Uso: \`!pet <${PET_SPECIES.join("|")}> <nome>\``);
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  if (p.balance < 1500) return reply(msg, "❌ Custa R$ 1.500.");
  const count = await db.query.pets.findMany({ where: and(eq(schema.pets.ownerId, p.discordId), eq(schema.pets.alive, true)) });
  if (count.length >= 3) return reply(msg, "❌ Máx 3 pets vivos.");
  await removeMoney(p.discordId, 1500);
  await db.insert(schema.pets).values({ ownerId: p.discordId, name: nome, species: sp });
  return reply(msg, `🐾 Adotou ${sp} chamado **${nome}**! Use \`!petfeed\` antes que morra.`);
});

reg(["pets"], async (msg) => {
  const list = await db.query.pets.findMany({ where: eq(schema.pets.ownerId, msg.author.id) });
  if (list.length === 0) return reply(msg, "🐾 Sem pets.");
  return reply(msg, list.map(p => {
    const hours = (Date.now() - p.lastFed.getTime()) / (60 * 60 * 1000);
    const hunger = Math.max(0, p.hunger - Math.floor(hours * 5));
    return `#${p.id} **${p.name}** (${p.species}) — ${p.alive ? `Fome ${hunger}` : "💀 morto"}`;
  }).join("\n"));
});

reg(["petfeed", "petalimentar"], async (msg) => {
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const inv = { ...(p.inventory ?? {}) };
  if (!inv["racao_pet"] || inv["racao_pet"]! <= 0) return reply(msg, "❌ Sem ração. Compre na `!loja`.");
  const pet = await db.query.pets.findFirst({ where: and(eq(schema.pets.ownerId, p.discordId), eq(schema.pets.alive, true)) });
  if (!pet) return reply(msg, "❌ Sem pet vivo.");
  inv["racao_pet"]! -= 1;
  await updatePlayer(p.discordId, { inventory: inv });
  await db.update(schema.pets).set({ hunger: 100, lastFed: new Date() }).where(eq(schema.pets.id, pet.id));
  return reply(msg, `🦴 ${pet.name} alimentado.`);
});

reg(["petsep"], async (msg) => {
  const dead = await db.query.pets.findFirst({ where: and(eq(schema.pets.ownerId, msg.author.id), eq(schema.pets.alive, false)) });
  if (!dead) return reply(msg, "❌ Nenhum pet morto.");
  await db.delete(schema.pets).where(eq(schema.pets.id, dead.id));
  return reply(msg, `⚰️ ${dead.name} sepultado.`);
});

// ============ FAMÍLIA ============
const CASAMENTO_TAXA = 10000;
reg(["casar"], async (msg, args) => {
  const tid = getMentionId(msg, args, 0);
  if (!tid || tid === msg.author.id) return reply(msg, "❌ Uso: `!casar @user`");
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const t = await getPlayer(tid);
  if (!t) return reply(msg, "❌ Alvo inválido.");
  if (p.partnerId || t.partnerId) return reply(msg, "❌ Alguém já está casado.");
  if (p.balance < CASAMENTO_TAXA) return reply(msg, `❌ A taxa do cartório custa ${formatMoney(CASAMENTO_TAXA)} (você paga). Saldo atual: ${formatMoney(p.balance)}.`);
  const e = new EmbedBuilder().setTitle("💍 Pedido de casamento").setColor(0xff66aa).setDescription(
    `<@${msg.author.id}> está pedindo <@${tid}> em casamento!\n💸 Taxa do cartório: **${formatMoney(CASAMENTO_TAXA)}** (paga pelo proponente)\n\n<@${tid}>, reaja ✅ pra aceitar ou ❌ pra recusar (60s).`,
  );
  const sent = await msg.reply({ content: `<@${tid}>`, embeds: [e] }).catch(() => null);
  if (!sent) return;
  const ok = await awaitConfirm(sent, tid, 60000);
  if (ok !== true) return sent.reply(ok === false ? `💔 <@${tid}> recusou o pedido.` : `⏰ <@${tid}> não respondeu.`).catch(() => {});
  const fresh = await getPlayer(msg.author.id);
  if (!fresh || fresh.balance < CASAMENTO_TAXA) return sent.reply("❌ Proponente ficou sem dinheiro pra taxa.").catch(() => {});
  await removeMoney(msg.author.id, CASAMENTO_TAXA);
  await logTransaction(msg.author.id, "CARTORIO", CASAMENTO_TAXA, "marriage", `Cartório`);
  await updatePlayer(msg.author.id, { partnerId: tid, marriedAt: new Date() });
  await updatePlayer(tid, { partnerId: msg.author.id, marriedAt: new Date() });
  const e2 = new EmbedBuilder().setTitle("💖 Casados!").setColor(0xff3399).setDescription(
    `🎉 <@${msg.author.id}> e <@${tid}> agora estão **casados**!\n💸 Taxa paga: ${formatMoney(CASAMENTO_TAXA)}`,
  ).setImage(GIFS.money);
  return sent.reply({ embeds: [e2] }).catch(() => {});
});

reg(["divorciar"], async (msg) => {
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  if (!p.partnerId) return reply(msg, "❌ Não está casado.");
  await updatePlayer(p.partnerId, { partnerId: null, marriedAt: null });
  await updatePlayer(p.discordId, { partnerId: null, marriedAt: null });
  return reply(msg, `💔 Divorciado.`);
});

// ============ TERRITÓRIOS GANGUE ============
reg(["terr", "territorios"], async (msg) => {
  const ts = await db.query.territories.findMany();
  return reply(msg, ts.map(t => `🗺️ #${t.id} ${t.name} — ${t.controlledBy ? `controlado` : "livre"} · renda ${formatMoney(t.passiveIncome)}/h`).join("\n"));
});

reg(["invadir"], async (msg, args) => {
  const id = intArg(args, 0);
  if (!id) return reply(msg, "❌ Uso: `!invadir <id>`");
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  if (!p.gangId) return reply(msg, "❌ Precisa estar em gangue.");
  const t = await db.query.territories.findFirst({ where: eq(schema.territories.id, id) });
  if (!t) return reply(msg, "❌ Território não existe.");
  const success = Math.random() < 0.5;
  if (!success) return reply(msg, "❌ Invasão fracassou.");
  await db.update(schema.territories).set({ controlledBy: p.gangId, lastCollected: new Date() }).where(eq(schema.territories.id, id));
  return reply(msg, `🏴 Sua gangue tomou ${t.name}!`);
});

// ============ BOLSA / EMPRESA / POLITICA (compactos) ============
reg(["bolsa"], async (msg) => {
  const list = await db.query.companies.findMany({ where: eq(schema.companies.isPublic, true), limit: 15 });
  if (list.length === 0) return reply(msg, "📊 Bolsa vazia.");
  return reply(msg, list.map(c => `${c.stockSymbol ?? "?"} — ${c.name} · ${formatMoney(c.sharePrice)} (×${c.totalShares})`).join("\n"));
});

reg(["bcomprar"], async (msg, args) => {
  const sym = args[0]?.toUpperCase();
  const qty = intArg(args, 1);
  if (!sym || !qty) return reply(msg, "❌ Uso: `!bcomprar <SIMBOLO> <qty>`");
  const c = await db.query.companies.findFirst({ where: and(eq(schema.companies.stockSymbol, sym), eq(schema.companies.isPublic, true)) });
  if (!c) return reply(msg, "❌ Ação não encontrada.");
  const total = c.sharePrice * qty;
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  if (p.balance < total) return reply(msg, `❌ Custa ${formatMoney(total)}.`);
  await removeMoney(p.discordId, total);
  const existing = await db.query.stockPortfolios.findFirst({ where: and(eq(schema.stockPortfolios.companyId, c.id), eq(schema.stockPortfolios.playerId, p.discordId)) });
  if (existing) {
    await db.update(schema.stockPortfolios).set({ shares: existing.shares + qty }).where(eq(schema.stockPortfolios.id, existing.id));
  } else {
    await db.insert(schema.stockPortfolios).values({ companyId: c.id, playerId: p.discordId, shares: qty, avgBuyPrice: c.sharePrice });
  }
  return reply(msg, `📈 Comprou ${qty} ações de ${sym} por ${formatMoney(total)}.`);
});

reg(["bvender"], async (msg, args) => {
  const sym = args[0]?.toUpperCase();
  const qty = intArg(args, 1);
  if (!sym || !qty) return reply(msg, "❌ Uso: `!bvender <SIMBOLO> <qty>`");
  const c = await db.query.companies.findFirst({ where: eq(schema.companies.stockSymbol, sym) });
  if (!c) return reply(msg, "❌ Ação não encontrada.");
  const h = await db.query.stockPortfolios.findFirst({ where: and(eq(schema.stockPortfolios.companyId, c.id), eq(schema.stockPortfolios.playerId, msg.author.id)) });
  if (!h || h.shares < qty) return reply(msg, "❌ Sem ações suficientes.");
  const total = c.sharePrice * qty;
  await addMoney(msg.author.id, total);
  if (h.shares === qty) await db.delete(schema.stockPortfolios).where(eq(schema.stockPortfolios.id, h.id));
  else await db.update(schema.stockPortfolios).set({ shares: h.shares - qty }).where(eq(schema.stockPortfolios.id, h.id));
  return reply(msg, `📉 Vendeu ${qty} ações de ${sym} por ${formatMoney(total)}.`);
});

reg(["carteira"], async (msg) => {
  const hs = await db.query.stockPortfolios.findMany({ where: eq(schema.stockPortfolios.playerId, msg.author.id) });
  if (hs.length === 0) return reply(msg, "💼 Carteira vazia.");
  const lines: string[] = [];
  for (const h of hs) {
    const c = await db.query.companies.findFirst({ where: eq(schema.companies.id, h.companyId) });
    if (c) lines.push(`${c.stockSymbol ?? c.name} — ${h.shares} ações · ${formatMoney(c.sharePrice * h.shares)}`);
  }
  return reply(msg, lines.join("\n"));
});

// ============ DÍVIDAS / FIADO ============
reg(["fiado", "emprestar"], async (msg, args) => {
  const tid = getMentionId(msg, args, 0);
  if (!tid) return reply(msg, "❌ Uso: `!fiado @user <valor> [dias]`");
  const v = intArg(args, 1) ?? intArg(args, 2);
  if (!v) return reply(msg, "❌ Informe um valor válido.");
  if (tid === msg.author.id) return reply(msg, "❌ Você não pode emprestar pra si mesmo.");
  const days = parseInt(args.find((a, i) => i > 0 && /^\d+$/.test(a) && parseInt(a, 10) <= 30 && parseInt(a, 10) !== v) ?? `${DEFAULT_DUE_DAYS}`, 10) || DEFAULT_DUE_DAYS;
  const lender = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const debtor = await getPlayer(tid);
  if (!debtor) return reply(msg, "❌ Devedor precisa interagir com o bot antes.");
  if (lender.balance < v) return reply(msg, "❌ Você não tem essa grana.");
  await updatePlayer(lender.discordId, { balance: lender.balance - v });
  await addMoney(tid, v);
  const debt = await createDebt(tid, lender.discordId, v, days);
  return reply(msg, `🤝 Emprestou ${formatMoney(v)} para <@${tid}>.\n📜 Dívida #${debt.id} · juros ${(DEFAULT_INTEREST * 100).toFixed(0)}%/dia se atrasar · vence em ${days} dia(s).`);
});

reg(["dividas", "minhasdividas"], async (msg) => {
  const ds = await listDebts(msg.author.id);
  if (ds.length === 0) return reply(msg, "✅ Você não tem dívidas.");
  const lines = ds.map(d => `#${d.id} · ${formatMoney(d.remainingAmount)} · vence ${d.dueAt.toLocaleDateString("pt-BR")} ${d.defaulted ? "🔴 EM ATRASO" : ""}`);
  const total = ds.reduce((s, d) => s + d.remainingAmount, 0);
  return reply(msg, `📜 **Dívidas** (total ${formatMoney(total)})\n${lines.join("\n")}\n\nUse \`!pagar <id>\` para quitar.`);
});

reg(["pagar", "quitar"], async (msg, args) => {
  const id = intArg(args, 0);
  if (!id) return reply(msg, "❌ Uso: `!pagar <id-da-divida>`");
  const r = await payDebt(id, msg.author.id);
  return reply(msg, r.ok ? `✅ ${r.msg}` : `❌ ${r.msg}`);
});

// ============ FALÊNCIA ============
reg(["falir", "falencia"], async (msg) => {
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  if (p.bankrupt) return reply(msg, `🔴 Você já está em falência até ${p.bankruptUntil?.toLocaleDateString("pt-BR")}.`);
  const ds = await listDebts(msg.author.id);
  const total = ds.reduce((s, d) => s + d.remainingAmount, 0);
  if (total < 5000) return reply(msg, "❌ Falência só é permitida com dívidas acima de R$ 5.000.");
  await declareBankruptcy(msg.author.id);
  return reply(msg, `⚖️ **FALÊNCIA DECRETADA**\nVocê perdeu casa, carros e teve dívidas perdoadas.\n📉 -200 reputação · -30 karma\n🔒 Sem crédito por 7 dias.`);
});

reg(["status", "patrimonio"], async (msg) => {
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const ds = await listDebts(msg.author.id);
  const totalDebt = ds.reduce((s, d) => s + d.remainingAmount, 0);
  const wealth = p.balance + p.bankBalance;
  const e = new EmbedBuilder().setTitle(`📊 Patrimônio · ${p.username}`).setColor(p.bankrupt ? 0xff0000 : 0x00ff88).addFields(
    { name: "💵 Carteira", value: formatMoney(p.balance), inline: true },
    { name: "🏦 Banco", value: formatMoney(p.bankBalance), inline: true },
    { name: "📜 Dívidas", value: formatMoney(totalDebt), inline: true },
    { name: "💎 Líquido", value: formatMoney(wealth - totalDebt), inline: true },
    { name: "⭐ Reputação", value: `${p.reputation}`, inline: true },
    { name: "🧘 Karma", value: `${p.karma}`, inline: true },
    { name: "📋 Status", value: p.bankrupt ? `🔴 FALIDO até ${p.bankruptUntil?.toLocaleDateString("pt-BR")}` : "✅ Saudável", inline: false },
  );
  return reply(msg, { embeds: [e] });
});

// ============ REPUTAÇÃO ============
reg(["rep", "reputacao"], async (msg, args) => {
  const tid = getMentionId(msg, args, 0) ?? msg.author.id;
  const p = await getPlayer(tid);
  if (!p) return reply(msg, "❌ Jogador sem ficha.");
  let nivel = "Desconhecido";
  if (p.reputation >= 200) nivel = "🌟 Lenda da Quebrada";
  else if (p.reputation >= 100) nivel = "👑 Respeitado";
  else if (p.reputation >= 50) nivel = "👍 Confiável";
  else if (p.reputation >= 0) nivel = "😐 Neutro";
  else if (p.reputation >= -50) nivel = "👎 Mal visto";
  else if (p.reputation >= -100) nivel = "🤬 Caloteiro";
  else nivel = "💀 Pária";
  let karma = "Equilibrado";
  if (p.karma >= 50) karma = "😇 Anjo";
  else if (p.karma >= 20) karma = "✨ Bom";
  else if (p.karma >= -20) karma = "⚖️ Equilibrado";
  else if (p.karma >= -50) karma = "😈 Mau";
  else karma = "👹 Demônio";
  const e = new EmbedBuilder().setTitle(`⭐ ${p.username}`).setColor(0xffd700).addFields(
    { name: "Reputação", value: `${p.reputation} · ${nivel}`, inline: true },
    { name: "Karma", value: `${p.karma} · ${karma}`, inline: true },
    { name: "Ficha criminal", value: `${p.criminalRecord} crimes`, inline: true },
  );
  return reply(msg, { embeds: [e] });
});

// ============ ESCOLHAS MORAIS ============
reg(["moral", "escolha"], async (msg) => {
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const cd = cooldownLeft(p.lastMoral, 60 * 60 * 1000);
  if (cd > 0) return reply(msg, `⏳ Aguarde ${formatCooldown(cd)} pra outra escolha moral.`);
  const sc = pickRandomScenario();
  const optionsText = sc.options.map((o, i) => `${["1️⃣", "2️⃣", "3️⃣"][i]} ${o.label}`).join("\n");
  const e = new EmbedBuilder().setTitle("🤔 Dilema Moral").setColor(0xaa44ff)
    .setDescription(`${sc.scenario}\n\n${optionsText}\n\nReaja com o número correspondente em até 30s.`);
  const sent = await msg.reply({ embeds: [e] }).catch(() => null);
  if (!sent) return;
  const idx = await awaitChoice(sent, msg.author.id, sc.options.length, 30000);
  if (idx === null) return sent.reply("⏰ Tempo esgotado. Você ficou paralisado.").catch(() => {});
  const opt = sc.options[idx];
  if (!opt) return;
  const fresh = await getPlayer(msg.author.id);
  if (!fresh) return;
  await updatePlayer(msg.author.id, {
    balance: Math.max(0, fresh.balance + opt.money),
    karma: fresh.karma + opt.karma,
    reputation: fresh.reputation + opt.rep,
    lastMoral: new Date(),
  });
  return sent.reply(`📜 ${opt.outcome}\n\n💰 ${opt.money >= 0 ? "+" : ""}${formatMoney(opt.money)} · 🧘 ${opt.karma >= 0 ? "+" : ""}${opt.karma} karma · ⭐ ${opt.rep >= 0 ? "+" : ""}${opt.rep} rep`).catch(() => {});
});

// ============ IMPOSTO DE RENDA ============
reg(["ir", "imposto"], async (msg) => {
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const wealth = p.balance + p.bankBalance;
  const eco = await getEconomy();
  const taxRate = eco.incomeTaxRate;
  const tax = Math.floor(wealth * taxRate);
  if (tax <= 0) return reply(msg, "✅ Você não tem patrimônio tributável.");
  const last = p.lastTaxPaid;
  if (last && Date.now() - last.getTime() < 7 * 24 * 60 * 60 * 1000) {
    return reply(msg, `✅ IR já pago. Próxima declaração em ${formatCooldown(7 * 24 * 60 * 60 * 1000 - (Date.now() - last.getTime()))}.`);
  }
  if (p.balance + p.bankBalance < tax) return reply(msg, `❌ Você precisa de ${formatMoney(tax)} pra pagar o IR.`);
  // tira primeiro do banco
  let fromBank = Math.min(tax, p.bankBalance);
  let fromCash = tax - fromBank;
  await updatePlayer(p.discordId, {
    bankBalance: p.bankBalance - fromBank,
    balance: p.balance - fromCash,
    lastTaxPaid: new Date(),
    karma: p.karma + 5,
    reputation: p.reputation + 10,
  });
  await logTransaction(p.discordId, "GOV", tax, "tax", "Imposto de Renda");
  return reply(msg, `🧾 **Imposto de Renda pago**\n💸 ${formatMoney(tax)} (${(taxRate * 100).toFixed(0)}% de ${formatMoney(wealth)})\n+5 karma · +10 reputação`);
});

reg(["sonegar"], async (msg) => {
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const wealth = p.balance + p.bankBalance;
  const eco = await getEconomy();
  const tax = Math.floor(wealth * eco.incomeTaxRate);
  if (tax <= 0) return reply(msg, "❌ Sem patrimônio pra sonegar.");
  await updatePlayer(p.discordId, { lastTaxPaid: new Date(), karma: p.karma - 10 });
  // 30% chance de fiscalização
  if (Math.random() < 0.3) {
    const penalty = Math.floor(tax * 1.5);
    const total = Math.min(p.balance + p.bankBalance, penalty);
    let fb = Math.min(total, p.bankBalance);
    let fc = total - fb;
    await updatePlayer(p.discordId, { bankBalance: p.bankBalance - fb, balance: p.balance - fc, reputation: p.reputation - 30 });
    return reply(msg, `🚨 **FISCALIZAÇÃO!** Você foi pego sonegando.\n💸 Multa: ${formatMoney(total)}\n📉 -30 reputação`);
  }
  return reply(msg, `🤫 Você sonegou ${formatMoney(tax)} e não foi pego... dessa vez. -10 karma.`);
});

// ============ MERCADO NEGRO ============
reg(["mn", "mercadonegro"], async (msg) => {
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  if (p.criminalRecord < MIN_RECORD_TO_ACCESS) return reply(msg, `🔒 Mercado negro só pra criminosos com ficha (${MIN_RECORD_TO_ACCESS}+ crimes). Você tem ${p.criminalRecord}.`);
  const lines = Object.values(BLACK_MARKET).map(i => `${i.emoji} **${i.key}** — ${i.name} · ${formatMoney(i.price)}\n_${i.description}_`);
  const e = new EmbedBuilder().setTitle("🕶️ Mercado Negro").setColor(0x111111).setDescription(lines.join("\n\n")).setFooter({ text: "Use !mncomprar <chave>" });
  return reply(msg, { embeds: [e] });
});

reg(["mncomprar", "mnbuy"], async (msg, args) => {
  const key = (args[0] ?? "").toLowerCase();
  const item = BLACK_MARKET[key];
  if (!item) return reply(msg, "❌ Item não existe. Veja `!mn`.");
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  if (p.criminalRecord < MIN_RECORD_TO_ACCESS) return reply(msg, "🔒 Sem acesso ao mercado negro.");
  if (p.balance < item.price) return reply(msg, "❌ Sem grana.");
  await updatePlayer(p.discordId, { balance: p.balance - item.price, karma: p.karma - 5 });
  // efeitos especiais
  if (item.key === "rgfalso") {
    await updatePlayer(p.discordId, { criminalRecord: Math.floor(p.criminalRecord / 2) });
    return reply(msg, `🪪 RG falso comprado. Ficha reduzida pela metade.`);
  }
  if (item.key === "passaporte") {
    await updatePlayer(p.discordId, { wantedLevel: 0 });
    return reply(msg, `🛂 Passaporte frio. Nível de procurado zerado.`);
  }
  if (item.key === "doping") {
    await updatePlayer(p.discordId, { energy: 100 });
    return reply(msg, `💊 Doping! Energia restaurada.`);
  }
  if (item.key === "colete") {
    await updatePlayer(p.discordId, { maxHealth: p.maxHealth + 50 });
    return reply(msg, `🦺 Colete equipado. +50 vida máxima.`);
  }
  if (item.type === "weapon") {
    await updatePlayer(p.discordId, { weapon: item.key });
    return reply(msg, `${item.emoji} ${item.name} adquirida no mercado negro.`);
  }
  return reply(msg, `✅ ${item.name} comprado.`);
});

// ============ LOTERIA ============
reg(["loteria", "lot"], async (msg) => {
  const draw = await getCurrentDraw();
  const tickets = await db.query.lotteryTickets.findMany({ where: eq(schema.lotteryTickets.drawId, draw.id) });
  const mine = tickets.filter(t => t.playerId === msg.author.id);
  const e = new EmbedBuilder().setTitle(`🎰 Loteria #${draw.drawNumber}`).setColor(0xff00ff).addFields(
    { name: "💰 Prêmio acumulado", value: formatMoney(draw.totalPot), inline: true },
    { name: "🎫 Bilhetes vendidos", value: `${tickets.length}`, inline: true },
    { name: "📅 Sorteio em", value: draw.drawAt.toLocaleString("pt-BR"), inline: false },
    { name: "🎟️ Seus bilhetes", value: mine.length === 0 ? "Nenhum" : mine.map(t => `#${t.number}`).join(", "), inline: false },
  ).setFooter({ text: `Use !bilhete <número 1-${NUMBER_RANGE}> · R$ ${TICKET_PRICE}` });
  return reply(msg, { embeds: [e] });
});

reg(["bilhete", "comprarbilhete"], async (msg, args) => {
  const n = intArg(args, 0);
  if (!n || n < 1 || n > NUMBER_RANGE) return reply(msg, `❌ Uso: \`!bilhete <1-${NUMBER_RANGE}>\``);
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  if (p.balance < TICKET_PRICE) return reply(msg, `❌ Bilhete custa ${formatMoney(TICKET_PRICE)}.`);
  await updatePlayer(p.discordId, { balance: p.balance - TICKET_PRICE });
  const draw = await buyTicket(p.discordId, n);
  return reply(msg, `🎟️ Bilhete #${n} comprado para o sorteio #${draw.drawNumber}!`);
});

// ============ EVENTOS ECONÔMICOS ============
reg(["evento", "economia"], async (msg, args) => {
  const sub = (args[0] ?? "").toLowerCase();
  if (sub && msg.member?.permissions.has("Administrator") && sub in EVENT_DEFS) {
    await startEvent(sub as EventType);
    const def = EVENT_DEFS[sub as EventType];
    return reply(msg, `${def.emoji} Evento **${def.name}** iniciado por ${def.durationH}h.`);
  }
  const active = await getActiveEvent();
  if (!active) return reply(msg, "📊 Economia estável. Nenhum evento ativo.");
  const def = EVENT_DEFS[active.type as EventType];
  if (!def) return reply(msg, "📊 Evento desconhecido.");
  const remainingH = Math.max(0, (active.endsAt.getTime() - Date.now()) / (60 * 60 * 1000));
  return reply(msg, `${def.emoji} **${def.name}** — ${def.desc}\n⏰ Resta ~${remainingH.toFixed(1)}h. Multiplicador: ${def.multiplier}x`);
});

// Auto-check de falência ao usar saldo
reg(["checkfalencia"], async (msg) => {
  const b = await checkBankruptcy(msg.author.id);
  return reply(msg, b ? "🔴 Você está em falência." : "✅ Situação financeira sob controle.");
});

// ============ ADMIN ============
reg(["adm"], async (msg, args) => {
  if (!msg.member?.permissions.has("Administrator")) return reply(msg, "❌ Só admins.");
  const sub = args[0]?.toLowerCase();
  const tid = getMentionId(msg, args, 1);
  const v = intArg(args, 2);
  if (!sub || !tid) return reply(msg, "❌ Uso: `!adm dar|tirar|reset @user [valor]`");
  const t = await getPlayer(tid);
  if (!t) return reply(msg, "❌ Jogador não encontrado.");
  if (sub === "dar" && v) { await updatePlayer(tid, { balance: t.balance + v }); return reply(msg, `✅ +${formatMoney(v)} para ${t.username}.`); }
  if (sub === "tirar" && v) { await updatePlayer(tid, { balance: Math.max(0, t.balance - v) }); return reply(msg, `✅ -${formatMoney(v)} de ${t.username}.`); }
  if (sub === "reset") { await updatePlayer(tid, { balance: 0, bankBalance: 0 }); return reply(msg, `✅ ${t.username} zerado.`); }
  return reply(msg, "❌ Subcomando inválido.");
});

// ============ DASHBOARD GLOBAL ============
function bar(value: number, max: number, size = 10): string {
  const v = Math.max(0, Math.min(max, value));
  const filled = Math.round((v / max) * size);
  return "█".repeat(filled) + "░".repeat(size - filled);
}

reg(["dash", "dashboard", "painel"], async (msg) => {
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const cars = await db.query.cars.findMany({ where: eq(schema.cars.ownerId, p.discordId) });
  const house = await db.query.houses.findFirst({ where: eq(schema.houses.ownerId, p.discordId) });
  const plots = await db.query.plots.findMany({ where: and(eq(schema.plots.ownerId, p.discordId), eq(schema.plots.harvested, false)) });
  const stocks = await db.query.stockPortfolios.findMany({ where: eq(schema.stockPortfolios.playerId, p.discordId) });
  const company = await db.query.companies.findFirst({ where: eq(schema.companies.ownerId, p.discordId) });
  const debts = await listDebts(p.discordId);
  const totalDebt = debts.reduce((s, d) => s + d.remainingAmount, 0);

  let stockValue = 0;
  for (const s of stocks) {
    const c = await db.query.companies.findFirst({ where: eq(schema.companies.id, s.companyId) });
    if (c) stockValue += c.sharePrice * s.shares;
  }

  const e = new EmbedBuilder()
    .setTitle(`🎛️ Painel — ${p.username}`)
    .setColor(0x5865f2)
    .setThumbnail(msg.author.displayAvatarURL())
    .addFields(
      { name: "💰 Carteira", value: formatMoney(p.balance), inline: true },
      { name: "🏦 Banco", value: formatMoney(p.bankBalance), inline: true },
      { name: "📊 Ações", value: formatMoney(stockValue), inline: true },
      { name: "❤️ Vida", value: `${bar(p.health, p.maxHealth)} ${p.health}/${p.maxHealth}`, inline: false },
      { name: "⚡ Energia", value: `${bar(p.energy, 100)} ${p.energy}/100`, inline: false },
      { name: "🏠 Imóvel", value: house ? `${HOUSE_TYPES[house.type]?.emoji ?? "🏠"} ${HOUSE_TYPES[house.type]?.name ?? house.type}` : "Nenhum", inline: true },
      { name: "🚗 Garagem", value: `${cars.length} carro(s)`, inline: true },
      { name: "🌾 Plantações", value: `${plots.length} ativa(s)`, inline: true },
      { name: "💼 Empresa", value: company ? `${company.name} (Nv ${company.level})` : "Nenhuma", inline: true },
      { name: "⭐ Reputação", value: `${p.reputation}`, inline: true },
      { name: "🧘 Karma", value: `${p.karma}`, inline: true },
      { name: "📜 Dívidas", value: formatMoney(totalDebt), inline: true },
    )
    .setFooter({ text: "Use !ajuda para ver todos os comandos" });
  return reply(msg, { embeds: [e] });
});

// ============ BOLSA — COTAÇÕES E VALORIZAÇÃO ============
function pctChange(history: number[], current: number): number {
  const prev = history.length >= 2 ? history[history.length - 2] : history[0];
  if (!prev || prev === 0) return 0;
  return ((current - prev) / prev) * 100;
}

function trendIcon(p: number): string {
  if (p > 5) return "🚀";
  if (p > 0) return "📈";
  if (p === 0) return "➡️";
  if (p > -5) return "📉";
  return "🔻";
}

reg(["cotacoes", "acoes", "bolsa2", "blista"], async (msg) => {
  const list = await db.query.companies.findMany({ where: eq(schema.companies.isPublic, true), limit: 25 });
  if (list.length === 0) return reply(msg, "📊 Nenhuma empresa listada. Empresários podem abrir capital com `!eipo`.");
  const e = new EmbedBuilder().setTitle("📈 Bolsa de Valores — Cotações").setColor(0x00aa44);
  const sorted = [...list].sort((a, b) => b.sharePrice - a.sharePrice);
  for (const c of sorted) {
    const hist = (c.priceHistory as number[]) ?? [];
    const variation = pctChange(hist, c.sharePrice);
    const ico = trendIcon(variation);
    const sign = variation >= 0 ? "+" : "";
    e.addFields({
      name: `${ico} [${c.stockSymbol ?? "?"}] ${c.name}`,
      value: `💰 ${formatMoney(c.sharePrice)} (${sign}${variation.toFixed(2)}%)\n📦 ${c.availableShares}/${c.totalShares} · 🏭 ${c.sector}`,
      inline: true,
    });
  }
  e.setFooter({ text: "Use !bcomprar <SYM> <qty> · !bvender <SYM> <qty> · !bdetalhe <SYM>" });
  return reply(msg, { embeds: [e] });
});

reg(["bdetalhe", "binfo", "acao"], async (msg, args) => {
  const sym = args[0]?.toUpperCase();
  if (!sym) return reply(msg, "❌ Uso: `!bdetalhe <SIMBOLO>`");
  const c = await db.query.companies.findFirst({ where: eq(schema.companies.stockSymbol, sym) });
  if (!c || !c.isPublic) return reply(msg, "❌ Ação não encontrada na bolsa.");
  const hist = (c.priceHistory as number[]) ?? [];
  const variation = pctChange(hist, c.sharePrice);
  const last5 = hist.slice(-5);
  const sparkline = last5.length >= 2
    ? last5.map((p, i) => i === 0 ? "•" : p > last5[i - 1] ? "↗" : p < last5[i - 1] ? "↘" : "→").join(" ")
    : "Dados insuficientes";
  const e = new EmbedBuilder()
    .setTitle(`🏢 ${c.name} [${sym}] ${trendIcon(variation)}`)
    .setColor(variation >= 0 ? 0x00aa44 : 0xaa2222)
    .addFields(
      { name: "💰 Preço", value: formatMoney(c.sharePrice), inline: true },
      { name: "📊 Variação", value: `${variation >= 0 ? "+" : ""}${variation.toFixed(2)}%`, inline: true },
      { name: "🏛️ Market Cap", value: formatMoney(c.marketCap), inline: true },
      { name: "📦 Disponíveis", value: `${c.availableShares}/${c.totalShares}`, inline: true },
      { name: "⭐ Reputação", value: `${bar(c.reputation, 100)} ${c.reputation}/100`, inline: true },
      { name: "🏭 Setor", value: c.sector, inline: true },
      { name: "📉 Histórico", value: sparkline, inline: false },
    );
  return reply(msg, { embeds: [e] });
});

// ============ POLÍTICA — PREFIXO ! ============
reg(["governo", "gov"], async (msg) => {
  const gov = await getGovernment();
  const laws = await db.query.laws.findMany({ where: eq(schema.laws.isActive, true), limit: 10 });
  const e = new EmbedBuilder().setTitle("🏛️ Governo Atual").setColor(0x003399).addFields(
    { name: "🇧🇷 Presidente", value: gov.presidentId ? `<@${gov.presidentId}>` : "Vago", inline: true },
    { name: "🏙️ Prefeito", value: gov.mayorId ? `<@${gov.mayorId}>` : "Vago", inline: true },
    { name: "💸 Imposto (mult.)", value: `${gov.taxMultiplier}%`, inline: true },
    { name: "🚔 Salário polícia", value: `${gov.policeSalaryMultiplier}%`, inline: true },
    { name: "🦹 Crime (mult.)", value: `${gov.crimeMultiplier}%`, inline: true },
    { name: "📜 Leis ativas", value: laws.length > 0 ? laws.map(l => `• **${l.name}** — ${l.description}`).join("\n").slice(0, 1000) : "Nenhuma", inline: false },
  );
  return reply(msg, { embeds: [e] });
});

reg(["eleicao", "iniciareleicao"], async (msg, args) => {
  if (!msg.member?.permissions.has("Administrator")) return reply(msg, "❌ Apenas admins iniciam eleições.");
  const cargo = (args[0] ?? "").toLowerCase();
  if (!["presidente", "prefeito"].includes(cargo)) return reply(msg, "❌ Uso: `!eleicao <presidente|prefeito>`");
  const existing = await db.query.elections.findFirst({ where: eq(schema.elections.isActive, true) });
  if (existing) return reply(msg, "❌ Já existe uma eleição em andamento. Use `!apurar` quando terminar.");
  const endTime = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await db.insert(schema.elections).values({
    position: cargo, candidates: [], votes: {},
    isActive: true, startTime: new Date(), endTime,
  });
  return reply(msg, `🗳️ Eleição para **${cargo}** aberta! Termina <t:${Math.floor(endTime.getTime() / 1000)}:R>.\n• \`!candidatar\` para entrar.\n• \`!votar @user\` para votar.\n• \`!apurar\` quando terminar.`);
});

reg(["candidatar", "candidato"], async (msg) => {
  const election = await db.query.elections.findFirst({ where: eq(schema.elections.isActive, true) });
  if (!election) return reply(msg, "❌ Sem eleição ativa.");
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  if (p.balance < 2000) return reply(msg, "❌ Custa R$ 2.000 para registrar candidatura.");
  const candidates = (election.candidates as string[]) ?? [];
  if (candidates.includes(p.discordId)) return reply(msg, "❌ Você já é candidato.");
  candidates.push(p.discordId);
  await removeMoney(p.discordId, 2000);
  await db.update(schema.elections).set({ candidates }).where(eq(schema.elections.id, election.id));
  return reply(msg, `🗳️ ${msg.author.username} se candidatou para **${election.position}**! Boa sorte 🎉`);
});

reg(["votar"], async (msg, args) => {
  const tid = getMentionId(msg, args, 0);
  if (!tid) return reply(msg, "❌ Uso: `!votar @candidato`");
  const election = await db.query.elections.findFirst({ where: eq(schema.elections.isActive, true) });
  if (!election) return reply(msg, "❌ Sem eleição ativa.");
  const candidates = (election.candidates as string[]) ?? [];
  if (!candidates.includes(tid)) return reply(msg, "❌ Esse jogador não é candidato.");
  const votes = { ...((election.votes as Record<string, string>) ?? {}) };
  if (votes[msg.author.id]) return reply(msg, "❌ Você já votou.");
  votes[msg.author.id] = tid;
  await db.update(schema.elections).set({ votes }).where(eq(schema.elections.id, election.id));
  return reply(msg, `✅ Voto registrado em <@${tid}>!`);
});

reg(["apurar", "encerrar_eleicao"], async (msg) => {
  const election = await db.query.elections.findFirst({ where: eq(schema.elections.isActive, true) });
  if (!election) return reply(msg, "❌ Sem eleição ativa.");
  const isAdmin = msg.member?.permissions.has("Administrator") ?? false;
  const ended = election.endTime && new Date() >= election.endTime;
  if (!ended && !isAdmin) return reply(msg, `⏳ Eleição ainda em andamento. Termina <t:${Math.floor((election.endTime?.getTime() ?? 0) / 1000)}:R>.`);

  const votes = (election.votes as Record<string, string>) ?? {};
  const tally: Record<string, number> = {};
  for (const v of Object.values(votes)) tally[v] = (tally[v] ?? 0) + 1;
  const sorted = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  if (sorted.length === 0) {
    await db.update(schema.elections).set({ isActive: false }).where(eq(schema.elections.id, election.id));
    return reply(msg, "🗳️ Eleição encerrada sem votos.");
  }
  const [winnerId, winnerVotes] = sorted[0];
  await db.update(schema.elections).set({ isActive: false, winnerId }).where(eq(schema.elections.id, election.id));
  const govUpdate: any = election.position === "presidente" ? { presidentId: winnerId } : { mayorId: winnerId };
  await db.update(schema.government).set({ ...govUpdate, updatedAt: new Date() }).where(eq(schema.government.id, 1));

  // ORÇAMENTO POLÍTICO — vencedor recebe verba pública para usar (compra de votos, etc)
  const ORC = election.position === "presidente" ? 200000 : 80000;
  const winner = await getPlayer(winnerId);
  if (winner) {
    const inv = { ...(winner.inventory ?? {}) };
    inv["_orcamento_politico"] = ((inv["_orcamento_politico"] as number) ?? 0) + ORC;
    await updatePlayer(winnerId, { inventory: inv });
  }

  const tallyText = sorted.slice(0, 5).map(([id, n], i) => `${i + 1}. <@${id}> — ${n} voto(s)`).join("\n");
  const e = new EmbedBuilder().setTitle(`🏆 Apuração — ${election.position}`).setColor(0xffcc00).setImage(GIFS.vote)
    .setDescription(`👑 Vencedor: <@${winnerId}> (${winnerVotes} votos)\n💼 Orçamento político liberado: **${formatMoney(ORC)}**\n_(use \`!comprarvoto @user <valor>\` em eleições futuras pra trocar votos por dinheiro)_\n\n${tallyText}`);
  return reply(msg, { embeds: [e] });
});

// COMPRA DE VOTOS — usa orçamento político do candidato no poder
reg(["comprarvoto", "subornar"], async (msg, args) => {
  const tid = getMentionId(msg, args, 0);
  const v = intArg(args, msg.mentions.users.size > 0 ? 0 : 1);
  if (!tid || !v) return reply(msg, "❌ Uso: `!comprarvoto @user <valor>` — paga o usuário e força o voto dele em você na eleição ativa.");
  if (tid === msg.author.id) return reply(msg, "❌ Não pode subornar a si mesmo.");
  const election = await db.query.elections.findFirst({ where: eq(schema.elections.isActive, true) });
  if (!election) return reply(msg, "❌ Sem eleição ativa.");
  const candidates = (election.candidates as string[]) ?? [];
  if (!candidates.includes(msg.author.id)) return reply(msg, "❌ Você não é candidato nesta eleição.");
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const orc = (p.inventory?._orcamento_politico as number) ?? 0;
  if (orc < v) return reply(msg, `❌ Seu orçamento político é ${formatMoney(orc)}. (ganhe orçamento ganhando uma eleição anterior)`);
  // Convite com reação ao alvo
  const e = new EmbedBuilder().setTitle("💼 Proposta de suborno eleitoral").setColor(0x884444)
    .setDescription(`<@${tid}>, <@${msg.author.id}> está te oferecendo **${formatMoney(v)}** pra você votar nele(a) na eleição.\n\n⚖️ Aceitar custa **-5 karma**.\nReaja ✅ pra aceitar ou ❌ pra recusar (60s).`);
  const sent = await msg.reply({ content: `<@${tid}>`, embeds: [e] }).catch(() => null);
  if (!sent) return;
  const ok = await awaitConfirm(sent, tid, 60000);
  if (ok !== true) return sent.reply(ok === false ? `🛡️ <@${tid}> recusou o suborno.` : `⏰ Sem resposta.`).catch(() => {});
  // Re-checa eleição e dinheiro
  const e2 = await db.query.elections.findFirst({ where: eq(schema.elections.isActive, true) });
  if (!e2 || e2.id !== election.id) return sent.reply("❌ Eleição encerrou.").catch(() => {});
  const votesNow = { ...((e2.votes as Record<string, string>) ?? {}) };
  if (votesNow[tid]) return sent.reply(`❌ <@${tid}> já tinha votado em <@${votesNow[tid]}>.`).catch(() => {});
  votesNow[tid] = msg.author.id;
  await db.update(schema.elections).set({ votes: votesNow }).where(eq(schema.elections.id, e2.id));
  // Debita orçamento e credita o eleitor
  const fresh = await getPlayer(msg.author.id);
  if (fresh) {
    const inv = { ...(fresh.inventory ?? {}) };
    inv["_orcamento_politico"] = Math.max(0, ((inv["_orcamento_politico"] as number) ?? 0) - v);
    await updatePlayer(msg.author.id, { inventory: inv });
  }
  await addMoney(tid, v);
  const target = await getPlayer(tid);
  if (target) await updatePlayer(tid, { karma: (target.karma ?? 0) - 5 });
  await logTransaction(msg.author.id, tid, v, "vote_buy", `Compra de voto`);
  return sent.reply(`💼 Suborno fechado! <@${tid}> recebeu ${formatMoney(v)} e votou em <@${msg.author.id}>. _(-5 karma)_`).catch(() => {});
});

reg(["proporlei", "lei"], async (msg, args) => {
  const efeito = (args[0] ?? "").toLowerCase();
  const nome = args.slice(1).join(" ");
  const EFEITOS: Record<string, string> = {
    tax_up: "Aumentar imposto +10%",
    tax_down: "Reduzir imposto -10%",
    police_up: "Aumentar segurança +20%",
    crime_easy: "Tolerar crime menor (-20%)",
    police_pay_up: "Aumentar salário policial +20%",
    police_pay_down: "Reduzir salário policial -20%",
  };
  if (!efeito || !nome || !(efeito in EFEITOS)) {
    return reply(msg, `❌ Uso: \`!proporlei <efeito> <nome da lei>\`\nEfeitos: ${Object.entries(EFEITOS).map(([k, v]) => `\`${k}\` (${v})`).join(", ")}`);
  }
  const gov = await getGovernment();
  if (gov.presidentId !== msg.author.id && gov.mayorId !== msg.author.id) {
    return reply(msg, "❌ Só presidente ou prefeito pode propor leis.");
  }
  await db.insert(schema.laws).values({ name: nome, description: EFEITOS[efeito], effect: efeito, proposedBy: msg.author.id, approvedAt: new Date() });
  const updates: any = { updatedAt: new Date() };
  if (efeito === "tax_up") updates.taxMultiplier = Math.min(200, gov.taxMultiplier + 10);
  if (efeito === "tax_down") updates.taxMultiplier = Math.max(0, gov.taxMultiplier - 10);
  if (efeito === "police_up") updates.crimeMultiplier = Math.min(200, gov.crimeMultiplier + 20);
  if (efeito === "crime_easy") updates.crimeMultiplier = Math.max(0, gov.crimeMultiplier - 20);
  if (efeito === "police_pay_up") updates.policeSalaryMultiplier = Math.min(200, gov.policeSalaryMultiplier + 20);
  if (efeito === "police_pay_down") updates.policeSalaryMultiplier = Math.max(0, gov.policeSalaryMultiplier - 20);
  await db.update(schema.government).set(updates).where(eq(schema.government.id, 1));
  return reply(msg, `📜 Lei **"${nome}"** sancionada!\nEfeito: ${EFEITOS[efeito]}`);
});

reg(["leis"], async (msg) => {
  const laws = await db.query.laws.findMany({ where: eq(schema.laws.isActive, true), limit: 20 });
  if (laws.length === 0) return reply(msg, "📜 Nenhuma lei ativa.");
  return reply(msg, "📜 **Leis em vigor:**\n" + laws.map(l => `• **${l.name}** — ${l.description} _(por <@${l.proposedBy}>)_`).join("\n"));
});

// ============ RACHA DE CARROS (reactions) ============
reg(["racha"], async (msg, args) => {
  const bet = intArg(args, 0);
  const tid = getMentionId(msg, args, 1) ?? (msg.mentions.users.first()?.id ?? null);
  if (!bet || !tid || tid === msg.author.id) {
    return reply(msg, "❌ Uso: `!racha <valor> @user` — desafia alguém para uma corrida apostando dinheiro.");
  }
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const t = await getPlayer(tid);
  if (!t) return reply(msg, "❌ O alvo precisa ter ficha (use o bot uma vez).");
  if (p.balance < bet || t.balance < bet) return reply(msg, `❌ Os dois precisam ter pelo menos ${formatMoney(bet)} em mãos.`);

  const myCars = await db.query.cars.findMany({ where: eq(schema.cars.ownerId, p.discordId) });
  const tgCars = await db.query.cars.findMany({ where: eq(schema.cars.ownerId, tid) });
  if (myCars.length === 0) return reply(msg, "❌ Você precisa de pelo menos um carro. Veja `!autos`.");
  if (tgCars.length === 0) return reply(msg, "❌ O desafiado não tem carro.");

  const pickFastest = (cars: typeof myCars) => {
    let best = cars[0];
    let bestSpeed = topSpeedFor(best.category, best.condition);
    for (const c of cars) {
      const sp = topSpeedFor(c.category, c.condition);
      if (sp > bestSpeed) { best = c; bestSpeed = sp; }
    }
    return { car: best, speed: bestSpeed };
  };

  const a = pickFastest(myCars);
  const b = pickFastest(tgCars);

  // Convite com reação ✅/❌
  const challengeEmbed = new EmbedBuilder().setTitle("🏁 Desafio de Racha!").setColor(0xff6600).setImage(GIFS.race).setDescription(
    `<@${msg.author.id}> desafiou <@${tid}> para um racha apostando **${formatMoney(bet)}** cada um.\n\n` +
    `🚗 ${a.car.model} — vel. máx ${a.speed} km/h (estado ${a.car.condition}%)\n` +
    `🚗 ${b.car.model} — vel. máx ${b.speed} km/h (estado ${b.car.condition}%)\n\n` +
    `<@${tid}>, reaja ✅ pra aceitar ou ❌ pra recusar (60s).`,
  );
  const sent = await msg.reply({ content: `<@${tid}>`, embeds: [challengeEmbed] }).catch(() => null);
  if (!sent) return;
  const ok = await awaitConfirm(sent, tid, 60000);
  if (ok !== true) return sent.reply(ok === false ? `🚫 <@${tid}> recusou o desafio.` : `⏰ <@${tid}> não respondeu.`).catch(() => {});

  // Re-checa saldos
  const ch2 = await getPlayer(msg.author.id);
  const me2 = await getPlayer(tid);
  if (!ch2 || !me2 || ch2.balance < bet || me2.balance < bet) return sent.reply("❌ Um dos dois ficou sem grana suficiente.").catch(() => {});

  // Simulação
  const TARGET = 1500;
  let posA = 0, posB = 0;
  for (let i = 0; i < 30; i++) {
    posA += a.speed * (0.7 + Math.random() * 0.6) * 0.05;
    posB += b.speed * (0.7 + Math.random() * 0.6) * 0.05;
    if (posA >= TARGET || posB >= TARGET) break;
  }
  const winnerIsA = posA >= posB;
  const winnerId = winnerIsA ? msg.author.id : tid;
  const loserId = winnerIsA ? tid : msg.author.id;

  await removeMoney(loserId, bet);
  await addMoney(winnerId, bet);
  await logTransaction(loserId, winnerId, bet, "race", "Aposta de racha");
  await db.update(schema.cars).set({ condition: Math.max(10, a.car.condition - 5) }).where(eq(schema.cars.id, a.car.id));
  await db.update(schema.cars).set({ condition: Math.max(10, b.car.condition - 5) }).where(eq(schema.cars.id, b.car.id));

  // Animação multi-frame
  const frame = (pa: number, pb: number, title: string) => ({
    title, color: 0xff6600, image: GIFS.race,
    content: `🚗 <@${msg.author.id}> ${a.car.model}: ${bar(Math.min(TARGET, pa), TARGET, 14)}\n🚗 <@${tid}> ${b.car.model}: ${bar(Math.min(TARGET, pb), TARGET, 14)}`,
  });
  await animate(sent as any, [
    frame(posA * 0.25, posB * 0.25, "🏁 3... 2... 1... GO!"),
    frame(posA * 0.5, posB * 0.5, "💨 Acelerando..."),
    frame(posA * 0.8, posB * 0.8, "🔥 Reta final!"),
    {
      title: "🏆 Resultado do Racha",
      image: GIFS.race,
      color: 0xff6600,
      content: `🚗 ${a.car.model}: ${bar(Math.min(TARGET, posA), TARGET, 14)}\n🚗 ${b.car.model}: ${bar(Math.min(TARGET, posB), TARGET, 14)}\n\n🏆 <@${winnerId}> venceu e levou **${formatMoney(bet)}**!\n💸 <@${loserId}> perdeu **${formatMoney(bet)}**.\n_Carros sofreram desgaste de 5%._`,
    },
  ], 1000);
});

reg(["aceitarracha", "recusarracha"], async (msg) => {
  return reply(msg, "ℹ️ Agora basta **reagir** com ✅ ou ❌ na mensagem do desafio. Sem comandos extras.");
});

// ============ EMPRESA — PREFIXO ! (apenas empresários certificados) ============
const COMPANY_CREATE_COST = 20000;
const IPO_COST = 50000;
const ADVERTISE_COST = 2000;
const EMPLOYEE_SALARY = 1500;

function isEmpresario(p: any): boolean {
  return p.profession === "empresario" && p.isCertified === true;
}

function getInv(p: any): any { return { ...(p.inventory ?? {}) }; }
function getMaterias(p: any): Record<string, number> { return { ...((p.inventory?._materias as Record<string, number>) ?? {}) }; }
function getEstoque(p: any): Record<string, number> { return { ...((p.inventory?._estoque as Record<string, number>) ?? {}) }; }
function getFabrica(p: any): { nivel: number; ramo: string } | null { return (p.inventory?._fabrica as any) ?? null; }

reg(["empresa", "minhaempresa"], async (msg) => {
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const c = await db.query.companies.findFirst({ where: eq(schema.companies.ownerId, p.discordId) });
  if (!c) {
    if (!isEmpresario(p)) return reply(msg, "❌ Apenas formados em **Empresário** podem ter empresa. Use `!curso empresario` e `!treinar`.");
    return reply(msg, `🏢 Você ainda não tem empresa. Use \`!ecriar "<nome>" <ramo>\`.\nVeja os ramos disponíveis com \`!ramos\`.\nCusto: ${formatMoney(COMPANY_CREATE_COST)}`);
  }
  const employees = (c.employees as string[]) ?? [];
  const lucro = c.revenue - c.expenses;
  const lucroIco = lucro >= 0 ? "📈" : "📉";
  const e = new EmbedBuilder().setTitle(`🏢 ${c.name}`).setColor(0x003388).addFields(
    { name: "🏭 Setor", value: c.sector, inline: true },
    { name: "📊 Nível", value: `${c.level}/10`, inline: true },
    { name: "⭐ Reputação", value: `${bar(c.reputation, 100)} ${c.reputation}`, inline: false },
    { name: "💰 Receita", value: formatMoney(c.revenue), inline: true },
    { name: "💸 Despesas", value: formatMoney(c.expenses), inline: true },
    { name: `${lucroIco} Lucro`, value: formatMoney(lucro), inline: true },
    { name: "👥 Funcionários", value: `${employees.length}/${c.level * 3}`, inline: true },
    { name: "📈 Bolsa", value: c.isPublic ? `[${c.stockSymbol}] ${formatMoney(c.sharePrice)}` : "Não (use `!eipo`)", inline: true },
    { name: "📝 Descrição", value: c.description ?? "—", inline: false },
  );
  return reply(msg, { embeds: [e] });
});

reg(["ecriar"], async (msg, args) => {
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  if (!isEmpresario(p)) return reply(msg, "❌ Apenas formados em **Empresário** certificados podem criar empresa. Use `!curso empresario` e `!treinar`.");

  // Aceita: !ecriar "<nome com espaços>" <ramo> [descrição]
  const raw = msg.content.replace(/^!\S+\s*/, "");
  const quoted = raw.match(/^"([^"]+)"\s+(\S+)(?:\s+(.*))?$/);
  let nome: string | undefined;
  let ramoKey: string | undefined;
  let descricao = "Sem descrição";
  if (quoted) {
    nome = quoted[1];
    ramoKey = quoted[2]?.toLowerCase();
    if (quoted[3]) descricao = quoted[3];
  } else {
    nome = args[0];
    ramoKey = args[1]?.toLowerCase();
    if (args.length > 2) descricao = args.slice(2).join(" ");
  }

  if (!nome || !ramoKey) {
    return reply(msg, `❌ Uso: \`!ecriar "<nome>" <ramo> [descrição]\`\nRamos: ${BRANCH_KEYS.join(", ")}\nVeja detalhes em \`!ramos\`.`);
  }
  const ramo = getBranch(ramoKey);
  if (!ramo) return reply(msg, `❌ Ramo inválido. Opções: ${BRANCH_KEYS.join(", ")}\nUse \`!ramos\` para ver detalhes.`);

  const owned = await db.query.companies.findFirst({ where: eq(schema.companies.ownerId, p.discordId) });
  if (owned) return reply(msg, "❌ Você já tem uma empresa.");
  const exists = await db.query.companies.findFirst({ where: sql`lower(${schema.companies.name}) = lower(${nome})` });
  if (exists) return reply(msg, `❌ Nome **${nome}** indisponível — já existe uma empresa com esse nome. Escolha outro.`);
  if (p.balance < COMPANY_CREATE_COST) return reply(msg, `❌ Custa ${formatMoney(COMPANY_CREATE_COST)}.`);

  await removeMoney(p.discordId, COMPANY_CREATE_COST);
  const id = `co_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  await db.insert(schema.companies).values({
    id, name: nome, ownerId: p.discordId, sector: ramo.name, description: descricao,
    employees: [], revenue: 0, expenses: COMPANY_CREATE_COST, totalShares: 1000, availableShares: 1000,
    sharePrice: 100, marketCap: 100000, isPublic: false, level: 1, reputation: 50, priceHistory: [],
  });

  // Marca o ramo na inventory para uso pela cadeia produtiva
  const inv = getInv(p);
  inv._fabrica = inv._fabrica ?? { nivel: 0, ramo: ramo.key };
  inv._fabrica.ramo = ramo.key;
  await updatePlayer(p.discordId, { inventory: inv });

  return reply(msg,
    `🏢 Empresa **${nome}** criada no ramo ${ramo.emoji} **${ramo.name}**!\n` +
    `Cadeia produtiva: \`!ematerias\` (comprar matéria-prima) → \`!econstruir\` (montar fábrica, ${formatMoney(FACTORY_BUILD_COST)}) → \`!efabricar\` → \`!eproduto add\` → vender com \`!ecomprar\`.\n` +
    `Veja produtos do seu ramo em \`!ramos ${ramo.key}\`.`
  );
});

reg(["econtratar", "contratar"], async (msg, args) => {
  const tid = getMentionId(msg, args, 0);
  if (!tid) return reply(msg, "❌ Uso: `!econtratar @user`");
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const c = await db.query.companies.findFirst({ where: eq(schema.companies.ownerId, p.discordId) });
  if (!c) return reply(msg, "❌ Você não tem empresa.");
  const t = await getPlayer(tid);
  if (!t) return reply(msg, "❌ Alvo precisa ter ficha.");
  const employees = (c.employees as string[]) ?? [];
  if (employees.includes(tid)) return reply(msg, "❌ Já é funcionário.");
  const max = c.level * 3;
  if (employees.length >= max) return reply(msg, `❌ Capacidade ${max} no nv ${c.level}. Faça \`!eexpandir\`.`);
  employees.push(tid);
  await db.update(schema.companies).set({ employees }).where(eq(schema.companies.id, c.id));
  return reply(msg, `✅ <@${tid}> contratado na **${c.name}**! Salário ${formatMoney(EMPLOYEE_SALARY)}/dia (use \`!epagar\`).`);
});

reg(["edemitir", "demitir"], async (msg, args) => {
  const tid = getMentionId(msg, args, 0);
  if (!tid) return reply(msg, "❌ Uso: `!edemitir @user`");
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const c = await db.query.companies.findFirst({ where: eq(schema.companies.ownerId, p.discordId) });
  if (!c) return reply(msg, "❌ Você não tem empresa.");
  const employees = ((c.employees as string[]) ?? []).filter(e => e !== tid);
  await db.update(schema.companies).set({ employees }).where(eq(schema.companies.id, c.id));
  return reply(msg, `👋 <@${tid}> foi demitido da **${c.name}**.`);
});

reg(["epagar", "folha"], async (msg) => {
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const c = await db.query.companies.findFirst({ where: eq(schema.companies.ownerId, p.discordId) });
  if (!c) return reply(msg, "❌ Você não tem empresa.");
  const employees = (c.employees as string[]) ?? [];
  if (employees.length === 0) return reply(msg, "❌ Sem funcionários.");
  if (c.lastPayroll && Date.now() - c.lastPayroll.getTime() < 24 * 60 * 60 * 1000) {
    return reply(msg, `⏳ Folha já paga hoje. Próxima em ${formatCooldown(24 * 60 * 60 * 1000 - (Date.now() - c.lastPayroll.getTime()))}.`);
  }
  const total = employees.length * EMPLOYEE_SALARY;
  if (p.balance < total) return reply(msg, `❌ Folha de ${formatMoney(total)}, você tem ${formatMoney(p.balance)}.`);
  await removeMoney(p.discordId, total);
  for (const id of employees) {
    const emp = await getPlayer(id);
    if (emp) await updatePlayer(id, { balance: emp.balance + EMPLOYEE_SALARY });
  }
  // Receita simulada baseada em reputação e funcionários
  const earned = Math.floor(employees.length * (300 + c.reputation * 8) * (0.8 + Math.random() * 0.4));
  await db.update(schema.companies).set({
    expenses: c.expenses + total,
    revenue: c.revenue + earned,
    lastPayroll: new Date(),
  }).where(eq(schema.companies.id, c.id));
  return reply(msg, `💼 Folha paga: ${employees.length}× ${formatMoney(EMPLOYEE_SALARY)} = ${formatMoney(total)}\n📊 Receita do dia: +${formatMoney(earned)}`);
});

reg(["eanunciar", "anunciar"], async (msg) => {
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const c = await db.query.companies.findFirst({ where: eq(schema.companies.ownerId, p.discordId) });
  if (!c) return reply(msg, "❌ Sem empresa.");
  if (p.balance < ADVERTISE_COST) return reply(msg, `❌ Custa ${formatMoney(ADVERTISE_COST)}.`);
  await removeMoney(p.discordId, ADVERTISE_COST);
  const gain = Math.floor(Math.random() * 10 + 5);
  const newRep = Math.min(100, c.reputation + gain);
  await db.update(schema.companies).set({ reputation: newRep, expenses: c.expenses + ADVERTISE_COST }).where(eq(schema.companies.id, c.id));
  return reply(msg, `📣 Anúncio veiculado! Reputação ${c.reputation} → ${newRep} (+${gain})`);
});

reg(["eexpandir", "expandir", "eupgrade"], async (msg) => {
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const c = await db.query.companies.findFirst({ where: eq(schema.companies.ownerId, p.discordId) });
  if (!c) return reply(msg, "❌ Sem empresa.");
  if (c.level >= 10) return reply(msg, "✅ Empresa já está no nível máximo.");
  const cost = c.level * 15000;
  if (p.balance < cost) return reply(msg, `❌ Expandir para nv ${c.level + 1} custa ${formatMoney(cost)}.`);
  await removeMoney(p.discordId, cost);
  const newLevel = c.level + 1;
  await db.update(schema.companies).set({
    level: newLevel,
    reputation: Math.min(100, c.reputation + 5),
    expenses: c.expenses + cost,
  }).where(eq(schema.companies.id, c.id));
  return reply(msg, `🏗️ **${c.name}** expandiu para nv ${newLevel}! Capacidade: ${newLevel * 3} funcionários.${newLevel === 3 ? "\n🎉 Desbloqueou IPO! Use `!eipo`." : ""}`);
});

reg(["eipo"], async (msg, args) => {
  const sym = args[0]?.toUpperCase();
  const preco = intArg(args, 1);
  if (!sym || !preco || sym.length < 3 || sym.length > 5) return reply(msg, "❌ Uso: `!eipo <SIMBOLO 3-5 letras> <preço inicial>`");
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const c = await db.query.companies.findFirst({ where: eq(schema.companies.ownerId, p.discordId) });
  if (!c) return reply(msg, "❌ Sem empresa.");
  if (c.isPublic) return reply(msg, "❌ Empresa já está na bolsa.");
  if (c.level < 3) return reply(msg, `❌ Empresa precisa ser nível 3+ (atual ${c.level}). Use \`!eexpandir\`.`);
  if (p.balance < IPO_COST) return reply(msg, `❌ IPO custa ${formatMoney(IPO_COST)}.`);
  const dup = await db.query.companies.findFirst({ where: eq(schema.companies.stockSymbol, sym) });
  if (dup) return reply(msg, "❌ Símbolo em uso.");
  await removeMoney(p.discordId, IPO_COST);
  await db.update(schema.companies).set({
    isPublic: true, stockSymbol: sym, sharePrice: preco, marketCap: preco * 1000,
    availableShares: 800, priceHistory: [preco], expenses: c.expenses + IPO_COST,
  }).where(eq(schema.companies.id, c.id));
  return reply(msg, `🚀 **${c.name}** [${sym}] entrou na bolsa! Preço inicial ${formatMoney(preco)}/ação · 800 ações disponíveis.\nVeja: \`!bdetalhe ${sym}\``);
});

reg(["esimular", "simular"], async (msg) => {
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const c = await db.query.companies.findFirst({ where: eq(schema.companies.ownerId, p.discordId) });
  if (!c) return reply(msg, "❌ Sem empresa.");
  if (!c.isPublic) return reply(msg, "❌ Empresa não está na bolsa. Use `!eipo`.");
  // Simulate one tick using employees count, reputation and randomness
  const employees = (c.employees as string[]) ?? [];
  const performance = (employees.length * 0.5 + c.reputation / 50 + (Math.random() - 0.5) * 2);
  const delta = Math.max(-0.15, Math.min(0.15, performance / 25));
  const newPrice = Math.max(1, Math.floor(c.sharePrice * (1 + delta)));
  const hist = [...((c.priceHistory as number[]) ?? []), newPrice].slice(-30);
  await db.update(schema.companies).set({ sharePrice: newPrice, marketCap: newPrice * c.totalShares, priceHistory: hist }).where(eq(schema.companies.id, c.id));

  // Companions (employees) holdings simulation: list current shareholders
  const holders = await db.query.stockPortfolios.findMany({ where: eq(schema.stockPortfolios.companyId, c.id) });
  const lines = holders.slice(0, 8).map(h => `• <@${h.playerId}> — ${h.shares} ações · ${formatMoney(h.shares * newPrice)}`).join("\n") || "Nenhum acionista além do dono.";

  const variation = ((newPrice - c.sharePrice) / c.sharePrice) * 100;
  const e = new EmbedBuilder()
    .setTitle(`📊 Simulação — ${c.name} [${c.stockSymbol}]`)
    .setColor(variation >= 0 ? 0x00aa44 : 0xaa2222)
    .addFields(
      { name: "💰 Preço", value: `${formatMoney(c.sharePrice)} → ${formatMoney(newPrice)} (${variation >= 0 ? "+" : ""}${variation.toFixed(2)}%)`, inline: false },
      { name: "👥 Funcionários", value: `${employees.length}`, inline: true },
      { name: "⭐ Reputação", value: `${c.reputation}`, inline: true },
      { name: "📈 Acionistas", value: lines, inline: false },
    );
  return reply(msg, { embeds: [e] });
});

reg(["elista", "empresas"], async (msg) => {
  const all = await db.query.companies.findMany({ limit: 20 });
  if (all.length === 0) return reply(msg, "🏢 Nenhuma empresa criada.");
  const e = new EmbedBuilder().setTitle("🏢 Empresas").setColor(0x004488);
  for (const c of all) {
    const emp = ((c.employees as string[]) ?? []).length;
    e.addFields({
      name: `${c.name} (Nv ${c.level})`,
      value: `🏭 ${c.sector} · 👥 ${emp} · ⭐ ${c.reputation}${c.isPublic ? ` · 📈 [${c.stockSymbol}] ${formatMoney(c.sharePrice)}` : ""}\nDono: <@${c.ownerId}>`,
      inline: false,
    });
  }
  return reply(msg, { embeds: [e] });
});

// ============ LAVAGEM DE DINHEIRO (empresa + crime) ============
reg(["lavar", "lavagem"], async (msg, args) => {
  const v = intArg(args, 0);
  if (!v) return reply(msg, "❌ Uso: `!lavar <valor sujo>` — empresários lavam dinheiro pela empresa.");
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const c = await db.query.companies.findFirst({ where: eq(schema.companies.ownerId, p.discordId) });
  if (!c) return reply(msg, "❌ Precisa ter empresa para lavar.");
  if (p.criminalRecord < 1) return reply(msg, "❌ Lavagem é coisa de criminoso. Sua ficha está limpa demais.");
  if (p.balance < v) return reply(msg, "❌ Sem dinheiro pra lavar.");
  await removeMoney(p.discordId, v);
  // 25% de risco de fiscalização: perde tudo + ficha
  if (Math.random() < 0.25) {
    await updatePlayer(p.discordId, { criminalRecord: p.criminalRecord + 2, wantedLevel: p.wantedLevel + 1, karma: p.karma - 10, reputation: p.reputation - 30 });
    return reply(msg, `🚨 **RECEITA FEDERAL!** A operação foi descoberta. Você perdeu ${formatMoney(v)}, ficha +2 e procurado +1.`);
  }
  // Sucesso: 80% volta como receita "limpa" da empresa
  const limpo = Math.floor(v * 0.8);
  await addMoney(p.discordId, limpo);
  await db.update(schema.companies).set({ revenue: c.revenue + limpo }).where(eq(schema.companies.id, c.id));
  await logTransaction(p.discordId, p.discordId, limpo, "laundry", `Lavagem via ${c.name}`);
  return reply(msg, `🧼 Lavagem bem sucedida via **${c.name}**! Recebeu ${formatMoney(limpo)} (80%) limpo.\n_Karma -5 · Ficha intocada._`);
});

// ============ IMPEACHMENT ============
reg(["impeachment", "impeach"], async (msg, args) => {
  const target = (args[0] ?? "").toLowerCase();
  if (target !== "presidente" && target !== "prefeito") {
    return reply(msg, "❌ Uso: `!impeachment <presidente|prefeito>`");
  }
  const gov = await getGovernment();
  const officerId = target === "presidente" ? gov.presidentId : gov.mayorId;
  if (!officerId) return reply(msg, `❌ Não há ${target} no momento.`);
  if (officerId === msg.author.id) return reply(msg, "❌ Você não pode pedir o próprio impeachment.");

  const sent = await msg.channel.send({
    embeds: [
      new EmbedBuilder()
        .setTitle("⚖️ PEDIDO DE IMPEACHMENT")
        .setColor(0xaa0000)
        .setDescription(
          `<@${msg.author.id}> abriu impeachment contra <@${officerId}> (**${target}**).\n` +
          `Reaja ✅ em **3 minutos** — precisamos de **30 apoiadores** (sem contar o autor).\n\n` +
          `Se aprovado, o orçamento político restante é confiscado e dividido entre os apoiadores.`
        )
        .setImage(GIFS.vote),
    ],
  }).catch(() => null);
  if (!sent) return;
  await sent.react("✅").catch(() => {});

  try {
    await sent.awaitReactions({
      filter: (r: any, u: any) => r.emoji.name === "✅" && !u.bot,
      time: 180_000,
    });
  } catch {}

  const fresh = await sent.fetch().catch(() => null);
  const reaction = fresh?.reactions.cache.get("✅");
  let supporters: string[] = [];
  if (reaction) {
    const users = await reaction.users.fetch().catch(() => null);
    supporters = users
      ? Array.from(users.values()).filter((u: any) => !u.bot && u.id !== msg.author.id && u.id !== officerId).map((u: any) => u.id)
      : [];
  }

  if (supporters.length < 30) {
    return msg.channel.send(`❌ Impeachment falhou: ${supporters.length}/30 apoiadores.`).catch(() => {});
  }

  // Remove from government
  if (target === "presidente") {
    await db.update(schema.government).set({ presidentId: null }).where(eq(schema.government.id, 1));
  } else {
    await db.update(schema.government).set({ mayorId: null }).where(eq(schema.government.id, 1));
  }

  // Confiscate political budget
  const officer = await getPlayer(officerId);
  const inv: any = { ...((officer?.inventory as any) ?? {}) };
  const orc = (inv._orcamento_politico as number) ?? 0;
  inv._orcamento_politico = 0;
  if (officer) await updatePlayer(officerId, { inventory: inv });

  const all = [msg.author.id, ...supporters];
  const share = Math.floor(orc / all.length);
  if (share > 0) for (const id of all) await addMoney(id, share);

  return msg.channel.send({
    embeds: [
      new EmbedBuilder()
        .setTitle("⚖️ IMPEACHMENT APROVADO")
        .setColor(0xaa0000)
        .setDescription(
          `<@${officerId}> foi removido(a) do cargo de **${target}**.\n` +
          `💰 Orçamento confiscado: **${formatMoney(orc)}**\n` +
          `👥 Distribuído entre ${all.length} apoiadores: **${formatMoney(share)}** cada.`
        )
        .setImage(GIFS.vote),
    ],
  }).catch(() => {});
});

// ============ PRODUTOS DA EMPRESA ============
type Produto = { id: number; nome: string; preco: number; custo: number; vendidos: number; prodKey?: string };

reg(["eproduto", "produto", "produtos"], async (msg, args) => {
  const sub = (args[0] ?? "").toLowerCase();
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);

  if (sub === "add" || sub === "criar" || sub === "novo") {
    const c = await db.query.companies.findFirst({ where: eq(schema.companies.ownerId, p.discordId) });
    if (!c) return reply(msg, "❌ Você não tem empresa.");

    // Modo 1 — fabricado: !eproduto add fab <prodKey> <preço>
    if ((args[1] ?? "").toLowerCase() === "fab" || (args[1] ?? "").toLowerCase() === "fabricado") {
      const prodKey = args[2]?.toLowerCase();
      const preco = intArg(args, 3);
      const found = prodKey ? findProduct(prodKey) : null;
      if (!found || !preco) {
        return reply(msg, '❌ Uso: `!eproduto add fab <prodKey> <preço>`\nVeja `!ramos` para os prodKeys.');
      }
      const fab = getFabrica(p);
      if (!fab || fab.ramo !== found.branch.key) {
        return reply(msg, `❌ Esse produto pertence ao ramo **${found.branch.name}**, mas sua empresa é de outro ramo.`);
      }
      const inv: any = { ...(p.inventory ?? {}) };
      const list: Produto[] = (inv._produtos as Produto[]) ?? [];
      if (list.length >= 5) return reply(msg, "❌ Limite de 5 produtos por empresa.");
      if (list.some(x => x.prodKey === prodKey)) return reply(msg, "❌ Esse produto já está cadastrado.");
      const custo = found.product.laborCost;
      if (custo >= preco) return reply(msg, `❌ O preço precisa ser maior que o custo de produção (${formatMoney(custo)}).`);
      const id = (list.reduce((m, x) => Math.max(m, x.id), 0) || 0) + 1;
      list.push({ id, nome: `${found.product.emoji} ${found.product.name}`, preco, custo, vendidos: 0, prodKey: found.product.key });
      inv._produtos = list;
      await updatePlayer(p.discordId, { inventory: inv });
      return reply(msg, `✅ Produto fabricado \`${id}\` **${found.product.name}** cadastrado na loja por ${formatMoney(preco)} (custo ${formatMoney(custo)}). Fabrique unidades com \`!efabricar ${prodKey} <qtd>\`.`);
    }

    // Modo 2 — livre (legado): !eproduto add "<nome>" <preço> <custo>
    let nome = args[1];
    let preco = intArg(args, 2);
    let custo = intArg(args, 3);
    const raw = msg.content.slice(msg.content.indexOf(args[0]) + args[0].length).trim();
    const m = raw.match(/^"([^"]+)"\s+(\d+)\s+(\d+)/);
    if (m) {
      nome = m[1];
      preco = parseInt(m[2], 10);
      custo = parseInt(m[3], 10);
    }
    if (!nome || !preco || custo === null || custo === undefined) {
      return reply(msg, '❌ Uso:\n• `!eproduto add fab <prodKey> <preço>` (fabricado, entrega item útil)\n• `!eproduto add "<nome>" <preço> <custo>` (livre, sem utilidade)');
    }
    if (custo >= preco) return reply(msg, "❌ O custo precisa ser menor que o preço.");
    const inv: any = { ...(p.inventory ?? {}) };
    const list: Produto[] = (inv._produtos as Produto[]) ?? [];
    if (list.length >= 5) return reply(msg, "❌ Limite de 5 produtos por empresa.");
    const id = (list.reduce((m, x) => Math.max(m, x.id), 0) || 0) + 1;
    list.push({ id, nome, preco, custo, vendidos: 0 });
    inv._produtos = list;
    await updatePlayer(p.discordId, { inventory: inv });
    return reply(msg, `✅ Produto \`${id}\` **${nome}** criado — ${formatMoney(preco)} (custo ${formatMoney(custo)}).`);
  }

  if (sub === "rm" || sub === "remover" || sub === "del") {
    const id = intArg(args, 1);
    if (!id) return reply(msg, "❌ Uso: `!eproduto rm <id>`");
    const inv: any = { ...(p.inventory ?? {}) };
    const list: Produto[] = (inv._produtos as Produto[]) ?? [];
    inv._produtos = list.filter(x => x.id !== id);
    await updatePlayer(p.discordId, { inventory: inv });
    return reply(msg, `🗑️ Produto removido.`);
  }

  // Lista (default ou "lista")
  const tid = getMentionId(msg, args, sub === "lista" ? 1 : 0) ?? p.discordId;
  const owner = await getPlayer(tid);
  if (!owner) return reply(msg, "❌ Dono inválido.");
  const oc = await db.query.companies.findFirst({ where: eq(schema.companies.ownerId, tid) });
  if (!oc) return reply(msg, "❌ Esse usuário não tem empresa.");
  const list: Produto[] = ((owner.inventory as any)?._produtos as Produto[]) ?? [];
  if (list.length === 0) return reply(msg, `📦 **${oc.name}** não cadastrou produtos. Dono use \`!eproduto add\`.`);
  const e = new EmbedBuilder()
    .setTitle(`📦 Produtos — ${oc.name}`)
    .setColor(0x004488)
    .setDescription(
      list.map(x => `\`${x.id}\` **${x.nome}** — ${formatMoney(x.preco)} _(custo ${formatMoney(x.custo)} · vendidos ${x.vendidos})_`).join("\n")
    )
    .setFooter({ text: `Comprar: !ecomprar @${owner.username} <id> [qtd]` });
  return reply(msg, { embeds: [e] });
});

reg(["ecomprar", "comprarprod"], async (msg, args) => {
  const tid = getMentionId(msg, args, 0);
  const pid = intArg(args, 1);
  const qtd = Math.max(1, intArg(args, 2) ?? 1);
  if (!tid || !pid) return reply(msg, "❌ Uso: `!ecomprar @dono <produto_id> [qtd]`");
  if (tid === msg.author.id) return reply(msg, "❌ Não dá pra comprar de si mesmo.");

  const buyer = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const owner = await getPlayer(tid);
  if (!owner) return reply(msg, "❌ Dono inválido.");
  const c = await db.query.companies.findFirst({ where: eq(schema.companies.ownerId, tid) });
  if (!c) return reply(msg, "❌ Esse usuário não tem empresa.");
  const oinv: any = { ...(owner.inventory ?? {}) };
  const list: Produto[] = (oinv._produtos as Produto[]) ?? [];
  const prod = list.find(x => x.id === pid);
  if (!prod) return reply(msg, "❌ Produto não existe.");
  const total = prod.preco * qtd;
  if (buyer.balance < total) return reply(msg, `❌ Faltam ${formatMoney(total - buyer.balance)}.`);

  // Se for produto fabricado, precisa ter estoque na fábrica do dono
  let prodDef: ReturnType<typeof findProduct> = null;
  if (prod.prodKey) {
    prodDef = findProduct(prod.prodKey);
    const estoque = (oinv._estoque as Record<string, number>) ?? {};
    const disponivel = estoque[prod.prodKey] ?? 0;
    if (disponivel < qtd) {
      return reply(msg, `❌ **${prod.nome}** está esgotado. Disponível: ${disponivel}. Peça ao dono para fabricar mais com \`!efabricar ${prod.prodKey}\`.`);
    }
    estoque[prod.prodKey] = disponivel - qtd;
    oinv._estoque = estoque;
  }

  const employees: string[] = (c.employees as string[]) ?? [];
  const now = Date.now();
  const dia = 24 * 60 * 60 * 1000;
  const activeWorkers: string[] = [];
  for (const eid of employees) {
    const e = await getPlayer(eid);
    const t = ((e?.inventory as any)?._worked_at?.[c.id]) ?? 0;
    if (now - t < dia) activeWorkers.push(eid);
  }

  await removeMoney(buyer.discordId, total);
  const lucro = (prod.preco - prod.custo) * qtd;
  const tax = Math.floor(total * 0.10);
  const workerPool = activeWorkers.length > 0 ? Math.floor(lucro * 0.30) : 0;
  const ownerNet = total - tax - workerPool;

  await addMoney(tid, ownerNet);
  if (workerPool > 0 && activeWorkers.length > 0) {
    const each = Math.floor(workerPool / activeWorkers.length);
    for (const wid of activeWorkers) await addMoney(wid, each);
  }

  // Atualiza produto + extrato do dono
  prod.vendidos += qtd;
  oinv._produtos = list;
  oinv._extrato = oinv._extrato ?? { revenue: 0, lucro: 0, tax: 0, workers: 0, since: now };
  if (now - (oinv._extrato.since ?? 0) > 7 * dia) oinv._extrato = { revenue: 0, lucro: 0, tax: 0, workers: 0, since: now };
  oinv._extrato.revenue += total;
  oinv._extrato.lucro += lucro;
  oinv._extrato.tax += tax;
  oinv._extrato.workers += workerPool;
  await updatePlayer(tid, { inventory: oinv });

  await db.update(schema.companies).set({
    revenue: c.revenue + total,
    expenses: c.expenses + (prod.custo * qtd) + tax,
  }).where(eq(schema.companies.id, c.id));

  // Entrega o item útil ao comprador (se for produto fabricado)
  let entregaTxt = "";
  if (prodDef) {
    const binv: any = { ...(buyer.inventory ?? {}) };
    binv[prodDef.product.key] = (binv[prodDef.product.key] ?? 0) + qtd;
    await updatePlayer(buyer.discordId, { inventory: binv });
    entregaTxt = `\n🎁 Recebeu ${qtd}× **${prodDef.product.name}** no inventário. Use com \`!usar ${prodDef.product.key}\`.`;
  }

  await logTransaction(buyer.discordId, tid, total, "purchase", `${qtd}× ${prod.nome} (${c.name})`);

  const breakdown =
    `🛒 ${qtd}× **${prod.nome}** — ${formatMoney(total)}\n` +
    `→ 🏢 Dono: ${formatMoney(ownerNet)}\n` +
    `→ 🧾 Imposto: ${formatMoney(tax)}\n` +
    `→ 👷 ${activeWorkers.length} func. ativo(s): ${formatMoney(workerPool)}` +
    (activeWorkers.length === 0 ? " _(ninguém bateu ponto)_" : "") +
    entregaTxt;
  return reply(msg, breakdown);
});

reg(["etrabalhar", "bater", "ponto"], async (msg) => {
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const all = await db.query.companies.findMany();
  const employer = all.find(c => ((c.employees as string[]) ?? []).includes(p.discordId));
  if (!employer) return reply(msg, "❌ Você não trabalha em empresa nenhuma. Peça para um empresário te contratar.");
  const inv: any = { ...(p.inventory ?? {}) };
  inv._worked_at = inv._worked_at ?? {};
  const last = (inv._worked_at[employer.id] as number) ?? 0;
  const cd = 60 * 60 * 1000;
  if (Date.now() - last < cd) {
    return reply(msg, `⏳ Já bateu ponto. Próximo turno em ${formatCooldown(cd - (Date.now() - last))}.`);
  }
  inv._worked_at[employer.id] = Date.now();
  inv._xp = ((inv._xp as number) ?? 0) + 8;
  await updatePlayer(p.discordId, { inventory: inv });
  await db.update(schema.companies).set({ reputation: Math.min(100, employer.reputation + 1) }).where(eq(schema.companies.id, employer.id));
  return animate(msg, [
    { title: "🛠️ Bateu o ponto", color: 0x004488, content: `Trabalhando na **${employer.name}**…`, image: GIFS.work },
    { title: "✅ Turno registrado", color: 0x00aa44, content: `Você é **funcionário ativo** por 24h.\nQuando alguém comprar produtos da **${employer.name}**, você ganha comissão automaticamente.\n+8 XP · +1 reputação da empresa.` },
  ], 800);
});

reg(["eextrato", "extrato"], async (msg) => {
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const c = await db.query.companies.findFirst({ where: eq(schema.companies.ownerId, p.discordId) });
  if (!c) return reply(msg, "❌ Sem empresa.");
  const inv: any = p.inventory ?? {};
  const ext = inv._extrato ?? { revenue: 0, lucro: 0, tax: 0, workers: 0, since: Date.now() };
  const employees: string[] = (c.employees as string[]) ?? [];
  const now = Date.now();
  const dia = 24 * 60 * 60 * 1000;
  const empLines: string[] = [];
  for (const eid of employees) {
    const e = await getPlayer(eid);
    const last = ((e?.inventory as any)?._worked_at?.[c.id]) ?? 0;
    const ativo = now - last < dia;
    empLines.push(`${ativo ? "🟢" : "🔴"} <@${eid}> — ${ativo ? `ativo (${formatCooldown(dia - (now - last))} restantes)` : "ausente"}`);
  }
  const produtos: Produto[] = (inv._produtos as Produto[]) ?? [];
  const prodLines = produtos.length === 0
    ? "_Nenhum produto cadastrado. Use `!eproduto add`._"
    : produtos.map(x => `\`${x.id}\` **${x.nome}** — ${formatMoney(x.preco)} · vendidos: ${x.vendidos}`).join("\n");

  const lucroTotal = c.revenue - c.expenses;
  const dias = Math.max(1, Math.floor((now - (ext.since ?? now)) / dia));
  const e = new EmbedBuilder()
    .setTitle(`📊 Extrato — ${c.name}`)
    .setColor(lucroTotal >= 0 ? 0x00aa44 : 0xaa2222)
    .addFields(
      { name: "💰 Receita histórica", value: formatMoney(c.revenue), inline: true },
      { name: "💸 Despesas históricas", value: formatMoney(c.expenses), inline: true },
      { name: lucroTotal >= 0 ? "📈 Lucro acumulado" : "📉 Prejuízo", value: formatMoney(lucroTotal), inline: true },
      { name: `🗓️ Janela atual (${dias}d)`, value: `Receita: ${formatMoney(ext.revenue)}\nLucro bruto: ${formatMoney(ext.lucro)}\nImpostos: ${formatMoney(ext.tax)}\nPago a funcionários: ${formatMoney(ext.workers)}`, inline: false },
      { name: "📦 Produtos", value: prodLines, inline: false },
      { name: `👥 Funcionários (${employees.length}/${c.level * 3})`, value: empLines.join("\n") || "_Nenhum_", inline: false },
    )
    .setFooter({ text: "Funcionários precisam usar !etrabalhar a cada 24h pra receber comissão." });
  return reply(msg, { embeds: [e] });
});

// ============ TOP / HELP ============
reg(["top", "ranking"], async (msg) => {
  const top = await db.query.players.findMany({ orderBy: [desc(schema.players.balance)], limit: 10 });
  return reply(msg, "🏆 **Top 10 mais ricos**\n" + top.map((p, i) => `${i + 1}. ${p.username} — ${formatMoney(p.balance + p.bankBalance)}`).join("\n"));
});

// ============ CADEIA PRODUTIVA — RAMOS / MATÉRIA-PRIMA / FÁBRICA ============

reg(["ramos", "ramo"], async (msg, args) => {
  const key = args[0]?.toLowerCase();
  if (key) {
    const b = getBranch(key);
    if (!b) return reply(msg, `❌ Ramo desconhecido. Opções: ${BRANCH_KEYS.join(", ")}`);
    const e = new EmbedBuilder()
      .setTitle(`${b.emoji} Ramo — ${b.name}`)
      .setColor(0x884400)
      .setDescription(b.description)
      .addFields(
        {
          name: "📦 Matérias-primas (compre com `!ematerias <key> [qtd]`)",
          value: b.materials.map(m => `${m.emoji} \`${m.key}\` **${m.name}** — ${formatMoney(m.price)}/un`).join("\n"),
        },
        {
          name: "🏭 Produtos (fabrique com `!efabricar <key> [qtd]`, depois `!eproduto add fab <key> <preço>`)",
          value: b.products.map(p => {
            const mat = Object.entries(p.materials).map(([k, q]) => `${q}× ${k}`).join(" + ");
            const util = p.utility.type === "weapon" ? `🔫 arma equipável (${p.utility.weaponKey})`
              : p.utility.type === "heal" ? `❤️ +${p.utility.amount} saúde`
              : p.utility.type === "energy" ? `⚡ +${p.utility.amount} energia`
              : p.utility.type === "xp" ? `✨ +${p.utility.amount} XP`
              : `⭐ +${p.utility.amount} reputação`;
            return `${p.emoji} \`${p.key}\` **${p.name}** _(fáb. nv ${p.factoryLevel})_\n` +
                   `  Receita: ${mat} · mão-de-obra ${formatMoney(p.laborCost)}\n` +
                   `  Utilidade: ${util} · sugerido ${formatMoney(p.suggestedPrice)}`;
          }).join("\n\n"),
        },
      );
    return reply(msg, { embeds: [e] });
  }
  const e = new EmbedBuilder()
    .setTitle("🏭 Ramos Empresariais")
    .setColor(0x884400)
    .setDescription("Cada ramo tem cadeia produtiva real: **matéria-prima → fábrica → produto → utilidade no servidor**.\nEscolha um ao criar empresa: `!ecriar \"<nome>\" <ramo>`.")
    .addFields(
      ...Object.values(BRANCHES).map(b => ({
        name: `${b.emoji} \`${b.key}\` — ${b.name}`,
        value: `${b.description}\nDetalhes: \`!ramos ${b.key}\``,
      })),
    );
  return reply(msg, { embeds: [e] });
});

reg(["ematerias", "ecomprarmateria", "ematprima"], async (msg, args) => {
  const matKey = args[0]?.toLowerCase();
  const qtd = Math.max(1, intArg(args, 1) ?? 1);
  if (!matKey) return reply(msg, "❌ Uso: `!ematerias <materialKey> [qtd]`\nVeja keys em `!ramos <ramo>`.");
  const found = findMaterial(matKey);
  if (!found) return reply(msg, "❌ Matéria-prima desconhecida. Veja `!ramos`.");
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const c = await db.query.companies.findFirst({ where: eq(schema.companies.ownerId, p.discordId) });
  if (!c) return reply(msg, "❌ Você não tem empresa.");
  const fab = getFabrica(p);
  if (!fab || fab.ramo !== found.branch.key) {
    return reply(msg, `❌ Sua empresa é do ramo **${fab ? getBranch(fab.ramo)?.name : "?"}**, mas **${found.material.name}** pertence a **${found.branch.name}**.`);
  }
  const total = found.material.price * qtd;
  if (p.balance < total) return reply(msg, `❌ Custa ${formatMoney(total)}. Faltam ${formatMoney(total - p.balance)}.`);
  await removeMoney(p.discordId, total);
  const inv = getInv(p);
  const mats = getMaterias(p);
  mats[matKey] = (mats[matKey] ?? 0) + qtd;
  inv._materias = mats;
  await updatePlayer(p.discordId, { inventory: inv });
  await db.update(schema.companies).set({ expenses: c.expenses + total }).where(eq(schema.companies.id, c.id));
  return reply(msg, `📦 Comprou ${qtd}× ${found.material.emoji} **${found.material.name}** por ${formatMoney(total)}. Estoque atual: ${mats[matKey]}.`);
});

reg(["emateriais", "estoquemat"], async (msg) => {
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const fab = getFabrica(p);
  const mats = getMaterias(p);
  if (Object.keys(mats).length === 0) return reply(msg, "📦 Sem matérias-primas. Compre com `!ematerias <key> [qtd]`.");
  const branchInfo = fab ? getBranch(fab.ramo) : null;
  const lines = Object.entries(mats).map(([k, q]) => {
    const m = findMaterial(k);
    return `${m?.material.emoji ?? "📦"} \`${k}\` **${m?.material.name ?? k}** — ${q} un`;
  });
  const e = new EmbedBuilder()
    .setTitle(`📦 Matérias-primas${branchInfo ? ` — ${branchInfo.name}` : ""}`)
    .setColor(0x886600)
    .setDescription(lines.join("\n"));
  return reply(msg, { embeds: [e] });
});

reg(["efabrica"], async (msg) => {
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const c = await db.query.companies.findFirst({ where: eq(schema.companies.ownerId, p.discordId) });
  if (!c) return reply(msg, "❌ Você não tem empresa.");
  const fab = getFabrica(p);
  if (!fab || fab.nivel < 1) {
    return reply(msg, `🏭 Sua empresa **${c.name}** ainda não tem fábrica. Construa com \`!econstruir\` por ${formatMoney(FACTORY_BUILD_COST)}.`);
  }
  const branch = getBranch(fab.ramo);
  const upgradeCost = FACTORY_UPGRADE_BASE * (fab.nivel + 1);
  const e = new EmbedBuilder()
    .setTitle(`🏭 Fábrica — ${c.name}`)
    .setColor(0x004488)
    .addFields(
      { name: "Ramo", value: `${branch?.emoji ?? ""} ${branch?.name ?? fab.ramo}`, inline: true },
      { name: "Nível", value: `${fab.nivel} / ${MAX_FACTORY_LEVEL}`, inline: true },
      { name: "Próximo upgrade", value: fab.nivel >= MAX_FACTORY_LEVEL ? "🏆 Nível máximo" : `\`!eupgradefabrica\` — ${formatMoney(upgradeCost)}`, inline: false },
      { name: "Produtos liberados", value: branch?.products.filter(p => p.factoryLevel <= fab.nivel).map(p => `${p.emoji} ${p.name}`).join(", ") || "_nenhum_", inline: false },
    );
  return reply(msg, { embeds: [e] });
});

reg(["econstruir", "construirfabrica"], async (msg) => {
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const c = await db.query.companies.findFirst({ where: eq(schema.companies.ownerId, p.discordId) });
  if (!c) return reply(msg, "❌ Você não tem empresa.");
  const fab = getFabrica(p);
  if (fab && fab.nivel >= 1) return reply(msg, `🏭 Sua fábrica já está construída (nível ${fab.nivel}). Para evoluir use \`!eupgradefabrica\`.`);
  if (!fab) return reply(msg, "❌ Sua empresa não tem ramo definido. Recrie a empresa.");
  if (p.balance < FACTORY_BUILD_COST) return reply(msg, `❌ Custa ${formatMoney(FACTORY_BUILD_COST)}.`);
  await removeMoney(p.discordId, FACTORY_BUILD_COST);
  const inv = getInv(p);
  inv._fabrica = { nivel: 1, ramo: fab.ramo };
  await updatePlayer(p.discordId, { inventory: inv });
  await db.update(schema.companies).set({ expenses: c.expenses + FACTORY_BUILD_COST }).where(eq(schema.companies.id, c.id));
  const branch = getBranch(fab.ramo);
  return reply(msg, `🏭 Fábrica de **${branch?.name}** construída no nível 1! Já pode \`!efabricar\` os produtos básicos do ramo.`);
});

reg(["eupgradefabrica", "eupfabrica", "eupgrade"], async (msg) => {
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const c = await db.query.companies.findFirst({ where: eq(schema.companies.ownerId, p.discordId) });
  if (!c) return reply(msg, "❌ Você não tem empresa.");
  const fab = getFabrica(p);
  if (!fab || fab.nivel < 1) return reply(msg, "❌ Construa a fábrica primeiro com `!econstruir`.");
  if (fab.nivel >= MAX_FACTORY_LEVEL) return reply(msg, "🏆 Sua fábrica já está no nível máximo.");
  const cost = FACTORY_UPGRADE_BASE * (fab.nivel + 1);
  if (p.balance < cost) return reply(msg, `❌ Upgrade para nível ${fab.nivel + 1} custa ${formatMoney(cost)}. Faltam ${formatMoney(cost - p.balance)}.`);
  await removeMoney(p.discordId, cost);
  const inv = getInv(p);
  inv._fabrica = { nivel: fab.nivel + 1, ramo: fab.ramo };
  await updatePlayer(p.discordId, { inventory: inv });
  await db.update(schema.companies).set({ expenses: c.expenses + cost, level: Math.max(c.level, fab.nivel + 1) }).where(eq(schema.companies.id, c.id));
  return reply(msg, `🏗️ Fábrica subiu para nível **${fab.nivel + 1}**! Novos produtos podem estar disponíveis — veja \`!efabrica\`.`);
});

reg(["efabricar", "produzir"], async (msg, args) => {
  const prodKey = args[0]?.toLowerCase();
  const qtd = Math.max(1, intArg(args, 1) ?? 1);
  if (!prodKey) return reply(msg, "❌ Uso: `!efabricar <prodKey> [qtd]`\nVeja prodKeys em `!ramos <ramo>`.");
  const found = findProduct(prodKey);
  if (!found) return reply(msg, "❌ Produto desconhecido.");
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const c = await db.query.companies.findFirst({ where: eq(schema.companies.ownerId, p.discordId) });
  if (!c) return reply(msg, "❌ Você não tem empresa.");
  const fab = getFabrica(p);
  if (!fab || fab.nivel < 1) return reply(msg, "❌ Construa a fábrica primeiro com `!econstruir`.");
  if (fab.ramo !== found.branch.key) return reply(msg, `❌ Esse produto é do ramo **${found.branch.name}**, sua empresa é **${getBranch(fab.ramo)?.name}**.`);
  if (fab.nivel < found.product.factoryLevel) return reply(msg, `❌ Precisa de fábrica nível **${found.product.factoryLevel}** (você tem ${fab.nivel}). Use \`!eupgradefabrica\`.`);

  const mats = getMaterias(p);
  const faltando: string[] = [];
  for (const [k, q] of Object.entries(found.product.materials)) {
    const have = mats[k] ?? 0;
    const need = q * qtd;
    if (have < need) faltando.push(`${need - have}× ${k}`);
  }
  if (faltando.length) return reply(msg, `❌ Matéria-prima insuficiente. Faltam: ${faltando.join(", ")}.\nCompre com \`!ematerias\`.`);
  const custoTotal = found.product.laborCost * qtd;
  if (p.balance < custoTotal) return reply(msg, `❌ Mão-de-obra/operação custa ${formatMoney(custoTotal)}. Faltam ${formatMoney(custoTotal - p.balance)}.`);

  for (const [k, q] of Object.entries(found.product.materials)) mats[k] = (mats[k] ?? 0) - q * qtd;
  await removeMoney(p.discordId, custoTotal);
  const inv = getInv(p);
  inv._materias = mats;
  const estoque = getEstoque(p);
  estoque[prodKey] = (estoque[prodKey] ?? 0) + qtd;
  inv._estoque = estoque;
  await updatePlayer(p.discordId, { inventory: inv });
  await db.update(schema.companies).set({ expenses: c.expenses + custoTotal }).where(eq(schema.companies.id, c.id));
  return reply(msg, `🏭 Fabricou ${qtd}× ${found.product.emoji} **${found.product.name}** (custo de produção ${formatMoney(custoTotal)}). Estoque agora: ${estoque[prodKey]}. Cadastre na loja com \`!eproduto add fab ${prodKey} <preço>\`.`);
});

reg(["estoque", "epfabrica"], async (msg, args) => {
  const tid = getMentionId(msg, args, 0) ?? msg.author.id;
  const owner = await getPlayer(tid) ?? await getOrCreatePlayer(tid, msg.author.username);
  const c = await db.query.companies.findFirst({ where: eq(schema.companies.ownerId, tid) });
  if (!c) return reply(msg, "❌ Esse usuário não tem empresa.");
  const estoque = ((owner.inventory as any)?._estoque as Record<string, number>) ?? {};
  const entries = Object.entries(estoque).filter(([_, q]) => q > 0);
  if (entries.length === 0) return reply(msg, `📦 **${c.name}** não tem produtos em estoque.`);
  const e = new EmbedBuilder()
    .setTitle(`🏭 Estoque — ${c.name}`)
    .setColor(0x004488)
    .setDescription(entries.map(([k, q]) => {
      const f = findProduct(k);
      return `${f?.product.emoji ?? "📦"} \`${k}\` **${f?.product.name ?? k}** — ${q} un`;
    }).join("\n"));
  return reply(msg, { embeds: [e] });
});

reg(["usar", "consumir"], async (msg, args) => {
  const key = args[0]?.toLowerCase();
  if (!key) return reply(msg, "❌ Uso: `!usar <prodKey>`\nItens fabricados que você comprou aparecem no seu inventário.");
  const found = findProduct(key);
  if (!found) return reply(msg, "❌ Item desconhecido.");
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const inv: any = { ...(p.inventory ?? {}) };
  const have = (inv[key] as number) ?? 0;
  if (have <= 0) return reply(msg, `❌ Você não tem **${found.product.name}** no inventário.`);

  inv[key] = have - 1;
  let efeito = "";
  const u = found.product.utility;
  switch (u.type) {
    case "weapon": {
      if (p.weapon) {
        return reply(msg, `❌ Você já tem **${p.weapon}** equipada. Venda primeiro com \`!arma vender\` para equipar a nova.`);
      }
      await updatePlayer(p.discordId, { inventory: inv, weapon: u.weaponKey });
      efeito = `🔫 Equipou **${u.weaponKey}**.`;
      break;
    }
    case "heal": {
      const novo = Math.min(p.maxHealth, p.health + u.amount);
      await updatePlayer(p.discordId, { inventory: inv, health: novo });
      efeito = `❤️ +${u.amount} saúde (agora ${novo}/${p.maxHealth}).`;
      break;
    }
    case "energy": {
      const novo = Math.min(100, p.energy + u.amount);
      await updatePlayer(p.discordId, { inventory: inv, energy: novo });
      efeito = `⚡ +${u.amount} energia (agora ${novo}/100).`;
      break;
    }
    case "xp": {
      await updatePlayer(p.discordId, { inventory: inv });
      try { await addXp(p.discordId, u.amount); } catch {}
      efeito = `✨ +${u.amount} XP.`;
      break;
    }
    case "rep": {
      await updatePlayer(p.discordId, { inventory: inv, reputation: p.reputation + u.amount });
      efeito = `⭐ +${u.amount} reputação (agora ${p.reputation + u.amount}).`;
      break;
    }
  }
  return reply(msg, `${found.product.emoji} Usou **${found.product.name}** — ${efeito}\nRestam ${inv[key]} no inventário.`);
});

reg(["ajuda", "help", "comandos"], async (msg) => {
  const e1 = new EmbedBuilder().setTitle("📖 Comandos — Prefixo `!`").setColor(0x5865f2)
    .setDescription("Todos os comandos usam **!** no início. Não tem mais slash.")
    .addFields(
      { name: "💰 Economia", value: "`!saldo` `!banco` `!dep <v>` `!sac <v>` `!pix @user <v>` `!work` `!sal`" },
      { name: "🎁 Recompensas", value: "`!day` `!week` `!bonus`" },
      { name: "🛒 Loja", value: "`!loja` `!comprar <item> [qtd]` `!inv`" },
      { name: "🪪 Personagem", value: "`!perfil <UF> <cidade> <gen> <pol>` `!rg [@user]`" },
      { name: "👔 Profissão", value: "`!profs` · `!curso <nome>` · `!sal`" },
      { name: "❤️ Saúde", value: "`!saude` `!hospital` `!seguro` `!curar @user` `!defender @user`" },
      { name: "🦹 Crime", value: "`!crime <tipo>` `!roubar @user` `!ficha` `!prender @user [min]` `!fugir`" },
      { name: "🌾 Fazenda Vegetal", value: "`!plantar <semente>` `!plant` `!colher`" },
      { name: "🐄 Fazenda Animal", value: "`!fazenda` `!animal <esp> [nome]` `!alimentar <id>` `!abater <id>`" },
      { name: "🪴 Slots da Fazenda", value: "`!comprarslot planta` · `!comprarslot animal`" },
    );
  const e2 = new EmbedBuilder().setColor(0x5865f2).addFields(
      { name: "🎰 Cassino", value: "`!slot <v>` `!roleta <cor> <v>` `!dado <esc> <v> [n]` `!bicho <1-25> <v>`" },
      { name: "🔫 Combate", value: "`!arma loja|vender|equipada` `!compraarma <k>` `!duelo @user`" },
      { name: "🏴 Gangue", value: "`!gcriar <nome> <tag>` `!ginvitar @user` `!gaceitar` `!grejeitar` `!gconvites` `!gbanir @user` `!gmembros` `!gsair` `!ginfo` `!glista`" },
      { name: "🗺️ Território", value: "`!terr` `!invadir <id>`" },
      { name: "🚗 Carros", value: "`!autos` `!comprarauto <m>` `!garagem` `!consertar <id>` `!vendercarro <id>`" },
      { name: "🏠 Casa", value: "`!casa` `!casacomprar <tipo>` `!casaupgrade <up>` `!coletar`" },
      { name: "🐾 Pet/Família", value: "`!pet <esp> <nome>` `!pets` `!petfeed` `!petsep` `!casar @user` `!divorciar`" },
      { name: "📊 Bolsa", value: "`!bolsa` `!bcomprar <SYM> <q>` `!bvender <SYM> <q>` `!carteira`" },
      { name: "🛠️ Admin/Outros", value: "`!adm dar|tirar|reset @user [v]` `!top` `!ajuda`" },
    );
  const e3 = new EmbedBuilder().setColor(0x5865f2).setTitle("📖 Comandos — Parte 3").addFields(
      { name: "📜 Dívidas/Crédito", value: "`!fiado @user <v> [dias]` `!dividas` `!pagar <id>`" },
      { name: "⚖️ Falência", value: "`!falir` `!status` `!checkfalencia`" },
      { name: "⭐ Reputação/Karma", value: "`!rep [@user]`" },
      { name: "🤔 Escolhas Morais", value: "`!moral`" },
      { name: "🧾 Imposto", value: "`!ir` · `!sonegar`" },
      { name: "🕶️ Mercado Negro", value: "`!mn` `!mncomprar <chave>`" },
      { name: "🎰 Loteria", value: "`!loteria` `!bilhete <1-100>`" },
      { name: "📊 Eventos Econômicos", value: "`!evento` · admin: `!evento inflacao|recessao|boom|deflacao`" },
    );
  const e4 = new EmbedBuilder().setColor(0xff6600).setTitle("📖 Comandos — Novos Sistemas").addFields(
      { name: "🎛️ Painel Geral", value: "`!dash`" },
      { name: "📈 Bolsa Detalhada", value: "`!cotacoes` · `!bdetalhe <SYM>`" },
      { name: "🏛️ Política", value: "`!governo` `!leis` · admin: `!eleicao <presidente|prefeito>` · `!candidatar` `!votar @user` `!apurar` · `!proporlei <efeito> <nome>` · `!comprarvoto @user <v>`" },
      { name: "🏁 Racha de Carros", value: "`!racha <valor> @user`" },
      { name: "💍 Casamento", value: "`!casar @user`" },
      { name: "🏴 Convite de Gangue", value: "`!ginvitar @user`" },
      { name: "💼 Empresa", value: "`!empresa` `!ecriar \"<nome>\" <ramo> [desc]` `!econtratar @user` `!edemitir @user` `!epagar` `!eanunciar` `!eexpandir` `!eipo <SYM> <preço>` `!esimular` `!elista` `!eextrato`" },
      { name: "🏭 Cadeia Produtiva", value: "`!ramos [ramo]` · `!ematerias <mat> [qtd]` · `!emateriais` · `!econstruir` · `!efabrica` · `!eupgradefabrica` · `!efabricar <prodKey> [qtd]` · `!estoque [@dono]`" },
      { name: "📦 Produtos da Empresa", value: "`!eproduto add fab <prodKey> <preço>` · `!eproduto add \"<nome>\" <preço> <custo>` · `!eproduto rm <id>` · `!eproduto lista [@dono]` · `!ecomprar @dono <id> [qtd]` · `!usar <prodKey>`" },
      { name: "🛠️ Funcionário", value: "`!etrabalhar` (1h cd, ativa comissão por 24h)" },
      { name: "⚖️ Impeachment", value: "`!impeachment <presidente|prefeito>` (30 apoiadores ✅ em 3min, confisca orçamento)" },
      { name: "🧼 Lavagem", value: "`!lavar <valor>`" },
      { name: "✨ Nível & Animações", value: "`!work` · plantar/colher/animal/racha" },
    );
  return msg.reply({ embeds: [e1, e2, e3, e4] }).catch(() => {});
});

// ============ DISPATCHER ============
export async function handleMessage(msg: Message) {
  if (msg.author.bot || !msg.content.startsWith(PREFIX)) return;

  const raw = msg.content.slice(PREFIX.length).trim();
  if (!raw) return;

  // Parse args supporting "quoted strings"
  const tokens: string[] = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m;
  while ((m = re.exec(raw)) !== null) tokens.push(m[1] ?? m[2]!);

  const name = tokens[0]!.toLowerCase();
  const args = tokens.slice(1);
  const handler = commands.get(name);
  if (!handler) return;

  try {
    await handler(msg, args);
  } catch (err) {
    logger.error({ err, command: name }, "Command error");
    msg.reply(`❌ Erro ao executar \`!${name}\`.`).catch(() => {});
  }
}

export function listCommandNames(): string[] {
  return Array.from(commands.keys()).sort();
}
