import type { Client, Message, TextChannel } from "discord.js";
import { EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, ComponentType } from "discord.js";
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
import {
  DROGAS, LAB_BUILD_COST, LAB_UPGRADE_BASE, MAX_LAB_LEVEL,
  GOLPES, PIRAMIDE_MIN_ENTRADA, PIRAMIDE_TAXA_DONO, PIRAMIDE_DURACAO_MS, PIRAMIDE_PAGA_DEPOIS_DE,
  SUBORNO_ALVOS,
  DIRT_FACTS, FOFOCA_COST, FOFOCA_SUCCESS, FOFOCA_COOLDOWN_MS, SIGILO_COST_PER_DIRT,
  SEQUESTRO_DURACAO_MS, SEQUESTRO_RANSOM_MIN, SEQUESTRO_RANSOM_MAX, SEQUESTRO_TAXA_FUGA, SEQUESTRO_DANO_FUGA,
  MERCADO_TAXA, MERCADO_MAX_OFERTAS,
  type MarketOffer, type DirtItem, type MissionDef,
  pickDailyMissions, todayKey,
  calcInfamia, infamiaTitulo,
  bumpInf, bumpMissionProgress,
} from "./systems/salafrario.js";
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

// Resolve alvo de comandos de visualização: se houver @menção, retorna esse jogador;
// senão retorna o autor. Usado nos comandos read-only (!saldo, !inv, !ficha, etc).
async function _target(msg: Message, args: string[]) {
  const tid = getMentionId(msg, args, 0);
  if (tid && tid !== msg.author.id) {
    const u = msg.mentions.users.first();
    const name = u?.username ?? "user";
    const p = await getOrCreatePlayer(tid, name);
    return { p, name: p.username ?? name, isOther: true, id: tid };
  }
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  return { p, name: msg.author.username, isOther: false, id: msg.author.id };
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
reg(["saldo", "bal"], async (msg, args) => {
  const { p, name } = await _target(msg, args);
  const eco = await getEconomy();
  const e = new EmbedBuilder().setTitle(`💰 Carteira — ${name}`).setColor(0x00ff88).addFields(
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

reg(["banco"], async (msg, args) => {
  const { p, name } = await _target(msg, args);
  const eco = await getEconomy();
  const e = new EmbedBuilder().setTitle(`🏦 Banco — ${name}`).setColor(0x0099ff).addFields(
    { name: "💵 Em mãos", value: formatMoney(p.balance), inline: true },
    { name: "🏦 Banco", value: formatMoney(p.bankBalance), inline: true },
    { name: "💸 Taxa de saque", value: `${(eco.bankTaxRate * 100).toFixed(1)}%`, inline: true },
  ).setFooter({ text: "Use !dep <valor> ou !sac <valor>" });
  return reply(msg, { embeds: [e] });
});

reg(["pix", "transferir"], async (msg, args) => {
  const targetId = getMentionId(msg, args, 0);
  if (!targetId) return reply(msg, "❌ Uso: `!pix @user <valor>`");
  // Pega o primeiro argumento que não seja menção/ID — assim funciona com `!pix @user 100`,
  // `!pix 100 @user`, ou `!pix <discordId> 100`.
  let v: number | null = null;
  for (const a of args) {
    if (!a) continue;
    if (/^<@!?\d+>$/.test(a)) continue;       // menção bruta <@123>
    if (/^\d{15,22}$/.test(a)) continue;      // discord snowflake
    const n = parseInt(a.replace(/[^\d]/g, ""), 10);
    if (Number.isFinite(n) && n > 0) { v = n; break; }
  }
  if (!v || v <= 0) return reply(msg, "❌ Uso: `!pix @user <valor>` — valor deve ser positivo.");
  if (targetId === msg.author.id) return reply(msg, "❌ Não pode transferir para si.");
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  if (p.balance < v) return reply(msg, `❌ Saldo insuficiente. Você tem ${formatMoney(p.balance)} e tentou enviar ${formatMoney(v)}.`);
  const eco = await getEconomy();
  const tax = Math.floor(v * eco.taxRate);
  const net = v - tax;
  const targetUser = msg.mentions.users.first();
  const target = await getOrCreatePlayer(targetId, targetUser?.username ?? "user");
  await updatePlayer(p.discordId, { balance: p.balance - v });
  await updatePlayer(target.discordId, { balance: target.balance + net });
  await logTransaction(p.discordId, target.discordId, net, "transfer", `PIX (imposto ${formatMoney(tax)})`);
  return reply(msg, `✅ PIX de ${formatMoney(v)} enviado para <@${target.discordId}> · líquido recebido ${formatMoney(net)} (imposto ${formatMoney(tax)}).\n💼 Seu novo saldo: ${formatMoney(p.balance - v)}.`);
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

reg(["inv", "mochila", "inventario"], async (msg, args) => {
  const { p, name } = await _target(msg, args);
  const inv = p.inventory ?? {};
  const entries = Object.entries(inv).filter(([k, q]) => (q as number) > 0 && !k.startsWith("_"));
  const e = new EmbedBuilder().setTitle(`🎒 Mochila — ${name}`).setColor(0x885500);
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

reg(["ficha"], async (msg, args) => {
  const { p, name } = await _target(msg, args);
  const e = new EmbedBuilder().setTitle(`🦹 Ficha — ${name}`).setColor(0xff5555).addFields(
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

reg(["plant", "plantacao"], async (msg, args) => {
  const { p, name, isOther } = await _target(msg, args);
  const plots = await db.query.plots.findMany({ where: and(eq(schema.plots.ownerId, p.discordId), eq(schema.plots.harvested, false)) });
  if (plots.length === 0) return reply(msg, isOther ? `🌾 ${name} não tem plantações ativas.` : "🌾 Nenhuma plantação ativa.");
  const e = new EmbedBuilder().setTitle(`🌾 Plantações — ${name}`).setColor(0x88cc44);
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

reg(["ginfo"], async (msg, args) => {
  const { p, name, isOther } = await _target(msg, args);
  if (!p.gangId) return reply(msg, isOther ? `❌ ${name} não está em nenhuma gangue.` : "❌ Sem gangue.");
  const g = await db.query.gangs.findFirst({ where: eq(schema.gangs.id, p.gangId) });
  if (!g) return reply(msg, "❌ Gangue não encontrada.");
  let warStatus = "🕊️ Não";
  if (g.isAtWar && g.warTarget) {
    const inimigo = await db.query.gangs.findFirst({ where: eq(schema.gangs.id, g.warTarget) });
    const dur = g.warStarted ? Math.floor((Date.now() - g.warStarted.getTime()) / (60 * 60 * 1000)) : 0;
    warStatus = inimigo ? `⚔️ contra **${inimigo.name}** [${inimigo.tag}] · ${dur}h` : "⚔️ (inimigo não encontrado)";
  }
  const e = new EmbedBuilder().setTitle(`🏴 ${g.name} [${g.tag}]`).setColor(0x222222).addFields(
    { name: "Líder", value: `<@${g.leaderId}>`, inline: true },
    { name: "Membros", value: `${g.memberCount}`, inline: true },
    { name: "Caixa", value: formatMoney(g.bankBalance), inline: true },
    { name: "Reputação", value: `${g.reputation}`, inline: true },
    { name: "Em guerra", value: warStatus, inline: false },
  );
  return reply(msg, { embeds: [e] });
});

reg(["glista"], async (msg) => {
  const all = await db.query.gangs.findMany({ limit: 15 });
  if (all.length === 0) return reply(msg, "Nenhuma gangue.");
  return reply(msg, all.map(g => `🏴 [${g.tag}] ${g.name} — ${g.memberCount} membros`).join("\n"));
});

// ============ ECONOMIA DA GANGUE ============

const GANG_TREASURY_CUT = 0.30;     // 30% do gtrabalhar pra tesouraria
const GANG_WORK_COOLDOWN_MS = 60 * 60 * 1000;
const TERR_INVADE_COST = 5000;
const TERR_INCOME_CAP_HOURS = 24;   // teto de acúmulo (evita exploit)

reg(["gbanco", "gtesouraria"], async (msg) => {
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  if (!p.gangId) return reply(msg, "❌ Você não está em nenhuma gangue.");
  const g = await db.query.gangs.findFirst({ where: eq(schema.gangs.id, p.gangId) });
  if (!g) return reply(msg, "❌ Gangue não encontrada.");
  const territs = await db.query.territories.findMany({ where: eq(schema.territories.controlledBy, g.id) });
  const rendaHora = territs.reduce((s, t) => s + t.passiveIncome, 0);
  const e = new EmbedBuilder().setTitle(`🏦 Tesouraria — ${g.name} [${g.tag}]`).setColor(0x224422)
    .addFields(
      { name: "💰 Caixa da gangue", value: formatMoney(g.bankBalance), inline: true },
      { name: "🗺️ Territórios", value: `${territs.length}`, inline: true },
      { name: "📈 Renda passiva", value: `${formatMoney(rendaHora)}/h`, inline: true },
      { name: "👥 Membros", value: `${g.memberCount}`, inline: true },
      { name: "Como entra dinheiro?", value: "• `!gdepositar <v>` (qualquer membro)\n• `!gtrabalhar` (30% vai pro caixa, 70% pro membro)\n• `!terrcoletar` (renda acumulada dos territórios)" },
      { name: "Como sai?", value: "• `!gpagar @membro <v>` (só líder)" },
    );
  return reply(msg, { embeds: [e] });
});

reg(["gdepositar", "gdoar"], async (msg, args) => {
  const v = intArg(args, 0);
  if (!v) return reply(msg, "❌ Uso: `!gdepositar <valor>`");
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  if (!p.gangId) return reply(msg, "❌ Sem gangue.");
  if (p.balance < v) return reply(msg, `❌ Saldo insuficiente. Tem ${formatMoney(p.balance)}.`);
  const g = await db.query.gangs.findFirst({ where: eq(schema.gangs.id, p.gangId) });
  if (!g) return reply(msg, "❌ Gangue não existe.");
  await removeMoney(p.discordId, v);
  await db.update(schema.gangs).set({ bankBalance: g.bankBalance + v }).where(eq(schema.gangs.id, g.id));
  return reply(msg, `🏦 ${formatMoney(v)} doados para a tesouraria de **${g.name}**. Caixa agora: ${formatMoney(g.bankBalance + v)}.`);
});

reg(["gpagar", "gpag"], async (msg, args) => {
  const tid = getMentionId(msg, args, 0);
  const v = intArg(args, msg.mentions.users.size > 0 ? 1 : 1);
  if (!tid || !v) return reply(msg, "❌ Uso: `!gpagar @membro <valor>` (só o líder, sai do caixa da gangue).");
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  if (!p.gangId || p.gangRank !== "lider") return reply(msg, "❌ Só o líder paga.");
  const t = await getPlayer(tid);
  if (!t || t.gangId !== p.gangId) return reply(msg, "❌ Alvo não é da sua gangue.");
  const g = await db.query.gangs.findFirst({ where: eq(schema.gangs.id, p.gangId) });
  if (!g) return reply(msg, "❌ Gangue não encontrada.");
  if (g.bankBalance < v) return reply(msg, `❌ Caixa só tem ${formatMoney(g.bankBalance)}.`);
  await db.update(schema.gangs).set({ bankBalance: g.bankBalance - v }).where(eq(schema.gangs.id, g.id));
  await addMoney(t.discordId, v);
  await logTransaction(g.id, t.discordId, v, "gang_pay", `Pagamento da gangue ${g.name}`);
  return reply(msg, `💸 Líder pagou ${formatMoney(v)} para <@${t.discordId}>. Caixa restante: ${formatMoney(g.bankBalance - v)}.`);
});

// ===== GUERRA DE FACÇÕES =====

const GANG_WAR_DECLARE_COST = 10000;
const GANG_WAR_PEACE_COST = 5000;

reg(["gguerra", "declararguerra"], async (msg, args) => {
  const tid = getMentionId(msg, args, 0);
  const tagArg = (args[0] ?? "").replace(/^\[|\]$/g, "");
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  if (!p.gangId || p.gangRank !== "lider") return reply(msg, "❌ Só o líder declara guerra.");
  const meu = await db.query.gangs.findFirst({ where: eq(schema.gangs.id, p.gangId) });
  if (!meu) return reply(msg, "❌ Gangue não encontrada.");
  if (meu.isAtWar) return reply(msg, `⚔️ Sua gangue já está em guerra. Encerre com \`!gpaz\` antes de abrir outra frente.`);

  let alvo: typeof meu | undefined;
  if (tid) {
    const t = await getPlayer(tid);
    if (!t || !t.gangId) return reply(msg, "❌ Esse usuário não pertence a nenhuma gangue.");
    alvo = await db.query.gangs.findFirst({ where: eq(schema.gangs.id, t.gangId) });
  } else if (tagArg && !/^\d+$/.test(tagArg)) {
    alvo = await db.query.gangs.findFirst({ where: sql`lower(${schema.gangs.tag}) = lower(${tagArg})` });
  }
  if (!alvo) return reply(msg, "❌ Uso: `!gguerra <tag-da-gangue>` ou `!gguerra @membro-inimigo`");
  if (alvo.id === meu.id) return reply(msg, "❌ Não dá pra declarar guerra à própria facção.");
  if (alvo.isAtWar) return reply(msg, `⚔️ **${alvo.name}** já está envolvida em outra guerra.`);
  if (meu.bankBalance < GANG_WAR_DECLARE_COST) return reply(msg, `❌ Declarar guerra custa ${formatMoney(GANG_WAR_DECLARE_COST)} do caixa da gangue (você tem ${formatMoney(meu.bankBalance)}).`);

  const now = new Date();
  await db.update(schema.gangs).set({
    bankBalance: meu.bankBalance - GANG_WAR_DECLARE_COST,
    isAtWar: true, warTarget: alvo.id, warStarted: now,
  }).where(eq(schema.gangs.id, meu.id));
  await db.update(schema.gangs).set({
    isAtWar: true, warTarget: meu.id, warStarted: now,
  }).where(eq(schema.gangs.id, alvo.id));
  await logTransaction(meu.id, "VOID", GANG_WAR_DECLARE_COST, "war_declare", `Guerra contra ${alvo.name}`);

  const e = new EmbedBuilder().setTitle("⚔️ GUERRA DECLARADA").setColor(0xaa0000)
    .setDescription(`**${meu.name}** [${meu.tag}] declarou guerra contra **${alvo.name}** [${alvo.tag}].`)
    .addFields(
      { name: "Custo", value: formatMoney(GANG_WAR_DECLARE_COST) + " (caixa)", inline: true },
      { name: "Bônus em guerra", value: "• Invadir territórios do inimigo: **custo pela metade**\n• Vitória em invasão: **+10 reputação** (em vez de +5)" },
      { name: "Como encerrar", value: "`!gpaz` (paga indenização ao inimigo)" },
    );
  return reply(msg, { embeds: [e] });
});

reg(["gpaz", "pedirpaz"], async (msg) => {
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  if (!p.gangId || p.gangRank !== "lider") return reply(msg, "❌ Só o líder pede paz.");
  const meu = await db.query.gangs.findFirst({ where: eq(schema.gangs.id, p.gangId) });
  if (!meu || !meu.isAtWar || !meu.warTarget) return reply(msg, "🕊️ Sua gangue não está em guerra.");
  const inimigo = await db.query.gangs.findFirst({ where: eq(schema.gangs.id, meu.warTarget) });
  if (!inimigo) {
    await db.update(schema.gangs).set({ isAtWar: false, warTarget: null, warStarted: null }).where(eq(schema.gangs.id, meu.id));
    return reply(msg, "✅ Estado de guerra órfão limpo (a gangue inimiga não existe mais).");
  }
  if (meu.bankBalance < GANG_WAR_PEACE_COST) return reply(msg, `❌ Indenização de paz custa ${formatMoney(GANG_WAR_PEACE_COST)} do caixa (você tem ${formatMoney(meu.bankBalance)}).`);
  await db.update(schema.gangs).set({
    bankBalance: meu.bankBalance - GANG_WAR_PEACE_COST,
    isAtWar: false, warTarget: null, warStarted: null,
  }).where(eq(schema.gangs.id, meu.id));
  await db.update(schema.gangs).set({
    bankBalance: inimigo.bankBalance + GANG_WAR_PEACE_COST,
    isAtWar: false, warTarget: null, warStarted: null,
  }).where(eq(schema.gangs.id, inimigo.id));
  await logTransaction(meu.id, inimigo.id, GANG_WAR_PEACE_COST, "war_peace", `Paz com ${inimigo.name}`);
  return reply(msg, `🕊️ Paz com **${inimigo.name}** [${inimigo.tag}]. ${formatMoney(GANG_WAR_PEACE_COST)} pagos como indenização.`);
});

reg(["gguerras", "guerras"], async (msg) => {
  const all = await db.query.gangs.findMany();
  const gMap: Record<string, typeof all[number]> = {};
  for (const g of all) gMap[g.id] = g;
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const g of all) {
    if (!g.isAtWar || !g.warTarget) continue;
    if (seen.has(g.id)) continue;
    seen.add(g.id);
    seen.add(g.warTarget);
    const inimigo = gMap[g.warTarget];
    const dur = g.warStarted ? Math.floor((Date.now() - g.warStarted.getTime()) / (60 * 60 * 1000)) : 0;
    lines.push(`⚔️ **${g.name}** [${g.tag}] vs **${inimigo?.name ?? "?"}** [${inimigo?.tag ?? "?"}] — ${dur}h em conflito`);
  }
  if (lines.length === 0) return reply(msg, "🕊️ Nenhuma guerra ativa no momento.");
  return reply(msg, { embeds: [new EmbedBuilder().setTitle("⚔️ Guerras de Facção Ativas").setColor(0xaa0000).setDescription(lines.join("\n"))] });
});

reg(["gtrabalhar", "gwork"], async (msg) => {
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  if (!p.gangId) return reply(msg, "❌ Precisa estar em gangue. Veja `!glista` ou `!gcriar`.");
  if (isJailed(p) || isHospitalized(p) || isDead(p)) return reply(msg, "❌ Você não pode trabalhar agora.");
  const inv: any = { ...(p.inventory ?? {}) };
  const last = (inv._last_gwork as number) ?? 0;
  const cd = GANG_WORK_COOLDOWN_MS - (Date.now() - last);
  if (cd > 0) return reply(msg, `⏳ Próximo serviço da gangue em ${formatCooldown(cd)}.`);
  const g = await db.query.gangs.findFirst({ where: eq(schema.gangs.id, p.gangId) });
  if (!g) return reply(msg, "❌ Gangue não encontrada.");
  const territs = await db.query.territories.findMany({ where: eq(schema.territories.controlledBy, g.id) });

  const lvl = getPlayerLevel(p);
  const base = 250 + Math.floor(Math.random() * 350);
  const bonusTerr = territs.length * 180;
  const bonusLvl = lvl * 60;
  const bonusRep = Math.max(0, Math.floor(g.reputation * 0.5));
  const total = base + bonusTerr + bonusLvl + bonusRep;
  const cutGang = Math.floor(total * GANG_TREASURY_CUT);
  const paraMembro = total - cutGang;

  await db.update(schema.gangs).set({ bankBalance: g.bankBalance + cutGang, reputation: g.reputation + 1 }).where(eq(schema.gangs.id, g.id));
  inv._last_gwork = Date.now();
  await updatePlayer(p.discordId, { balance: p.balance + paraMembro, inventory: inv });
  await logTransaction(g.id, p.discordId, paraMembro, "gang_work", `Serviço da gangue ${g.name}`);
  await addXp(p.discordId, 12);

  const tarefas = [
    "vigiou o ponto da boca",
    "cobrou pedágio na esquina",
    "fez entrega pra um cliente VIP",
    "intimidou um devedor",
    "patrulhou o território",
    "armou bloqueio na pista",
    "deu cobertura num corre",
  ];
  const tarefa = tarefas[Math.floor(Math.random() * tarefas.length)];
  return reply(msg, `🤝 Você ${tarefa} para **${g.name}** e ganhou ${formatMoney(paraMembro)}. Caixa da gangue +${formatMoney(cutGang)} (territórios: ${territs.length}, nível: ${lvl}).`);
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

reg(["garagem"], async (msg, args) => {
  const { p, name, isOther } = await _target(msg, args);
  const list = await db.query.cars.findMany({ where: eq(schema.cars.ownerId, p.discordId) });
  if (list.length === 0) return reply(msg, isOther ? `🚗 ${name} não tem carros.` : "🚗 Garagem vazia. Veja `!autos`.");
  const e = new EmbedBuilder().setTitle(`🅿️ Garagem — ${name}`).setColor(0x666666);
  for (const c of list) {
    const daysSince = (Date.now() - c.lastMaintenance.getTime()) / DAY_MS;
    const cond = Math.max(0, c.condition - Math.floor(daysSince * 5));
    const ctrls = isOther ? "" : `\n\`!consertar ${c.id}\` · \`!vendercarro ${c.id}\``;
    e.addFields({ name: `#${c.id} ${c.model}`, value: `Estado ${cond}% · Valor ${formatMoney(depreciate(c.currentValue, c.basePrice, cond))}${ctrls}`, inline: false });
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
reg(["casa"], async (msg, args) => {
  const { p, name, isOther } = await _target(msg, args);
  const h = await db.query.houses.findFirst({ where: eq(schema.houses.ownerId, p.discordId) });
  if (!h) {
    if (isOther) return reply(msg, `🏠 ${name} ainda não tem imóvel.`);
    const e = new EmbedBuilder().setTitle("🏠 Imobiliária").setColor(0x884422).setDescription("Você ainda não tem imóvel. Tipos disponíveis:");
    for (const t of Object.values(HOUSE_TYPES)) {
      e.addFields({ name: `${t.emoji} ${t.name}`, value: `${formatMoney(t.basePrice)} · Renda ${formatMoney(t.passiveIncome)}/h\n\`!casacomprar ${t.key}\``, inline: true });
    }
    return reply(msg, { embeds: [e] });
  }
  const t = HOUSE_TYPES[h.type] ?? HOUSE_TYPES["barraco"]!;
  const ups = Object.entries(h.upgrades ?? {}).map(([k]) => HOUSE_UPGRADES[k]?.emoji ?? "").join(" ");
  const fields: { name: string; value: string; inline: boolean }[] = [
    { name: "Dono", value: `<@${p.discordId}>`, inline: true },
    { name: "Valor", value: formatMoney(h.baseValue), inline: true },
    { name: "Upgrades", value: ups || "Nenhum", inline: true },
  ];
  if (!isOther) fields.push({ name: "Coletar renda", value: "`!coletar`", inline: true });
  const e = new EmbedBuilder().setTitle(`${t.emoji} ${t.name} (Nível ${h.level})`).setColor(0x884422).addFields(...fields);
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
reg(["fazenda"], async (msg, args) => {
  const { p, name, isOther } = await _target(msg, args);
  const list = await db.query.farmAnimals.findMany({ where: and(eq(schema.farmAnimals.ownerId, p.discordId), eq(schema.farmAnimals.alive, true)) });
  const e = new EmbedBuilder().setTitle(`🚜 Fazenda — ${name}`).setColor(0x88aa44);
  if (list.length === 0) e.setDescription(isOther ? `${name} não tem animais vivos.` : "Vazia. Compre animais com `!animal <espécie> [nome]`.");
  else for (const a of list) {
    const sp = ANIMAL_SPECIES[a.species]!;
    const hoursSince = (Date.now() - a.lastFed.getTime()) / (60 * 60 * 1000);
    const hunger = Math.max(0, a.hunger - Math.floor(hoursSince * HUNGER_DECAY_PER_HOUR));
    const ready = a.readyAt && Date.now() >= a.readyAt.getTime();
    const ctrls = isOther ? "" : `\n\`!alimentar ${a.id}\` · \`!abater ${a.id}\``;
    e.addFields({ name: `#${a.id} ${sp.emoji} ${a.name ?? sp.name}`, value: `Fome ${hunger}/100${ready ? " · ✅ pronto" : ""}${ctrls}`, inline: false });
  }
  if (!isOther) e.addFields({ name: "Espécies", value: Object.values(ANIMAL_SPECIES).map(s => `${s.emoji} ${s.key} ${formatMoney(s.buyPrice)}`).join("\n"), inline: false });
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

reg(["pets"], async (msg, args) => {
  const { name, isOther, id } = await _target(msg, args);
  const list = await db.query.pets.findMany({ where: eq(schema.pets.ownerId, id) });
  if (list.length === 0) return reply(msg, isOther ? `🐾 ${name} não tem pets.` : "🐾 Sem pets.");
  return reply(msg, `🐾 **Pets de ${name}**\n` + list.map(p => {
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

function _accruedTerr(t: { passiveIncome: number; lastCollected: Date | null }): { hours: number; total: number } {
  const since = t.lastCollected ? t.lastCollected.getTime() : Date.now() - 60 * 60 * 1000;
  const hoursRaw = (Date.now() - since) / (60 * 60 * 1000);
  const hours = Math.min(TERR_INCOME_CAP_HOURS, Math.max(0, hoursRaw));
  return { hours, total: Math.floor(hours * t.passiveIncome) };
}

reg(["terr", "territorios", "mapa"], async (msg) => {
  const ts = await db.query.territories.findMany();
  if (ts.length === 0) return reply(msg, "🗺️ Nenhum território cadastrado ainda.");
  const gangsAll = await db.query.gangs.findMany();
  const gMap: Record<string, typeof gangsAll[number]> = {};
  for (const g of gangsAll) gMap[g.id] = g;
  const lines = ts.map(t => {
    const ctrl = t.controlledBy ? gMap[t.controlledBy] : null;
    const ac = _accruedTerr(t);
    const status = ctrl ? `🏴 [${ctrl.tag}] ${ctrl.name}` : "⚪ livre";
    return `\`#${t.id}\` **${t.name}** — ${status}\n   📈 ${formatMoney(t.passiveIncome)}/h · 💰 acumulado ${formatMoney(ac.total)} (${ac.hours.toFixed(1)}h, teto ${TERR_INCOME_CAP_HOURS}h)`;
  });
  const e = new EmbedBuilder().setTitle("🗺️ Mapa de Territórios").setColor(0x336633)
    .setDescription(lines.join("\n\n"))
    .setFooter({ text: `Coletar acumulado: !terrcoletar · Invadir: !invadir <id> (custa ${formatMoney(TERR_INVADE_COST)})` });
  return reply(msg, { embeds: [e] });
});

reg(["terrcoletar", "coletarterr", "tcoletar"], async (msg) => {
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  if (!p.gangId) return reply(msg, "❌ Precisa estar em gangue.");
  const ts = await db.query.territories.findMany({ where: eq(schema.territories.controlledBy, p.gangId) });
  if (ts.length === 0) return reply(msg, "🗺️ Sua gangue não controla nenhum território. Use `!terr` e `!invadir <id>`.");
  let total = 0;
  for (const t of ts) {
    const ac = _accruedTerr(t);
    total += ac.total;
    await db.update(schema.territories).set({ lastCollected: new Date() }).where(eq(schema.territories.id, t.id));
  }
  if (total <= 0) return reply(msg, "💤 Nenhuma renda acumulada ainda. Espere mais um pouco.");
  const g = await db.query.gangs.findFirst({ where: eq(schema.gangs.id, p.gangId) });
  if (!g) return reply(msg, "❌ Gangue sumiu.");
  await db.update(schema.gangs).set({ bankBalance: g.bankBalance + total }).where(eq(schema.gangs.id, g.id));
  await logTransaction(null, g.id, total, "territory_collect", `Coleta de ${ts.length} território(s)`);
  return reply(msg, `💰 Coletado ${formatMoney(total)} de ${ts.length} território(s) para o caixa de **${g.name}**. Use \`!gbanco\`.`);
});

reg(["invadir", "tomarterr"], async (msg, args) => {
  const id = intArg(args, 0);
  if (!id) return reply(msg, "❌ Uso: `!invadir <id>` — veja `!terr`.");
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  if (!p.gangId) return reply(msg, "❌ Precisa estar em gangue.");
  const t = await db.query.territories.findFirst({ where: eq(schema.territories.id, id) });
  if (!t) return reply(msg, "❌ Território não existe.");
  if (t.controlledBy === p.gangId) return reply(msg, "✋ Sua gangue já controla esse território.");

  const meuG = await db.query.gangs.findFirst({ where: eq(schema.gangs.id, p.gangId) });
  if (!meuG) return reply(msg, "❌ Gangue sumiu.");

  // Bônus de guerra: invadindo território da gangue inimiga, custo cai pela metade.
  const emGuerraComDono = !!(meuG.isAtWar && meuG.warTarget && t.controlledBy && meuG.warTarget === t.controlledBy);
  const custo = emGuerraComDono ? Math.floor(TERR_INVADE_COST / 2) : TERR_INVADE_COST;
  if (p.balance < custo) return reply(msg, `❌ Invadir custa ${formatMoney(custo)} (logística/armas).${emGuerraComDono ? " Bônus de guerra aplicado." : ""}`);
  await removeMoney(p.discordId, custo);

  // Força = membros + reputação/10 (atacante) vs defensor (mesma fórmula × defenseBonus)
  const meuPoder = meuG.memberCount + meuG.reputation / 10;
  let defPoder = 5; // território livre tem leve resistência local
  let defNome = "garrison local";
  let inimigoG: typeof meuG | undefined;
  if (t.controlledBy) {
    inimigoG = await db.query.gangs.findFirst({ where: eq(schema.gangs.id, t.controlledBy) });
    if (inimigoG) {
      defPoder = (inimigoG.memberCount + inimigoG.reputation / 10) * t.defenseBonus;
      defNome = `[${inimigoG.tag}] ${inimigoG.name}`;
    }
  }
  const chance = Math.max(0.15, Math.min(0.85, meuPoder / (meuPoder + defPoder)));
  const sucesso = Math.random() < chance;

  if (!sucesso) {
    if (inimigoG) {
      const pillage = Math.floor(custo / 2);
      await db.update(schema.gangs).set({ bankBalance: inimigoG.bankBalance + pillage }).where(eq(schema.gangs.id, inimigoG.id));
    }
    await updatePlayer(p.discordId, { health: Math.max(1, p.health - 20) });
    return reply(msg, `❌ Invasão de **${t.name}** fracassou contra ${defNome} (chance ${(chance * 100).toFixed(0)}%). Perdeu ${formatMoney(custo)} e 20 HP.${emGuerraComDono ? " (custo já reduzido por guerra)" : ""}`);
  }

  await db.update(schema.territories).set({ controlledBy: p.gangId, lastCollected: new Date() }).where(eq(schema.territories.id, id));
  const repGain = emGuerraComDono ? 10 : 5;
  await db.update(schema.gangs).set({ reputation: meuG.reputation + repGain }).where(eq(schema.gangs.id, meuG.id));
  return reply(msg, `🏴 **${meuG.name}** tomou **${t.name}** de ${defNome}! +${repGain} reputação${emGuerraComDono ? " (bônus de guerra)" : ""}. Use \`!terrcoletar\` para render.`);
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

reg(["carteira"], async (msg, args) => {
  const { name, isOther, id } = await _target(msg, args);
  const hs = await db.query.stockPortfolios.findMany({ where: eq(schema.stockPortfolios.playerId, id) });
  if (hs.length === 0) return reply(msg, isOther ? `💼 ${name} não tem ações.` : "💼 Carteira vazia.");
  const lines: string[] = [];
  for (const h of hs) {
    const c = await db.query.companies.findFirst({ where: eq(schema.companies.id, h.companyId) });
    if (c) lines.push(`${c.stockSymbol ?? c.name} — ${h.shares} ações · ${formatMoney(c.sharePrice * h.shares)}`);
  }
  return reply(msg, `💼 **Carteira de ${name}**\n${lines.join("\n")}`);
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

reg(["status", "patrimonio"], async (msg, args) => {
  const { p, name, id } = await _target(msg, args);
  const ds = await listDebts(id);
  const totalDebt = ds.reduce((s, d) => s + d.remainingAmount, 0);
  const wealth = p.balance + p.bankBalance;
  const e = new EmbedBuilder().setTitle(`📊 Patrimônio · ${name}`).setColor(p.bankrupt ? 0xff0000 : 0x00ff88).addFields(
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
reg(["comprarvoto"], async (msg, args) => {
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

reg(["empresa", "minhaempresa"], async (msg, args) => {
  const { p, name, isOther } = await _target(msg, args);
  const c = await db.query.companies.findFirst({ where: eq(schema.companies.ownerId, p.discordId) });
  if (!c) {
    if (isOther) return reply(msg, `🏢 ${name} não tem empresa.`);
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

  const ch = msg.channel as TextChannel;
  const sent = await ch.send({
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
    return ch.send(`❌ Impeachment falhou: ${supporters.length}/30 apoiadores.`).catch(() => {});
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

  return ch.send({
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

reg(["eupgradefabrica", "eupfabrica"], async (msg) => {
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

// ╔══════════════════════════════════════════════════════════════════════╗
// ║         🦝  ECOSSISTEMA DO SALAFRÁRIO  — TRÁFICO · GOLPES ·          ║
// ║         SUBORNO · CHANTAGEM · SEQUESTRO · MERCADO P2P ·              ║
// ║         VÍCIOS · MISSÕES & INFÂMIA                                   ║
// ╚══════════════════════════════════════════════════════════════════════╝

// ----------- helpers compartilhados (operam só sobre players.inventory) -----------
function _inv(p: any): any { return { ...(p.inventory ?? {}) }; }
function _drogasInv(p: any): Record<string, number> { return { ...((p.inventory?._drogas as Record<string, number>) ?? {}) }; }
function _vicio(p: any): Record<string, number> { return { ...((p.inventory?._vicio as Record<string, number>) ?? {}) }; }
function _lab(p: any): { nivel: number; built: number; lastRaid?: number } | null {
  return (p.inventory?._lab_drogas as any) ?? null;
}
function _plantios(p: any): Array<{ id: number; droga: string; plantedAt: number }> {
  return [...(((p.inventory?._droga_plantios as any[]) ?? []))];
}
function _now() { return Date.now(); }

async function _checkRaid(p: any, droga: string): Promise<{ raided: boolean; lostQty: number; jail: boolean } | null> {
  const def = DROGAS[droga];
  if (!def) return null;
  if (Math.random() > def.raidChance) return { raided: false, lostQty: 0, jail: false };
  // RAID!
  const inv = _inv(p);
  const plantios = _plantios(p);
  const lost = plantios.filter(x => x.droga === droga).length;
  inv._droga_plantios = plantios.filter(x => x.droga !== droga);
  inv._lab_drogas = { ...(inv._lab_drogas ?? { nivel: 0, built: 0 }), lastRaid: _now() };
  const jail = Math.random() < 0.4;
  const wantedAdd = jail ? 2 : 1;
  await updatePlayer(p.discordId, {
    inventory: inv,
    wantedLevel: p.wantedLevel + wantedAdd,
    criminalRecord: p.criminalRecord + 1,
    ...(jail ? { isJailed: true, jailEnd: new Date(_now() + 25 * 60 * 1000) } : {}),
  });
  return { raided: true, lostQty: lost, jail };
}

// ============ TRÁFICO ============

reg(["drogas", "narco", "catalogodrogas"], async (msg) => {
  const e = new EmbedBuilder()
    .setTitle("🌿 Catálogo Subterrâneo")
    .setColor(0x335533)
    .setDescription("Plantio ilegal → laboratório → produto processado → tráfico. Sempre rola risco de batida policial.")
    .addFields(
      ...Object.values(DROGAS).map(d => ({
        name: `${d.emoji} \`${d.key}\` — ${d.name}`,
        value:
          `🌱 cresce em ${d.growMinutes} min · processada: **${d.processedName}** \`${d.processedKey}\` (${d.yieldPerRaw}× por planta)\n` +
          `🏭 lab nv ${d.labLevel} · custo de processo ${formatMoney(d.laborCost)}/planta\n` +
          `💵 preço sugerido ${formatMoney(d.basePrice)}/un · vício +${d.addiction} · risco de batida ${(d.raidChance * 100).toFixed(0)}%\n` +
          `Efeito ao consumir: ${d.effect.type === "energy" ? `⚡+${d.effect.amount} energia` : d.effect.type === "health" ? `❤️+${d.effect.amount} saúde` : `✨+${d.effect.amount} XP`}`,
      })),
    );
  return reply(msg, { embeds: [e] });
});

reg(["construir_lab", "construirlab", "lab_build"], async (msg) => {
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  if (_lab(p)) return reply(msg, "❌ Você já tem um laboratório. Veja com `!lab`.");
  if (p.balance < LAB_BUILD_COST) return reply(msg, `❌ Custa ${formatMoney(LAB_BUILD_COST)}.`);
  await removeMoney(p.discordId, LAB_BUILD_COST);
  const inv = _inv(p);
  inv._lab_drogas = { nivel: 1, built: _now() };
  await updatePlayer(p.discordId, { inventory: inv });
  return reply(msg, `🧪 Laboratório clandestino nível 1 montado por ${formatMoney(LAB_BUILD_COST)}. Já dá pra processar **maconha**.`);
});

reg(["up_lab", "uplab", "lab_up"], async (msg) => {
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const lab = _lab(p);
  if (!lab) return reply(msg, "❌ Construa o laboratório primeiro com `!construir_lab`.");
  if (lab.nivel >= MAX_LAB_LEVEL) return reply(msg, "🏆 Laboratório no nível máximo.");
  const cost = LAB_UPGRADE_BASE * (lab.nivel + 1);
  if (p.balance < cost) return reply(msg, `❌ Upgrade pra nível ${lab.nivel + 1} custa ${formatMoney(cost)}.`);
  await removeMoney(p.discordId, cost);
  const inv = _inv(p);
  inv._lab_drogas = { ...lab, nivel: lab.nivel + 1 };
  await updatePlayer(p.discordId, { inventory: inv });
  return reply(msg, `⚗️ Laboratório subiu pra nível **${lab.nivel + 1}**!`);
});

reg(["lab"], async (msg) => {
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const lab = _lab(p);
  if (!lab) return reply(msg, `🧪 Sem laboratório. Construa por ${formatMoney(LAB_BUILD_COST)} com \`!construir_lab\`.`);
  const liberados = Object.values(DROGAS).filter(d => d.labLevel <= lab.nivel).map(d => `${d.emoji} ${d.processedName}`).join(", ");
  const e = new EmbedBuilder().setTitle("🧪 Laboratório Clandestino").setColor(0x224422).addFields(
    { name: "Nível", value: `${lab.nivel}/${MAX_LAB_LEVEL}`, inline: true },
    { name: "Próx. upgrade", value: lab.nivel >= MAX_LAB_LEVEL ? "—" : `${formatMoney(LAB_UPGRADE_BASE * (lab.nivel + 1))} (\`!up_lab\`)`, inline: true },
    { name: "Drogas processáveis", value: liberados || "_nenhuma_", inline: false },
    { name: "Última batida", value: lab.lastRaid ? `<t:${Math.floor(lab.lastRaid / 1000)}:R>` : "Nunca", inline: false },
  );
  return reply(msg, { embeds: [e] });
});

reg(["plantar_d", "plantard", "plantardroga"], async (msg, args) => {
  const dk = args[0]?.toLowerCase();
  const def = dk ? DROGAS[dk] : null;
  if (!def) return reply(msg, "❌ Uso: `!plantar_d <droga>`. Veja com `!drogas`.");
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const cost = Math.floor(def.basePrice * 0.15);
  if (p.balance < cost) return reply(msg, `❌ A semente/precursor custa ${formatMoney(cost)}.`);
  const plantios = _plantios(p);
  if (plantios.length >= 6) return reply(msg, "❌ Limite de 6 plantios ilegais ao mesmo tempo.");
  await removeMoney(p.discordId, cost);
  const id = (plantios.reduce((m, x) => Math.max(m, x.id), 0) || 0) + 1;
  plantios.push({ id, droga: def.key, plantedAt: _now() });
  const inv = _inv(p);
  inv._droga_plantios = plantios;
  await updatePlayer(p.discordId, { inventory: inv });
  return reply(msg, `${def.emoji} Plantou **${def.name}** \`#${id}\` por ${formatMoney(cost)}. Pronta em ${def.growMinutes} min. Cuidado com a polícia.`);
});

reg(["plantios_d", "plantiosd", "minhasplantas"], async (msg, args) => {
  const { p, name, isOther } = await _target(msg, args);
  const plantios = _plantios(p);
  if (plantios.length === 0) return reply(msg, isOther ? `🌱 ${name} não tem plantios ilegais.` : "🌱 Sem plantios ilegais. Inicie com `!plantar_d <droga>`.");
  const lines = plantios.map(x => {
    const def = DROGAS[x.droga]!;
    const ms = _now() - x.plantedAt;
    const total = def.growMinutes * 60 * 1000;
    const restante = Math.max(0, total - ms);
    const pronto = restante === 0;
    return `\`#${x.id}\` ${def.emoji} ${def.name} — ${pronto ? `✅ **PRONTA** — \`!colher_d ${x.id}\`` : `⏳ ${Math.ceil(restante / 60000)} min`}`;
  });
  const e = new EmbedBuilder().setTitle("🌱 Seus plantios ilegais").setColor(0x335533).setDescription(lines.join("\n"))
    .setFooter({ text: "Dica: !colher_d sem ID colhe TODOS os prontos de uma vez (1 risco de batida por tipo)." });
  return reply(msg, { embeds: [e] });
});

// !colher_d <id>  → colhe um plantio específico
// !colher_d       → colhe TODOS os plantios prontos (1 risco de batida por tipo de droga)
reg(["colher_d", "colherd", "colherdroga"], async (msg, args) => {
  const id = intArg(args, 0);
  let p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const todos = _plantios(p);
  if (todos.length === 0) return reply(msg, "🌱 Sem plantios. Use `!plantar_d <droga>`.");

  let alvos: Array<{ id: number; droga: string; plantedAt: number }>;
  if (id) {
    const planta = todos.find(x => x.id === id);
    if (!planta) return reply(msg, `❌ Plantio \`#${id}\` não existe. Veja \`!plantios_d\`.`);
    const def0 = DROGAS[planta.droga];
    if (!def0) return reply(msg, "❌ Tipo de droga inválido nesse plantio (corrompido).");
    if (_now() - planta.plantedAt < def0.growMinutes * 60 * 1000) {
      const restMin = Math.ceil((def0.growMinutes * 60 * 1000 - (_now() - planta.plantedAt)) / 60000);
      return reply(msg, `⏳ Plantio \`#${id}\` ainda não está pronto (${restMin} min restantes).`);
    }
    alvos = [planta];
  } else {
    alvos = todos.filter(x => {
      const d = DROGAS[x.droga];
      return d && _now() - x.plantedAt >= d.growMinutes * 60 * 1000;
    });
    if (alvos.length === 0) return reply(msg, "⏳ Nenhum plantio pronto ainda. Veja `!plantios_d`.");
  }

  // Agrupa por tipo de droga (1 risco de batida por tipo)
  const porDroga = new Map<string, typeof alvos>();
  for (const a of alvos) {
    const list = porDroga.get(a.droga) ?? [];
    list.push(a);
    porDroga.set(a.droga, list);
  }

  const partes: string[] = [];
  for (const [droga, items] of porDroga) {
    // Recarrega antes do risco pra trabalhar com estado fresco (raid pode mutar a DB)
    p = await getOrCreatePlayer(msg.author.id, msg.author.username);
    const def = DROGAS[droga]!;
    const raid = await _checkRaid(p, droga);
    if (raid?.raided) {
      partes.push(`🚔 **BATIDA** em ${def.emoji} ${def.name} — perdeu ${raid.lostQty} plantio(s), +${raid.jail ? 2 : 1}⭐ procurado${raid.jail ? " e foi preso por 25min" : ""}.`);
      continue;
    }
    // Sem batida: re-lê o jogador (pra incluir mutações de bancos/etc anteriores) e colhe
    p = await getOrCreatePlayer(msg.author.id, msg.author.username);
    const inv = _inv(p);
    const drogas = _drogasInv(p);
    const plantNow = _plantios(p);
    const ids = new Set(items.map(i => i.id));
    drogas[droga] = (drogas[droga] ?? 0) + items.length;
    inv._drogas = drogas;
    inv._droga_plantios = plantNow.filter(x => !ids.has(x.id));
    bumpInf(inv, "raids_sobreviveu");
    await updatePlayer(p.discordId, { inventory: inv });
    partes.push(`${def.emoji} Colheu **${items.length}× ${def.name}** (in natura) — processar com \`!processar ${def.key}\`.`);
  }

  return reply(msg, partes.join("\n"));
});

reg(["processar"], async (msg, args) => {
  const dk = args[0]?.toLowerCase();
  const qtd = Math.max(1, intArg(args, 1) ?? 1);
  const def = dk ? DROGAS[dk] : null;
  if (!def) return reply(msg, "❌ Uso: `!processar <droga> [qtd]`. Veja `!drogas`.");
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const lab = _lab(p);
  if (!lab) return reply(msg, "❌ Sem laboratório. Use `!construir_lab`.");
  if (lab.nivel < def.labLevel) return reply(msg, `❌ Precisa de laboratório nível **${def.labLevel}** (você tem ${lab.nivel}). \`!up_lab\``);
  const drogas = _drogasInv(p);
  if ((drogas[def.key] ?? 0) < qtd) return reply(msg, `❌ Faltam plantas in natura. Você tem ${drogas[def.key] ?? 0}× ${def.name}.`);
  const custo = def.laborCost * qtd;
  if (p.balance < custo) return reply(msg, `❌ Custa ${formatMoney(custo)} pra processar.`);
  await removeMoney(p.discordId, custo);
  drogas[def.key] = (drogas[def.key] ?? 0) - qtd;
  drogas[def.processedKey] = (drogas[def.processedKey] ?? 0) + qtd * def.yieldPerRaw;
  const inv = _inv(p);
  inv._drogas = drogas;
  await updatePlayer(p.discordId, { inventory: inv });
  return reply(msg, `⚗️ Processou ${qtd}× ${def.name} → ${qtd * def.yieldPerRaw}× **${def.processedName}**. Custo ${formatMoney(custo)}. Estoque: ${drogas[def.processedKey]} un.`);
});

reg(["estoque_d", "estoqued", "narcoestoque"], async (msg) => {
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const drogas = _drogasInv(p);
  const entries = Object.entries(drogas).filter(([_, q]) => q > 0);
  if (entries.length === 0) return reply(msg, "📦 Sem estoque ilegal.");
  const lines = entries.map(([k, q]) => {
    const planta = DROGAS[k];
    const proc = Object.values(DROGAS).find(d => d.processedKey === k);
    const label = planta ? `${planta.emoji} ${planta.name} (in natura)` : proc ? `${proc.emoji} ${proc.processedName}` : k;
    return `${label} — ${q}`;
  });
  return reply(msg, { embeds: [new EmbedBuilder().setTitle("📦 Estoque ilegal").setColor(0x442244).setDescription(lines.join("\n"))] });
});

// ============ TABELA FIXA NPC (Boca de fumo) ============
// Cada produto tem preço unitário fixo (sem inflação), cap de unidades vendidas por dia
// e chance de denúncia por transação. Atualize aqui pra balancear progressão.
const NPC_DRUG_PRICES: Record<string, { unit: number; risk: number; cap: number }> = {
  maconha_pronta: { unit:  250, risk: 0.04, cap: 50 },
  po:             { unit: 1300, risk: 0.10, cap: 30 },
  her:            { unit: 4500, risk: 0.18, cap: 20 },
  meth:           { unit: 9000, risk: 0.25, cap: 15 },
};

reg(["precos_d", "precosd", "tabela_d", "boca_precos"], async (msg) => {
  const e = new EmbedBuilder().setTitle("📊 Tabela da Boca (NPC)").setColor(0x444466)
    .setDescription("Preços fixos pagos pela boca de fumo (NPC). Venda sem depender de jogador real.\nUso: `!vender_npc <produto> [qtd]` (ex: `!vender_npc po 10`).");
  for (const [k, tab] of Object.entries(NPC_DRUG_PRICES)) {
    const def = Object.values(DROGAS).find(d => d.processedKey === k);
    if (!def) continue;
    const dia = tab.unit * tab.cap;
    e.addFields({
      name: `${def.emoji} ${def.processedName} (\`${k}\`)`,
      value: `💵 **${formatMoney(tab.unit)}/un** · 📦 cap **${tab.cap}/dia** (até ${formatMoney(dia)}) · 🚔 ${(tab.risk * 100).toFixed(0)}% denúncia`,
      inline: false,
    });
  }
  e.setFooter({ text: "P2P (!traficar) tende a render mais por unidade, mas exige comprador real e 8% de delação." });
  return reply(msg, { embeds: [e] });
});

reg(["vender_npc", "vendernpc", "boca", "ponto"], async (msg, args) => {
  const dk = args[0]?.toLowerCase();
  const qtdPedida = Math.max(1, intArg(args, 1) ?? 1);
  if (!dk || !NPC_DRUG_PRICES[dk]) return reply(msg, "❌ Uso: `!vender_npc <produto> [qtd]` — veja `!precos_d`.");
  const tab = NPC_DRUG_PRICES[dk]!;
  const def = Object.values(DROGAS).find(d => d.processedKey === dk)!;
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  if (isJailed(p)) return reply(msg, "❌ Você está preso!");
  const drogas = _drogasInv(p);
  if ((drogas[dk] ?? 0) < 1) return reply(msg, `❌ Você não tem **${def.processedName}** em estoque.`);

  const inv = _inv(p);
  const today = new Date().toISOString().slice(0, 10);
  const sold = ((inv._npc_sold as Record<string, { day: string; qty: number }>) ?? {});
  const curr = sold[dk]?.day === today ? sold[dk].qty : 0;
  const restCap = Math.max(0, tab.cap - curr);
  if (restCap <= 0) return reply(msg, `📵 A boca já comprou ${tab.cap}× **${def.processedName}** hoje. Volte amanhã ou tente \`!traficar @user\`.`);

  const venderQtd = Math.min(qtdPedida, restCap, drogas[dk] ?? 0);
  const total = venderQtd * tab.unit;

  // Cada transação tem risco independente de denúncia
  const denuncia = Math.random() < tab.risk;

  drogas[dk] = (drogas[dk] ?? 0) - venderQtd;
  sold[dk] = { day: today, qty: curr + venderQtd };
  inv._drogas = drogas;
  inv._npc_sold = sold;
  bumpInf(inv, "traficos");
  bumpMissionProgress(inv, "traficar");

  const updates: any = { inventory: inv };
  if (denuncia) updates.wantedLevel = p.wantedLevel + 1;
  await updatePlayer(p.discordId, updates);
  await addMoney(p.discordId, total);
  await logTransaction("NPC", p.discordId, total, "drug_npc", `${venderQtd}× ${def.processedName}`);

  const partes = [`🤝 Vendeu **${venderQtd}× ${def.processedName}** na boca por ${formatMoney(total)} (cap restante hoje: ${tab.cap - (curr + venderQtd)}).`];
  if (venderQtd < qtdPedida) partes.push(`⚠️ Limite diário cortou: vendeu ${venderQtd} de ${qtdPedida} pedido(s).`);
  if (denuncia) partes.push("🚨 **DELAÇÃO!** +1 ⭐ procurado.");
  return reply(msg, partes.join("\n"));
});

reg(["traficar", "vender_d"], async (msg, args) => {
  const tid = getMentionId(msg, args, 0);
  const dk = args[1]?.toLowerCase();
  const qtd = Math.max(1, intArg(args, 2) ?? 1);
  const precoArg = intArg(args, 3);
  if (!tid || !dk) return reply(msg, "❌ Uso: `!traficar @user <drogaProcessadaKey> <qtd> [preço/un]`");
  if (tid === msg.author.id) return reply(msg, "❌ Não dá pra traficar pra si mesmo.");
  const def = Object.values(DROGAS).find(d => d.processedKey === dk);
  if (!def) return reply(msg, "❌ Droga desconhecida (use a chave **processada**, ex.: `maconha_pronta`, `po`, `her`, `meth`).");
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const buyer = await getPlayer(tid);
  if (!buyer) return reply(msg, "❌ Comprador não existe.");
  const drogas = _drogasInv(p);
  if ((drogas[dk] ?? 0) < qtd) return reply(msg, `❌ Você só tem ${drogas[dk] ?? 0}× ${def.processedName}.`);
  const preco = precoArg && precoArg > 0 ? precoArg : def.basePrice;
  const total = preco * qtd;
  if (buyer.balance < total) return reply(msg, `❌ Comprador sem grana (tem ${formatMoney(buyer.balance)}, precisa ${formatMoney(total)}).`);

  // chance de delação: 8% por transação; se delatar, autor leva +1 ⭐
  const denuncia = Math.random() < 0.08;

  await removeMoney(buyer.discordId, total);
  await addMoney(p.discordId, total);
  drogas[dk] = (drogas[dk] ?? 0) - qtd;
  // entrega ao comprador no estoque dele
  const binv = _inv(buyer);
  const bdrogas = _drogasInv(buyer);
  bdrogas[dk] = (bdrogas[dk] ?? 0) + qtd;
  binv._drogas = bdrogas;
  await updatePlayer(buyer.discordId, { inventory: binv });

  const inv = _inv(p);
  inv._drogas = drogas;
  bumpInf(inv, "traficos");
  bumpMissionProgress(inv, "traficar");
  if (denuncia) {
    await updatePlayer(p.discordId, { inventory: inv, wantedLevel: p.wantedLevel + 1 });
    return reply(msg, `🚨 ${qtd}× **${def.processedName}** traficado para <@${tid}> por ${formatMoney(total)} — mas o comprador **delatou**. +1 ⭐ procurado.`);
  } else {
    await updatePlayer(p.discordId, { inventory: inv });
    return reply(msg, `🤝 Traficou ${qtd}× **${def.processedName}** para <@${tid}> por ${formatMoney(total)}.`);
  }
});

reg(["consumir_d", "consumird", "usar_d"], async (msg, args) => {
  const dk = args[0]?.toLowerCase();
  const def = dk ? Object.values(DROGAS).find(d => d.processedKey === dk) : null;
  if (!def) return reply(msg, "❌ Uso: `!consumir_d <drogaProcessadaKey>`");
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const drogas = _drogasInv(p);
  if ((drogas[dk] ?? 0) < 1) return reply(msg, `❌ Você não tem **${def.processedName}**.`);
  drogas[dk]--;
  const vicio = _vicio(p);
  vicio[def.key] = Math.min(100, (vicio[def.key] ?? 0) + def.addiction);
  const inv = _inv(p);
  inv._drogas = drogas;
  inv._vicio = vicio;
  bumpMissionProgress(inv, "consumir_d");
  let efeitoTxt = "";
  const updates: any = { inventory: inv };
  if (def.effect.type === "energy") {
    updates.energy = Math.min(100, p.energy + def.effect.amount);
    efeitoTxt = `⚡ +${def.effect.amount} energia`;
  } else if (def.effect.type === "health") {
    updates.health = Math.min(p.maxHealth, p.health + def.effect.amount);
    efeitoTxt = `❤️ +${def.effect.amount} saúde`;
  }
  await updatePlayer(p.discordId, updates);
  if (def.effect.type === "xp") { try { await addXp(p.discordId, def.effect.amount); } catch {} efeitoTxt = `✨ +${def.effect.amount} XP`; }
  return reply(msg, `${def.emoji} Consumiu **${def.processedName}** — ${efeitoTxt}. Vício em **${def.name}**: ${vicio[def.key]}/100.`);
});

reg(["desintoxicar", "rehab", "clinica"], async (msg) => {
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const vicio = _vicio(p);
  const total = Object.values(vicio).reduce((s, v) => s + v, 0);
  if (total === 0) return reply(msg, "✨ Você está limpo, parceiro.");
  const cost = total * 250;
  if (p.balance < cost) return reply(msg, `❌ Reabilitação custa ${formatMoney(cost)} (vício total: ${total}). Faltam ${formatMoney(cost - p.balance)}.`);
  await removeMoney(p.discordId, cost);
  const inv = _inv(p);
  inv._vicio = {};
  await updatePlayer(p.discordId, { inventory: inv });
  return reply(msg, `🏥 Reabilitação concluída por ${formatMoney(cost)}. Vício zerado.`);
});

// ============ GOLPES ============

reg(["golpes", "esquemas"], async (msg) => {
  const e = new EmbedBuilder()
    .setTitle("💼 Golpes & Esquemas")
    .setColor(0x664400)
    .setDescription("Cada golpe tem cooldown e chance de falha. Falha = ⭐ procurado e zero retorno.")
    .addFields(
      ...Object.values(GOLPES).map(g => ({
        name: `${g.emoji} \`${g.key}\` — ${g.name}`,
        value: `${g.description}\nChance base ${(g.successBase * 100).toFixed(0)}% · cooldown ${Math.round(g.cooldownMs / 60000)} min · falha = +${g.wantedOnFail} ⭐`,
      })),
      { name: "🏗️ Pirâmide Financeira", value: `\`!piramide criar <nome> <entrada>\` (mín. ${formatMoney(PIRAMIDE_MIN_ENTRADA)}) — colapsa em ${PIRAMIDE_DURACAO_MS / 3600000}h. Só os ${PIRAMIDE_PAGA_DEPOIS_DE} primeiros recebem 1.8x. Resto perde tudo.` },
    );
  return reply(msg, { embeds: [e] });
});

reg(["golpe"], async (msg, args) => {
  const tipo = args[0]?.toLowerCase();
  const g = tipo ? GOLPES[tipo] : null;
  if (!g) return reply(msg, "❌ Uso: `!golpe <phishing|estelionato|falsoproduto> [@alvo]`. Veja `!golpes`.");
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const lastKey = `_last_${g.key}`;
  const last = ((p.inventory as any)?.[lastKey] as number) ?? 0;
  if (_now() - last < g.cooldownMs) return reply(msg, `⏳ Aguarde ${formatCooldown(g.cooldownMs - (_now() - last))}.`);

  const tid = getMentionId(msg, args, 1);
  let alvoBoost = 0;
  let alvo: any = null;
  if (tid) {
    alvo = await getPlayer(tid);
    if (alvo) alvoBoost = Math.max(-0.2, Math.min(0.25, (50 - alvo.reputation) / 200)); // alvo com baixa rep cai mais fácil
  }

  const sucesso = Math.random() < (g.successBase + alvoBoost);
  const inv = _inv(p);
  inv[lastKey] = _now();

  if (!sucesso) {
    await updatePlayer(p.discordId, {
      inventory: inv,
      wantedLevel: p.wantedLevel + g.wantedOnFail,
      reputation: Math.max(-100, p.reputation - 5),
    });
    return reply(msg, `${g.emoji} ${g.name} **falhou**! +${g.wantedOnFail} ⭐ procurado, -5 reputação.`);
  }

  const valor = Math.floor(g.rewardMin + Math.random() * (g.rewardMax - g.rewardMin));
  if (alvo) {
    if (alvo.balance < valor) {
      await addMoney(p.discordId, alvo.balance);
      await updatePlayer(alvo.discordId, { balance: 0 });
      bumpInf(inv, "golpes");
      bumpMissionProgress(inv, g.key === "phishing" ? "phishing" : "trabalhar");
      await updatePlayer(p.discordId, { inventory: inv });
      return reply(msg, `${g.emoji} ${g.name} **bem-sucedido** contra <@${alvo.discordId}> — ele só tinha ${formatMoney(alvo.balance)}, levou tudo.`);
    }
    await removeMoney(alvo.discordId, valor);
  }
  await addMoney(p.discordId, valor);
  bumpInf(inv, "golpes");
  if (g.key === "phishing") bumpMissionProgress(inv, "phishing");
  await updatePlayer(p.discordId, { inventory: inv });
  return reply(msg, `${g.emoji} ${g.name} **bem-sucedido**! Faturou ${formatMoney(valor)}${alvo ? ` de <@${alvo.discordId}>` : ""}.`);
});

// ====== Pirâmide ======
reg(["piramide"], async (msg, args) => {
  const sub = (args[0] ?? "").toLowerCase();
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const inv = _inv(p);

  if (sub === "criar") {
    const nome = args[1];
    const entrada = intArg(args, 2);
    if (!nome || !entrada) return reply(msg, `❌ Uso: \`!piramide criar <nome> <entrada>\` (mín. ${formatMoney(PIRAMIDE_MIN_ENTRADA)})`);
    if (entrada < PIRAMIDE_MIN_ENTRADA) return reply(msg, `❌ Entrada mínima ${formatMoney(PIRAMIDE_MIN_ENTRADA)}.`);
    if ((inv._piramide_dono as any)?.ativa) return reply(msg, "❌ Você já tem uma pirâmide ativa. Encerre com `!piramide encerrar`.");
    const id = `pir_${_now()}`;
    inv._piramide_dono = { id, nome, entrada, criadoEm: _now(), pote: 0, participantes: 0, ativa: true };
    await updatePlayer(p.discordId, { inventory: inv });
    return reply(msg, `🏗️ Pirâmide **${nome}** criada (entrada ${formatMoney(entrada)}). Compartilhe \`!piramide entrar @${p.username}\` com os trouxas. Colapsa em ${PIRAMIDE_DURACAO_MS / 3600000}h.`);
  }

  if (sub === "entrar") {
    const tid = getMentionId(msg, args, 1);
    if (!tid) return reply(msg, "❌ Uso: `!piramide entrar @dono`");
    const dono = await getPlayer(tid);
    if (!dono) return reply(msg, "❌ Dono inválido.");
    const pir = (dono.inventory as any)?._piramide_dono as any;
    if (!pir || !pir.ativa) return reply(msg, "❌ Esse jogador não tem pirâmide ativa.");
    if (_now() - pir.criadoEm > PIRAMIDE_DURACAO_MS) return reply(msg, "💥 Essa pirâmide já colapsou.");
    if (p.balance < pir.entrada) return reply(msg, `❌ Entrada custa ${formatMoney(pir.entrada)}.`);
    await removeMoney(p.discordId, pir.entrada);

    // 30% pro dono, resto pro pote
    const taxaDono = Math.floor(pir.entrada * PIRAMIDE_TAXA_DONO);
    await addMoney(dono.discordId, taxaDono);
    pir.pote = (pir.pote ?? 0) + (pir.entrada - taxaDono);
    pir.participantes = (pir.participantes ?? 0) + 1;
    const dinv = _inv(dono);
    dinv._piramide_dono = pir;
    bumpInf(dinv, "pirámides");
    await updatePlayer(dono.discordId, { inventory: dinv });

    // Registra no investidor
    const investList = ((p.inventory as any)?._piramide_invest as any[]) ?? [];
    investList.push({ donoId: dono.discordId, piramideId: pir.id, valor: pir.entrada, ts: _now() });
    inv._piramide_invest = investList;

    // Se está entre os primeiros N, paga 1.8x na hora (do pote)
    let payout = 0;
    if (pir.participantes <= PIRAMIDE_PAGA_DEPOIS_DE) {
      payout = Math.min(pir.pote, Math.floor(pir.entrada * 1.8));
      if (payout > 0) {
        await addMoney(p.discordId, payout);
        pir.pote -= payout;
        const dinv2 = _inv(dono);
        dinv2._piramide_dono = pir;
        await updatePlayer(dono.discordId, { inventory: dinv2 });
      }
    }
    await updatePlayer(p.discordId, { inventory: inv });
    return reply(msg, `🏗️ Entrou na pirâmide **${pir.nome}** por ${formatMoney(pir.entrada)}.${payout > 0 ? ` 💸 Você é dos primeiros — recebeu ${formatMoney(payout)} (1.8x).` : " ⚠️ Só os 5 primeiros recebem retorno."}`);
  }

  if (sub === "status") {
    const tid = getMentionId(msg, args, 1) ?? p.discordId;
    const dono = await getPlayer(tid);
    const pir = (dono?.inventory as any)?._piramide_dono as any;
    if (!pir) return reply(msg, "❌ Sem pirâmide ativa.");
    const colapsou = !pir.ativa || _now() - pir.criadoEm > PIRAMIDE_DURACAO_MS;
    return reply(msg, `🏗️ **${pir.nome}** — entrada ${formatMoney(pir.entrada)} · participantes ${pir.participantes} · pote ${formatMoney(pir.pote)} · ${colapsou ? "💥 COLAPSADA" : `🟢 ativa, colapsa <t:${Math.floor((pir.criadoEm + PIRAMIDE_DURACAO_MS) / 1000)}:R>`}`);
  }

  if (sub === "encerrar") {
    const pir = inv._piramide_dono as any;
    if (!pir || !pir.ativa) return reply(msg, "❌ Sem pirâmide ativa pra encerrar.");
    const sobra = pir.pote ?? 0;
    if (sobra > 0) await addMoney(p.discordId, sobra);
    pir.ativa = false;
    pir.pote = 0;
    inv._piramide_dono = pir;
    await updatePlayer(p.discordId, { inventory: inv, reputation: Math.max(-100, p.reputation - 25) });
    return reply(msg, `💥 Pirâmide encerrada. Você sumiu com ${formatMoney(sobra)} do pote. Reputação -25.`);
  }

  return reply(msg, "❌ Uso: `!piramide criar|entrar|status|encerrar`. Veja `!golpes`.");
});

// ============ SUBORNO ============

reg(["subornar", "suborno"], async (msg, args) => {
  const alvoKey = args[0]?.toLowerCase();
  const valor = intArg(args, 1);
  const alvo = alvoKey ? SUBORNO_ALVOS[alvoKey] : null;
  if (!alvo) {
    const lista = Object.values(SUBORNO_ALVOS).map(a => `${a.emoji} \`${a.key}\` — mín ${formatMoney(a.custoMin)} · ${a.description}`).join("\n");
    return reply(msg, `❌ Uso: \`!subornar <alvo> [valor]\`\n${lista}`);
  }
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const v = valor && valor >= alvo.custoMin ? valor : alvo.custoMin;
  if (p.balance < v) return reply(msg, `❌ Custa ${formatMoney(v)}.`);
  await removeMoney(p.discordId, v);

  // chance de escândalo
  if (Math.random() < alvo.scandalChance) {
    await updatePlayer(p.discordId, { wantedLevel: p.wantedLevel + 2, reputation: Math.max(-100, p.reputation - 20), criminalRecord: p.criminalRecord + 1 });
    return reply(msg, `🚨 ESCÂNDALO! O suborno vazou. +2 ⭐, -20 reputação. Você ainda perdeu o ${formatMoney(v)}.`);
  }

  const inv = _inv(p);
  const subs = ((inv._subornos as any[]) ?? []);
  subs.push({ ts: _now(), alvo: alvo.key, valor: v });
  inv._subornos = subs.slice(-30);
  bumpInf(inv, "subornos");
  bumpMissionProgress(inv, "suborno");

  const updates: any = { inventory: inv };
  let efeito = "";

  if (alvo.apply === "wanted") {
    const levels = Math.floor(v / alvo.custoMin);
    updates.wantedLevel = Math.max(0, p.wantedLevel - levels);
    efeito = `${alvo.emoji} -${levels} ⭐ procurado (agora ${updates.wantedLevel}).`;
  } else if (alvo.apply === "jail") {
    const minutos = Math.floor(v / alvo.custoMin) * 10;
    if (p.isJailed && p.jailEnd) {
      const novo = new Date(p.jailEnd.getTime() - minutos * 60 * 1000);
      const livre = novo.getTime() <= _now();
      updates.jailEnd = livre ? null : novo;
      updates.isJailed = !livre;
      efeito = `${alvo.emoji} -${minutos} min de cadeia. ${livre ? "Você está livre!" : `Sai <t:${Math.floor(novo.getTime() / 1000)}:R>`}.`;
    } else {
      efeito = `${alvo.emoji} Compensação na manga: o juiz vai facilitar na próxima.`;
    }
  } else if (alvo.apply === "fiscal") {
    inv._imune_fiscal_ate = _now() + 24 * 60 * 60 * 1000;
    updates.inventory = inv;
    efeito = `${alvo.emoji} 24h imune a auditoria. Sonegação zerada nas declarações.`;
  } else if (alvo.apply === "prefeito") {
    const c = await db.query.companies.findFirst({ where: eq(schema.companies.ownerId, p.discordId) });
    if (c) {
      await db.update(schema.companies).set({ level: c.level + 1 }).where(eq(schema.companies.id, c.id));
      efeito = `${alvo.emoji} Sua empresa **${c.name}** subiu pra nível ${c.level + 1} sem precisar expandir.`;
    } else {
      efeito = `${alvo.emoji} Você não tem empresa — o prefeito agradeceu pelo dinheiro mesmo assim.`;
    }
  }

  await updatePlayer(p.discordId, updates);
  return reply(msg, `🤝 Suborno de ${formatMoney(v)} ao ${alvo.name} aceito.\n${efeito}`);
});

reg(["subornos"], async (msg) => {
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const subs = ((p.inventory as any)?._subornos as any[]) ?? [];
  if (subs.length === 0) return reply(msg, "🤝 Sem histórico de subornos. Você é um santo.");
  const total = subs.reduce((s: number, x: any) => s + x.valor, 0);
  const lines = subs.slice(-10).reverse().map((x: any) => `<t:${Math.floor(x.ts / 1000)}:R> · ${SUBORNO_ALVOS[x.alvo]?.emoji ?? ""} ${SUBORNO_ALVOS[x.alvo]?.name ?? x.alvo} — ${formatMoney(x.valor)}`);
  return reply(msg, { embeds: [new EmbedBuilder().setTitle("🤝 Histórico de Subornos").setColor(0x665522).setDescription(lines.join("\n")).setFooter({ text: `Total declarável: ${formatMoney(total)}` })] });
});

// ============ CHANTAGEM ============

reg(["fofoca", "investigar"], async (msg, args) => {
  const tid = getMentionId(msg, args, 0);
  if (!tid) return reply(msg, "❌ Uso: `!fofoca @user`");
  if (tid === msg.author.id) return reply(msg, "❌ Investigar a si mesmo? Para que?");
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const last = ((p.inventory as any)?._last_fofoca as number) ?? 0;
  if (_now() - last < FOFOCA_COOLDOWN_MS) return reply(msg, `⏳ Aguarde ${formatCooldown(FOFOCA_COOLDOWN_MS - (_now() - last))}.`);
  if (p.balance < FOFOCA_COST) return reply(msg, `❌ Custa ${formatMoney(FOFOCA_COST)} pra investigar.`);
  await removeMoney(p.discordId, FOFOCA_COST);
  const inv = _inv(p);
  inv._last_fofoca = _now();

  const t = await getPlayer(tid);
  if (!t) {
    await updatePlayer(p.discordId, { inventory: inv });
    return reply(msg, "❌ Alvo não encontrado.");
  }

  if (Math.random() > FOFOCA_SUCCESS) {
    await updatePlayer(p.discordId, { inventory: inv });
    return reply(msg, `🕵️ Você gastou ${formatMoney(FOFOCA_COST)} mas não achou nada útil sobre <@${tid}>.`);
  }

  const fact = DIRT_FACTS[Math.floor(Math.random() * DIRT_FACTS.length)]!;
  const dirts: DirtItem[] = (inv._dirt as DirtItem[]) ?? [];
  const id = (dirts.reduce((m, x) => Math.max(m, x.id), 0) || 0) + 1;
  dirts.push({ id, aboutId: tid, aboutName: t.username, fact, collectedAt: _now() });
  inv._dirt = dirts;

  // grava também no alvo (lista de "sujeira contra mim")
  const tinv = _inv(t);
  const against: DirtItem[] = (tinv._dirt_against_me as DirtItem[]) ?? [];
  against.push({ id, aboutId: tid, aboutName: t.username, fact, collectedAt: _now() });
  tinv._dirt_against_me = against;
  await updatePlayer(tid, { inventory: tinv });

  await updatePlayer(p.discordId, { inventory: inv });
  return reply(msg, `🕵️ Descobriu: **${t.username} ${fact}**. Use \`!chantagear @${t.username} <valor>\` (id ${id}).`);
});

reg(["chantagear", "extorquir"], async (msg, args) => {
  const tid = getMentionId(msg, args, 0);
  const valor = intArg(args, 1);
  if (!tid || !valor) return reply(msg, "❌ Uso: `!chantagear @user <valor>`");
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const dirts: DirtItem[] = ((p.inventory as any)?._dirt as DirtItem[]) ?? [];
  const dirt = dirts.find(d => d.aboutId === tid);
  if (!dirt) return reply(msg, "❌ Você não tem nenhuma sujeira sobre esse jogador. Use `!fofoca @user`.");
  const t = await getPlayer(tid);
  if (!t) return reply(msg, "❌ Alvo não existe.");
  if (t.balance < valor) {
    // alvo sem dinheiro: a chantagem vaza
    const ch = msg.channel as TextChannel;
    await ch.send(`📰 **VAZOU!** <@${t.discordId}> ${dirt.fact}. (Cortesia de <@${p.discordId}>, que tentou chantagear sem o alvo poder pagar.)`).catch(() => {});
    const inv = _inv(p);
    inv._dirt = dirts.filter(d => d.id !== dirt.id);
    bumpInf(inv, "chantagens");
    await updatePlayer(p.discordId, { inventory: inv });
    return reply(msg, `🤐 Alvo sem grana — sua sujeira foi pra praça pública.`);
  }

  // cobra direto (modelo simples): alvo paga e a sujeira é "quitada"
  await removeMoney(t.discordId, valor);
  await addMoney(p.discordId, valor);
  const inv = _inv(p);
  inv._dirt = dirts.filter(d => d.id !== dirt.id);
  bumpInf(inv, "chantagens");
  bumpMissionProgress(inv, "chantagear");
  await updatePlayer(p.discordId, { inventory: inv });

  // remove do alvo também
  const tinv = _inv(t);
  tinv._dirt_against_me = ((tinv._dirt_against_me as DirtItem[]) ?? []).filter((d: DirtItem) => d.id !== dirt.id);
  await updatePlayer(tid, { inventory: tinv });

  return reply(msg, `💰 Chantageou <@${tid}> em ${formatMoney(valor)}. A sujeira foi guardada de volta no envelope. Por enquanto.`);
});

reg(["sigilo", "limparficha"], async (msg) => {
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const against: DirtItem[] = ((p.inventory as any)?._dirt_against_me as DirtItem[]) ?? [];
  if (against.length === 0) return reply(msg, "🧼 Ninguém tem sujeira sobre você.");
  const cost = against.length * SIGILO_COST_PER_DIRT;
  if (p.balance < cost) return reply(msg, `❌ Custa ${formatMoney(cost)} (${against.length}× ${formatMoney(SIGILO_COST_PER_DIRT)}).`);
  await removeMoney(p.discordId, cost);
  const inv = _inv(p);
  inv._dirt_against_me = [];
  await updatePlayer(p.discordId, { inventory: inv });

  // remove do inventário de quem coletou
  const ids = new Set(against.map(d => d.id));
  const all = await db.query.players.findMany();
  for (const other of all) {
    const oinv = _inv(other);
    const list = (oinv._dirt as DirtItem[] | undefined) ?? [];
    const filtered = list.filter((d: DirtItem) => !ids.has(d.id));
    if (filtered.length !== list.length) {
      oinv._dirt = filtered;
      await updatePlayer(other.discordId, { inventory: oinv });
    }
  }
  return reply(msg, `🧼 Pagou ${formatMoney(cost)} e selou ${against.length} sujeira(s) que tinham contra você.`);
});

// ============ SEQUESTRO ============

reg(["sequestrar", "kidnap"], async (msg, args) => {
  const tid = getMentionId(msg, args, 0);
  const ransom = intArg(args, 1);
  if (!tid || !ransom) return reply(msg, `❌ Uso: \`!sequestrar @user <resgate>\` (entre ${formatMoney(SEQUESTRO_RANSOM_MIN)} e ${formatMoney(SEQUESTRO_RANSOM_MAX)})`);
  if (tid === msg.author.id) return reply(msg, "❌ Auto-sequestro? Vai num psicólogo.");
  if (ransom < SEQUESTRO_RANSOM_MIN || ransom > SEQUESTRO_RANSOM_MAX) return reply(msg, `❌ Resgate entre ${formatMoney(SEQUESTRO_RANSOM_MIN)} e ${formatMoney(SEQUESTRO_RANSOM_MAX)}.`);
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  if (!p.weapon) return reply(msg, "❌ Precisa de arma equipada (`!arma loja`).");
  const t = await getPlayer(tid);
  if (!t) return reply(msg, "❌ Alvo não existe.");
  if ((t.inventory as any)?._sequestrado_por) return reply(msg, "❌ Esse jogador já está sequestrado.");

  // chance: força do criminoso vs reputação do alvo
  const chance = 0.55 + (p.reputation < 0 ? 0.1 : 0) - (t.reputation > 50 ? 0.1 : 0);
  if (Math.random() > chance) {
    await updatePlayer(p.discordId, { wantedLevel: p.wantedLevel + 2, health: Math.max(0, p.health - 25), criminalRecord: p.criminalRecord + 1 });
    return reply(msg, `❌ Tentativa de sequestro **falhou**! <@${t.discordId}> reagiu, você levou 25 de dano e +2 ⭐ procurado.`);
  }

  const until = _now() + SEQUESTRO_DURACAO_MS;
  const tinv = _inv(t);
  tinv._sequestrado_por = { kidnapperId: p.discordId, ransom, until };
  await updatePlayer(tid, { inventory: tinv });

  const inv = _inv(p);
  const seqs = ((inv._sequestros as any[]) ?? []);
  seqs.push({ victimId: tid, ransom, until });
  inv._sequestros = seqs;
  bumpInf(inv, "sequestros");
  bumpMissionProgress(inv, "sequestro");
  await updatePlayer(p.discordId, { inventory: inv, wantedLevel: p.wantedLevel + 1, criminalRecord: p.criminalRecord + 1 });

  return reply(msg, `🪤 <@${tid}> foi sequestrado! Resgate: **${formatMoney(ransom)}**. Solto <t:${Math.floor(until / 1000)}:R>. A vítima pode tentar fugir com \`!fugir_seq\` ou alguém pode pagar com \`!resgatar @${t.username}\`.`);
});

reg(["resgatar", "pagarresgate"], async (msg, args) => {
  const tid = getMentionId(msg, args, 0);
  if (!tid) return reply(msg, "❌ Uso: `!resgatar @vitima`");
  const t = await getPlayer(tid);
  if (!t) return reply(msg, "❌ Vítima não existe.");
  const seq = (t.inventory as any)?._sequestrado_por;
  if (!seq) return reply(msg, "❌ Esse jogador não está sequestrado.");
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  if (p.balance < seq.ransom) return reply(msg, `❌ Resgate custa ${formatMoney(seq.ransom)}.`);
  await removeMoney(p.discordId, seq.ransom);
  await addMoney(seq.kidnapperId, seq.ransom);

  const tinv = _inv(t);
  tinv._sequestrado_por = null;
  await updatePlayer(tid, { inventory: tinv });

  const kidnapper = await getPlayer(seq.kidnapperId);
  if (kidnapper) {
    const kinv = _inv(kidnapper);
    kinv._sequestros = ((kinv._sequestros as any[]) ?? []).filter((s: any) => s.victimId !== tid);
    await updatePlayer(seq.kidnapperId, { inventory: kinv });
  }
  return reply(msg, `🆓 <@${p.discordId}> pagou ${formatMoney(seq.ransom)} de resgate. <@${tid}> está livre.`);
});

reg(["fugir_seq", "fugirseq", "escapar"], async (msg) => {
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const seq = (p.inventory as any)?._sequestrado_por;
  if (!seq) return reply(msg, "✋ Você não está sequestrado.");
  if (Math.random() < SEQUESTRO_TAXA_FUGA) {
    const inv = _inv(p);
    inv._sequestrado_por = null;
    bumpInf(inv, "fugas");
    await updatePlayer(p.discordId, { inventory: inv });
    // remove do kidnapper
    const k = await getPlayer(seq.kidnapperId);
    if (k) {
      const kinv = _inv(k);
      kinv._sequestros = ((kinv._sequestros as any[]) ?? []).filter((s: any) => s.victimId !== p.discordId);
      await updatePlayer(seq.kidnapperId, { inventory: kinv });
    }
    return reply(msg, "🏃 Você fugiu do cativeiro!");
  }
  await updatePlayer(p.discordId, { health: Math.max(1, p.health - SEQUESTRO_DANO_FUGA) });
  return reply(msg, `❌ Tentativa de fuga falhou — apanhou e perdeu ${SEQUESTRO_DANO_FUGA} de saúde.`);
});

reg(["sequestros"], async (msg) => {
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const seqs = ((p.inventory as any)?._sequestros as any[]) ?? [];
  const ativos = seqs.filter((s: any) => s.until > _now());
  if (ativos.length === 0) return reply(msg, "🪤 Sem sequestros ativos.");
  return reply(msg, `🪤 Reféns:\n${ativos.map((s: any) => `<@${s.victimId}> — ${formatMoney(s.ransom)} · solta <t:${Math.floor(s.until / 1000)}:R>`).join("\n")}`);
});

// ============ MERCADO P2P ============

reg(["ofertar", "anunciar_item"], async (msg, args) => {
  const itemKey = args[0];
  const qtd = Math.max(1, intArg(args, 1) ?? 1);
  const preco = intArg(args, 2);
  if (!itemKey || !preco) return reply(msg, "❌ Uso: `!ofertar <itemKey> <qtd> <preço total>`. Itens válidos: o que você tiver no inventário (chaves do `!inv`).");
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const inv: any = _inv(p);
  const have = (inv[itemKey] as number) ?? 0;
  if (have < qtd) return reply(msg, `❌ Você só tem ${have} de \`${itemKey}\`.`);
  const ofertas: MarketOffer[] = (inv._mercado_ofertas as MarketOffer[]) ?? [];
  if (ofertas.length >= MERCADO_MAX_OFERTAS) return reply(msg, `❌ Máximo ${MERCADO_MAX_OFERTAS} ofertas ativas.`);
  const id = Math.floor(Date.now() / 1000) * 100 + Math.floor(Math.random() * 100);
  inv[itemKey] = have - qtd; // reserva
  const fp = findProduct(itemKey);
  const itemName = fp ? `${fp.product.emoji} ${fp.product.name}` : itemKey;
  ofertas.push({ id, sellerId: p.discordId, sellerName: p.username, itemKey, itemName, qtd, preco, criadoEm: _now() });
  inv._mercado_ofertas = ofertas;
  await updatePlayer(p.discordId, { inventory: inv });
  return reply(msg, `📢 Oferta \`#${id}\` criada: ${qtd}× ${itemName} por ${formatMoney(preco)}. Compradores usam \`!comprar_oferta ${id}\`.`);
});

reg(["mercado", "marketplace"], async (msg) => {
  const all = await db.query.players.findMany();
  const ofertas: MarketOffer[] = [];
  for (const pl of all) {
    const list = ((pl.inventory as any)?._mercado_ofertas as MarketOffer[]) ?? [];
    for (const o of list) ofertas.push(o);
  }
  if (ofertas.length === 0) return reply(msg, "🛒 Mercado vazio. Anuncie algo com `!ofertar`.");
  const lines = ofertas.slice(0, 25).map(o => `\`#${o.id}\` ${o.itemName} ×${o.qtd} — **${formatMoney(o.preco)}** _(vendedor: ${o.sellerName})_`);
  const e = new EmbedBuilder().setTitle("🛒 Mercado P2P").setColor(0x224488).setDescription(lines.join("\n")).setFooter({ text: `Compre com !comprar_oferta <id> · taxa ${(MERCADO_TAXA * 100).toFixed(0)}%` });
  return reply(msg, { embeds: [e] });
});

reg(["comprar_oferta", "comprarof"], async (msg, args) => {
  const id = intArg(args, 0);
  if (!id) return reply(msg, "❌ Uso: `!comprar_oferta <id>` (veja em `!mercado`)");
  const all = await db.query.players.findMany();
  let seller: any = null;
  let offer: MarketOffer | null = null;
  for (const pl of all) {
    const list = ((pl.inventory as any)?._mercado_ofertas as MarketOffer[]) ?? [];
    const o = list.find(x => x.id === id);
    if (o) { seller = pl; offer = o; break; }
  }
  if (!offer || !seller) return reply(msg, "❌ Oferta não existe.");
  const buyer = await getOrCreatePlayer(msg.author.id, msg.author.username);
  if (buyer.discordId === seller.discordId) return reply(msg, "❌ Não compre de si mesmo.");
  if (buyer.balance < offer.preco) return reply(msg, `❌ Faltam ${formatMoney(offer.preco - buyer.balance)}.`);

  const taxa = Math.floor(offer.preco * MERCADO_TAXA);
  const liquido = offer.preco - taxa;
  await removeMoney(buyer.discordId, offer.preco);
  await addMoney(seller.discordId, liquido);

  // entrega item ao comprador
  const binv: any = _inv(buyer);
  binv[offer.itemKey] = (binv[offer.itemKey] ?? 0) + offer.qtd;
  await updatePlayer(buyer.discordId, { inventory: binv });

  // remove oferta do vendedor
  const sinv: any = _inv(seller);
  sinv._mercado_ofertas = ((sinv._mercado_ofertas as MarketOffer[]) ?? []).filter((o: MarketOffer) => o.id !== id);
  await updatePlayer(seller.discordId, { inventory: sinv });

  await logTransaction(buyer.discordId, seller.discordId, offer.preco, "marketplace", `${offer.qtd}× ${offer.itemName}`);
  return reply(msg, `🛒 Comprou ${offer.qtd}× ${offer.itemName} por ${formatMoney(offer.preco)} (taxa ${formatMoney(taxa)}). Item entregue no inventário.`);
});

reg(["retirar_oferta", "retirarof"], async (msg, args) => {
  const id = intArg(args, 0);
  if (!id) return reply(msg, "❌ Uso: `!retirar_oferta <id>`");
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const inv: any = _inv(p);
  const ofertas: MarketOffer[] = (inv._mercado_ofertas as MarketOffer[]) ?? [];
  const o = ofertas.find(x => x.id === id);
  if (!o) return reply(msg, "❌ Você não tem oferta com esse id.");
  inv[o.itemKey] = (inv[o.itemKey] ?? 0) + o.qtd;
  inv._mercado_ofertas = ofertas.filter((x: MarketOffer) => x.id !== id);
  await updatePlayer(p.discordId, { inventory: inv });
  return reply(msg, `↩️ Oferta \`#${id}\` retirada e itens devolvidos ao inventário.`);
});

// ============ MISSÕES DIÁRIAS ============

function _ensureMissions(p: any): { day: string; list: MissionDef[]; progress: Record<string, number>; claimed: string[] } {
  const inv: any = p.inventory ?? {};
  const today = todayKey();
  const cur = inv._missoes;
  if (cur && cur.day === today && Array.isArray(cur.list)) return cur;
  const fresh = { day: today, list: pickDailyMissions(today + p.discordId), progress: {} as Record<string, number>, claimed: [] as string[] };
  return fresh;
}

reg(["missoes", "daily_missions", "missao"], async (msg) => {
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const m = _ensureMissions(p);
  if (((p.inventory as any)?._missoes?.day) !== m.day) {
    const inv = _inv(p);
    inv._missoes = m;
    await updatePlayer(p.discordId, { inventory: inv });
  }
  const e = new EmbedBuilder().setTitle("📋 Missões Diárias").setColor(0x008844)
    .setDescription("Resetam todo dia (UTC). Resgate com `!resgatarmissao <key>`.")
    .addFields(m.list.map(mis => {
      const prog = Math.min(mis.goal, m.progress[mis.key] ?? 0);
      const done = prog >= mis.goal;
      const claimed = m.claimed.includes(mis.key);
      return {
        name: `\`${mis.key}\` ${mis.description}`,
        value: `Progresso ${prog}/${mis.goal} · Recompensa ${formatMoney(mis.reward)} ${claimed ? "✅ resgatada" : done ? "🎁 pronta" : ""}`,
      };
    }));
  return reply(msg, { embeds: [e] });
});

reg(["resgatarmissao", "resgatemissao", "claimmissao"], async (msg, args) => {
  const key = args[0];
  if (!key) return reply(msg, "❌ Uso: `!resgatarmissao <key>` (veja `!missoes`).");
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const m = _ensureMissions(p);
  const mis = m.list.find(x => x.key === key);
  if (!mis) return reply(msg, "❌ Missão não existe (ou já passou).");
  if (m.claimed.includes(mis.key)) return reply(msg, "✅ Já resgatada.");
  const prog = m.progress[mis.key] ?? 0;
  if (prog < mis.goal) return reply(msg, `❌ Faltam ${mis.goal - prog} pra completar.`);
  m.claimed.push(mis.key);
  await addMoney(p.discordId, mis.reward);
  const inv = _inv(p);
  inv._missoes = m;
  await updatePlayer(p.discordId, { inventory: inv });
  return reply(msg, `🎁 Missão **${mis.description}** concluída! Recebeu ${formatMoney(mis.reward)}.`);
});

// ============ INFÂMIA ============

reg(["infamia", "score", "ranksal"], async (msg, args) => {
  const tid = getMentionId(msg, args, 0) ?? msg.author.id;
  const t = await getPlayer(tid) ?? await getOrCreatePlayer(tid, msg.author.username);
  const c = ((t.inventory as any)?._inf_counters) as any;
  const score = calcInfamia(c);
  const tit = infamiaTitulo(score);
  const lines: string[] = [];
  lines.push(`**Pontuação:** ${score}`);
  lines.push(`**Título:** ${tit.emoji} ${tit.titulo}`);
  if (c) {
    lines.push("");
    lines.push(`Golpes: ${c.golpes ?? 0} · Subornos: ${c.subornos ?? 0} · Sequestros: ${c.sequestros ?? 0}`);
    lines.push(`Tráficos: ${c.traficos ?? 0} · Chantagens: ${c.chantagens ?? 0} · Pirâmides: ${c.pirámides ?? 0}`);
    lines.push(`Fugas: ${c.fugas ?? 0} · Batidas sobreviveu: ${c.raids_sobreviveu ?? 0}`);
  }
  const e = new EmbedBuilder().setTitle(`🦝 Infâmia — ${t.username}`).setColor(0x550044).setDescription(lines.join("\n"));
  return reply(msg, { embeds: [e] });
});

reg(["topinfamia", "topsalafrarios"], async (msg) => {
  const all = await db.query.players.findMany({ limit: 200 });
  const ranked = all
    .map(p => ({ p, score: calcInfamia(((p.inventory as any)?._inf_counters) as any) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
  if (ranked.length === 0) return reply(msg, "🦝 Ninguém tem infâmia ainda. Vai lá fazer estrago.");
  const lines = ranked.map((x, i) => {
    const t = infamiaTitulo(x.score);
    return `${i + 1}. ${t.emoji} **${x.p.username}** — ${x.score} pts (${t.titulo})`;
  });
  return reply(msg, { embeds: [new EmbedBuilder().setTitle("🏴‍☠️ Top 10 Salafrários").setColor(0x550044).setDescription(lines.join("\n"))] });
});

// ============ AJUDA PAGINADA ============

function _helpPage(title: string, color: number, desc: string, fields: Array<{ name: string; value: string }>): EmbedBuilder {
  const e = new EmbedBuilder().setTitle(title).setColor(color).setDescription(desc);
  if (fields.length) e.addFields(fields);
  return e;
}

async function _paginateHelp(msg: Message, pages: EmbedBuilder[]) {
  if (pages.length === 0) return;
  let idx = 0;
  const buildRow = (i: number) => new ActionRowBuilder<ButtonBuilder>().setComponents(
    new ButtonBuilder().setCustomId("hp_prev").setLabel("◀").setStyle(ButtonStyle.Secondary).setDisabled(i === 0),
    new ButtonBuilder().setCustomId("hp_page").setLabel(`${i + 1}/${pages.length}`).setStyle(ButtonStyle.Primary).setDisabled(true),
    new ButtonBuilder().setCustomId("hp_next").setLabel("▶").setStyle(ButtonStyle.Secondary).setDisabled(i >= pages.length - 1),
    new ButtonBuilder().setCustomId("hp_close").setLabel("✖").setStyle(ButtonStyle.Danger),
  );
  pages.forEach((p, i) => p.setFooter({ text: `Página ${i + 1} de ${pages.length} · sessão expira em 5min` }));
  const ch = msg.channel as TextChannel;
  const sent = await ch.send({ embeds: [pages[idx]!], components: [buildRow(idx)] }).catch(() => null);
  if (!sent) return;
  const collector = sent.createMessageComponentCollector({ componentType: ComponentType.Button, time: 5 * 60 * 1000 });
  collector.on("collect", async (i: any) => {
    if (i.user.id !== msg.author.id) {
      await i.reply({ content: "✋ Esse menu é de quem chamou. Use `!ajuda` por conta própria.", ephemeral: true }).catch(() => {});
      return;
    }
    if (i.customId === "hp_close") {
      await i.update({ components: [] }).catch(() => {});
      collector.stop();
      return;
    }
    if (i.customId === "hp_next") idx = Math.min(pages.length - 1, idx + 1);
    if (i.customId === "hp_prev") idx = Math.max(0, idx - 1);
    await i.update({ embeds: [pages[idx]!], components: [buildRow(idx)] }).catch(() => {});
  });
  collector.on("end", () => { sent.edit({ components: [] }).catch(() => {}); });
}

reg(["ajuda", "help", "comandos"], async (msg) => {
  const pages: EmbedBuilder[] = [];

  pages.push(_helpPage(
    "📖 1. Economia & Banco",
    0x2ecc71,
    "Dinheiro de bolso, banco, transferências e expediente diário. **Toda operação aqui é em `!`.**",
    [
      { name: "💰 Saldos", value: "`!saldo` · `!banco` · `!dep <v>` · `!sac <v>` · `!top` (ranking de fortuna)" },
      { name: "💸 PIX", value: "`!pix @user <valor>` — paga imposto sobre transferência (fica com `taxRate` do governo)" },
      { name: "🛠️ Trabalho diário", value: "`!work` (1h cd) · `!sal` (saca salário se tem profissão)" },
      { name: "🎁 Bônus periódicos", value: "`!day` (24h) · `!week` (7d) · `!bonus` (variado)" },
      { name: "📜 Crédito", value: "`!fiado @user <v> [dias]` · `!dividas` · `!pagar <id>`" },
    ],
  ));

  pages.push(_helpPage(
    "📖 2. Personagem & Profissão",
    0x9b59b6,
    "Sua identidade no servidor — RG, estado, gênero, lado político, profissão e estudos.",
    [
      { name: "🪪 Identidade", value: "`!perfil <UF> <cidade> <gen> <pol>` · `!rg [@user]` (vê o RG de alguém)" },
      { name: "👔 Profissões", value: "`!profs` (lista todas) · `!curso <nome>` (faz faculdade) · `!sal` (recebe salário ao se formar)" },
      { name: "📊 Painel", value: "`!dash` — visão completa do personagem" },
      { name: "⭐ Reputação & Karma", value: "`!rep [@user]` — vê reputação e karma" },
      { name: "🤔 Escolhas Morais", value: "`!moral` — dilema aleatório que afeta karma" },
    ],
  ));

  pages.push(_helpPage(
    "📖 3. Loja, Inventário & Mercado Negro",
    0xe67e22,
    "Tudo que você compra, carrega ou troca no submundo.",
    [
      { name: "🛒 Loja oficial", value: "`!loja` · `!comprar <item> [qtd]` · `!inv` (inventário)" },
      { name: "🕶️ Mercado Negro", value: "`!mn` · `!mncomprar <chave>` (acesso depende da ficha criminal)" },
      { name: "🛒 Mercado P2P", value: "`!mercado` · `!ofertar <itemKey> <qtd> <preço>` · `!comprar_oferta <id>` · `!retirar_oferta <id>` (taxa 5%)" },
    ],
  ));

  pages.push(_helpPage(
    "📖 4. Fazenda Vegetal & Animal",
    0x27ae60,
    "Plantio e criação de animais com slots, cultivo, alimentação e abate.",
    [
      { name: "🌾 Plantar e colher", value: "`!plantar <semente>` · `!plant` (vê plantios) · `!colher`" },
      { name: "🐄 Animais", value: "`!fazenda` · `!animal <esp> [nome]` · `!alimentar <id>` · `!abater <id>`" },
      { name: "🪴 Expandir slots", value: "`!comprarslot planta` · `!comprarslot animal`" },
    ],
  ));

  pages.push(_helpPage(
    "📖 5. Carros & Casa",
    0x3498db,
    "Compre carros, faça rachas, gerencie a manutenção. Tenha imóveis com renda passiva.",
    [
      { name: "🚗 Concessionária e garagem", value: "`!autos` · `!comprarauto <m>` · `!garagem` · `!consertar <id>` · `!vendercarro <id>`" },
      { name: "🏁 Racha", value: "`!racha <valor> @user`" },
      { name: "🏠 Casa", value: "`!casa` · `!casacomprar <tipo>` · `!casaupgrade <up>` · `!coletar` (renda da casa)" },
    ],
  ));

  pages.push(_helpPage(
    "📖 6. Saúde, Pet & Família",
    0xe74c3c,
    "Cuide do corpo, do coração e dos bichinhos.",
    [
      { name: "❤️ Saúde", value: "`!saude` · `!hospital` · `!seguro` · `!curar @user` · `!defender @user`" },
      { name: "🐾 Pet", value: "`!pet <esp> <nome>` · `!pets` · `!petfeed` · `!petsep`" },
      { name: "💍 Família", value: "`!casar @user` · `!divorciar`" },
    ],
  ));

  pages.push(_helpPage(
    "📖 7. Crime, Polícia & Combate",
    0xc0392b,
    "Vida fora da lei: pequenos crimes, roubos, prisão, fuga e duelos armados.",
    [
      { name: "🦹 Crime", value: "`!crime <tipo>` · `!roubar @user` · `!ficha` (sua ficha criminal) · `!fugir` (cadeia)" },
      { name: "👮 Polícia", value: "`!prender @user [min]` (depende da função)" },
      { name: "🔫 Armas e duelos", value: "`!arma loja|vender|equipada` · `!compraarma <k>` · `!duelo @user`" },
    ],
  ));

  pages.push(_helpPage(
    "📖 8. Gangue & Território",
    0x4b0082,
    "Crie facção, anexe territórios, monetize a renda passiva e remunere os membros.",
    [
      { name: "🏴 Vida na gangue", value: "`!gcriar <nome> <tag>` · `!ginvitar @user` · `!gaceitar` · `!grejeitar` · `!gconvites` · `!gbanir @user` · `!gmembros` · `!gsair` · `!ginfo` · `!glista`" },
      { name: "🏦 Tesouraria", value: "`!gbanco` (vê caixa) · `!gdepositar <v>` (qualquer membro doa) · `!gpagar @membro <v>` (só líder)" },
      { name: "🤝 Trampo da gangue", value: "`!gtrabalhar` (1h cd) — 70% pro membro, 30% pro caixa, bônus por território controlado e nível" },
      { name: "🗺️ Territórios", value: "`!terr` (mapa) · `!invadir <id>` (custa R$ 5.000, baseado em força+rep) · `!terrcoletar` (renda acumulada vai pro caixa)" },
      { name: "⚔️ Guerra de facções", value: "`!gguerra <tag|@membro>` (custo R$ 10.000 do caixa, só líder) · `!gpaz` (custo R$ 5.000 → vai pro inimigo) · `!gguerras` (lista guerras ativas)\nBônus em guerra: invadir território do inimigo custa metade e dá +10 rep." },
    ],
  ));

  pages.push(_helpPage(
    "📖 9. Empresa & Funcionários",
    0x16a085,
    "Abra empresa, contrate funcionários, abra capital na bolsa, anuncie e expanda.",
    [
      { name: "💼 CNPJ", value: "`!empresa` · `!ecriar \"<nome>\" <ramo> [desc]` · `!elista` · `!eextrato`" },
      { name: "👥 Equipe", value: "`!econtratar @user` · `!edemitir @user` · `!epagar` · `!etrabalhar` (funcionário, 1h cd, comissão 24h)" },
      { name: "📣 Operação", value: "`!eanunciar` · `!eexpandir` · `!esimular` · `!eipo <SYM> <preço>`" },
    ],
  ));

  pages.push(_helpPage(
    "📖 10. Cadeia Produtiva (Materiais → Fábrica → Produtos)",
    0x1abc9c,
    "Compre matérias-primas, construa fábrica, fabrique produtos do seu ramo e venda no balcão.",
    [
      { name: "🏭 Ramos & matérias", value: "`!ramos [ramo]` · `!ematerias <mat> [qtd]` · `!emateriais`" },
      { name: "🏗️ Fábrica", value: "`!econstruir` · `!efabrica` · `!eupgradefabrica` · `!efabricar <prodKey> [qtd]` · `!estoque [@dono]`" },
      { name: "📦 Catálogo de produtos", value: "`!eproduto add fab <prodKey> <preço>` · `!eproduto add \"<nome>\" <preço> <custo>` · `!eproduto rm <id>` · `!eproduto lista [@dono]` · `!ecomprar @dono <id> [qtd]` · `!usar <prodKey>`" },
    ],
  ));

  pages.push(_helpPage(
    "📖 11. Bolsa & Eventos Econômicos",
    0xf1c40f,
    "Pregão, ações, IPOs e ciclo macroeconômico.",
    [
      { name: "📊 Bolsa", value: "`!bolsa` · `!bcomprar <SYM> <q>` · `!bvender <SYM> <q>` · `!carteira` · `!cotacoes` · `!bdetalhe <SYM>`" },
      { name: "📈 Eventos", value: "`!evento` (status atual) · admin: `!evento inflacao|recessao|boom|deflacao`" },
    ],
  ));

  pages.push(_helpPage(
    "📖 12. Política, Eleições & Impeachment",
    0x2980b9,
    "Disputa pelo poder, leis, financiamento de campanha e queda do governante.",
    [
      { name: "🏛️ Estado", value: "`!governo` · `!leis`" },
      { name: "🗳️ Eleição", value: "admin: `!eleicao <presidente|prefeito>` · `!candidatar` · `!votar @user` · `!apurar`" },
      { name: "📜 Legislação", value: "`!proporlei <efeito> <nome>`" },
      { name: "💸 Compra de voto", value: "`!comprarvoto @user <valor>`" },
      { name: "⚖️ Impeachment", value: "`!impeachment <presidente|prefeito>` (30 ✅ em 3min confiscam orçamento)" },
    ],
  ));

  pages.push(_helpPage(
    "📖 13. Cassino & Loteria",
    0xff5e5e,
    "Aposte. Perca. Tente de novo.",
    [
      { name: "🎰 Cassino", value: "`!slot <v>` · `!roleta <cor> <v>` · `!dado <esc> <v> [n]` · `!bicho <1-25> <v>`" },
      { name: "🎟️ Loteria", value: "`!loteria` · `!bilhete <1-100>`" },
    ],
  ));

  pages.push(_helpPage(
    "🦝 14. SALAFRÁRIO — Tráfico de Drogas",
    0x556b2f,
    "Cadeia ilegal completa: planta → laboratório → processa → trafica → consome (vicia) → desintoxica.",
    [
      { name: "🌿 Catálogo", value: "`!drogas` (4 tipos: maconha, coca, ópio, metan)" },
      { name: "🧪 Laboratório", value: "`!construir_lab` (R$ 25k) · `!up_lab` · `!lab` (status)" },
      { name: "🌱 Plantio", value: "`!plantar_d <droga>` · `!plantios_d` · `!colher_d <id>` (rola batida policial!)" },
      { name: "⚗️ Processar", value: "`!processar <droga> [qtd]` · `!estoque_d` (estoque ilegal)" },
      { name: "🤝 Vender (P2P)", value: "`!traficar @user <prodKey> <qtd> [preço]` (8% chance de delação)" },
      { name: "🏪 Vender (NPC – boca)", value: "`!precos_d` (tabela fixa) · `!vender_npc <prodKey> [qtd]` (sem precisar de comprador, com cap diário e risco de denúncia)" },
      { name: "💊 Consumo & vício", value: "`!consumir_d <prodKey>` (efeito + vício) · `!desintoxicar` (clínica)" },
    ],
  ));

  pages.push(_helpPage(
    "💼 15. SALAFRÁRIO — Golpes & Pirâmides",
    0x8b4513,
    "Phishing, estelionato, produto falso e a clássica pirâmide financeira.",
    [
      { name: "💼 Golpes pontuais", value: "`!golpes` (catálogo) · `!golpe phishing|estelionato|falsoproduto [@alvo]`" },
      { name: "🏗️ Pirâmide financeira", value: "`!piramide criar <nome> <entrada>` · `!piramide entrar @dono` · `!piramide status [@dono]` · `!piramide encerrar` (dono some com o pote)" },
    ],
  ));

  pages.push(_helpPage(
    "🤝 16. SALAFRÁRIO — Suborno, Chantagem & Sequestro",
    0x550044,
    "Corrompa autoridades, junte sujeira contra inimigos e mantenha reféns.",
    [
      { name: "🤝 Suborno", value: "`!subornar policia|juiz|fiscal|prefeito [valor]` · `!subornos` (histórico)" },
      { name: "🤐 Chantagem", value: "`!fofoca @user` (cava sujeira, R$ 800) · `!chantagear @user <valor>` (extorque) · `!sigilo` (apaga sujeira contra você)" },
      { name: "🪤 Sequestro", value: "`!sequestrar @user <resgate>` (precisa arma) · `!resgatar @vitima` · `!fugir_seq` (25%) · `!sequestros` (seus reféns)" },
    ],
  ));

  pages.push(_helpPage(
    "📋 17. SALAFRÁRIO — Missões, Infâmia & Mercado P2P",
    0xff8800,
    "Tarefas diárias com recompensa, ranking dos maiores salafrários e mercado entre jogadores.",
    [
      { name: "📋 Missões diárias", value: "`!missoes` (4 sorteadas/dia) · `!resgatarmissao <key>`" },
      { name: "🦝 Infâmia", value: "`!infamia [@user]` (8 títulos: Cidadão de Bem → Imperador do Crime) · `!topinfamia`" },
      { name: "🛒 Mercado P2P", value: "`!mercado` · `!ofertar <itemKey> <qtd> <preço>` · `!comprar_oferta <id>` · `!retirar_oferta <id>`" },
    ],
  ));

  pages.push(_helpPage(
    "🧰 18. Outros (Lavagem, Imposto, Falência, Admin)",
    0x95a5a6,
    "Sistemas de apoio que mantêm o resto da economia rodando.",
    [
      { name: "🧼 Lavagem de dinheiro", value: "`!lavar <valor>`" },
      { name: "🧾 Imposto de Renda", value: "`!ir` (status) · `!sonegar`" },
      { name: "⚖️ Falência", value: "`!falir` · `!status` · `!checkfalencia`" },
      { name: "🛠️ Admin", value: "`!adm dar|tirar|reset @user [v]`" },
    ],
  ));

  return _paginateHelp(msg, pages);
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
