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
  logTransaction,
  cooldownLeft,
  formatCooldown,
  applyTax,
  PROFESSIONS,
  calcSalary,
  type ProfessionKey,
} from "./systems/economy.js";
import { SHOP_ITEMS, CROPS, WEAPONS, BR_STATES, POLITICAL_SIDES, GENDERS, PET_SPECIES } from "./systems/shop.js";
import { CAR_MODELS, depreciate, repairCost, MAINTENANCE_INTERVAL_MS } from "./systems/cars.js";
import { HOUSE_TYPES, HOUSE_UPGRADES } from "./systems/houses.js";
import { ANIMAL_SPECIES, HUNGER_DECAY_PER_HOUR } from "./systems/farmAnimals.js";
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
  if (cd > 0) return reply(msg, `⏳ Aguarde ${formatCooldown(cd)}.`);
  const base = Math.floor(Math.random() * 300 + 100);
  const amount = Math.floor(await applyTax(base));
  await updatePlayer(p.discordId, { balance: p.balance + amount, lastWork: new Date() });
  await logTransaction(null, p.discordId, amount, "work", "Bico");
  return reply(msg, `💼 Bico feito! Ganhou ${formatMoney(amount)}.`);
});

reg(["sal", "salario"], async (msg) => {
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  if (!p.profession || !p.isCertified) return reply(msg, "❌ Sem profissão certificada. Use `!profs`.");
  if (isJailed(p)) return reply(msg, "❌ Você está preso!");
  const cd = cooldownLeft(p.lastSalary, 8 * 60 * 60 * 1000);
  if (cd > 0) return reply(msg, `⏳ Próximo salário em ${formatCooldown(cd)}.`);
  const prof = p.profession as ProfessionKey;
  const salary = await calcSalary(prof);
  const net = await applyTax(salary);
  await updatePlayer(p.discordId, { balance: p.balance + net, lastSalary: new Date() });
  await logTransaction(null, p.discordId, net, "salary", `Salário ${PROFESSIONS[prof].name}`);
  return reply(msg, `${PROFESSIONS[prof].emoji} Salário recebido: ${formatMoney(net)} (bruto ${formatMoney(salary)}).`);
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

// ============ PROFISSÕES ============
reg(["profs", "profissoes"], async (msg) => {
  const e = new EmbedBuilder().setTitle("👔 Profissões").setColor(0x00aaff);
  for (const [k, prof] of Object.entries(PROFESSIONS)) {
    e.addFields({ name: `${prof.emoji} ${prof.name}`, value: `Curso: ${formatMoney(prof.courseCost)} | Salário base: ${formatMoney(prof.baseSalary)}\n\`!curso ${k}\``, inline: false });
  }
  return reply(msg, { embeds: [e] });
});

reg(["curso"], async (msg, args) => {
  const k = args[0]?.toLowerCase() as ProfessionKey;
  if (!k || !(PROFESSIONS as any)[k]) return reply(msg, "❌ Uso: `!curso <profissao>`. Veja `!profs`.");
  const prof = PROFESSIONS[k];
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  if (p.isTraining) return reply(msg, "❌ Já está em curso.");
  if (p.balance < prof.courseCost) return reply(msg, `❌ Custa ${formatMoney(prof.courseCost)}.`);
  await removeMoney(p.discordId, prof.courseCost);
  const end = new Date(Date.now() + 30 * 60 * 1000);
  await updatePlayer(p.discordId, { isTraining: true, trainingEnd: end, trainingFor: k });
  return reply(msg, `📚 Curso de **${prof.name}** iniciado. Use \`!treinar\` em 30 min.`);
});

reg(["treinar"], async (msg) => {
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  if (!p.isTraining || !p.trainingFor) return reply(msg, "❌ Não está em curso.");
  if (p.trainingEnd && new Date() < p.trainingEnd) return reply(msg, `⏳ Faltam ${formatCooldown(p.trainingEnd.getTime() - Date.now())}.`);
  const certs = [...(p.certifications ?? [])];
  if (!certs.includes(p.trainingFor)) certs.push(p.trainingFor);
  await updatePlayer(p.discordId, { isTraining: false, trainingEnd: null, trainingFor: null, profession: p.trainingFor, isCertified: true, certifications: certs });
  return reply(msg, `🎓 Você se certificou em **${PROFESSIONS[p.trainingFor as ProfessionKey].name}**! Use \`!sal\`.`);
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
  return reply(msg, `🌱 ${crop.emoji} ${crop.name} plantado! Pronto em ${minutes} min${inv["fertilizante"] !== undefined ? " (com fertilizante)" : ""}.`);
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
  for (const pl of harvestable) {
    const crop = CROPS[pl.crop]!;
    const earn = Math.floor(Math.random() * (crop.sellMax - crop.sellMin) + crop.sellMin);
    total += earn;
    await db.update(schema.plots).set({ harvested: true }).where(eq(schema.plots.id, pl.id));
  }
  const net = await applyTax(total);
  await addMoney(p.discordId, net);
  await logTransaction(null, p.discordId, net, "harvest", `Colheita ${harvestable.length}`);
  return reply(msg, `🌾 Colheu ${harvestable.length} plantação(ões) por ${formatMoney(net)}.`);
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
  const exists = await db.query.gangs.findFirst({ where: eq(schema.gangs.name, nome) });
  if (exists) return reply(msg, "❌ Nome já existe.");
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
  await db.insert(schema.gangInvites).values({ gangId: p.gangId, targetId: tid, inviterId: p.discordId });
  return reply(msg, `📨 Convite enviado para <@${tid}>. Ele deve usar \`!gaceitar\` ou \`!grejeitar\`.`);
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
  await removeMoney(p.discordId, s.buyPrice);
  await db.insert(schema.farmAnimals).values({ ownerId: p.discordId, species: sp, name: nome, readyAt: new Date(Date.now() + s.growHours * 60 * 60 * 1000) });
  return reply(msg, `${s.emoji} Comprou ${s.name}${nome ? ` "${nome}"` : ""}. Pronto em ${s.growHours}h.`);
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
reg(["casar"], async (msg, args) => {
  const tid = getMentionId(msg, args, 0);
  if (!tid || tid === msg.author.id) return reply(msg, "❌ Uso: `!casar @user`");
  const p = await getOrCreatePlayer(msg.author.id, msg.author.username);
  const t = await getPlayer(tid);
  if (!t) return reply(msg, "❌ Alvo inválido.");
  if (p.partnerId || t.partnerId) return reply(msg, "❌ Alguém já está casado.");
  await updatePlayer(p.discordId, { partnerId: tid, marriedAt: new Date() });
  await updatePlayer(tid, { partnerId: p.discordId, marriedAt: new Date() });
  return reply(msg, `💍 ${msg.author.username} e ${t.username} estão casados!`);
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

// ============ TOP / HELP ============
reg(["top", "ranking"], async (msg) => {
  const top = await db.query.players.findMany({ orderBy: [desc(schema.players.balance)], limit: 10 });
  return reply(msg, "🏆 **Top 10 mais ricos**\n" + top.map((p, i) => `${i + 1}. ${p.username} — ${formatMoney(p.balance + p.bankBalance)}`).join("\n"));
});

reg(["ajuda", "help", "comandos"], async (msg) => {
  const e1 = new EmbedBuilder().setTitle("📖 Comandos — Prefixo `!`").setColor(0x5865f2)
    .setDescription("Todos os comandos usam **!** no início. Não tem mais slash.")
    .addFields(
      { name: "💰 Economia", value: "`!saldo` `!banco` `!dep <v>` `!sac <v>` `!pix @user <v>` `!work` `!sal`" },
      { name: "🎁 Recompensas", value: "`!day` `!week` `!bonus`" },
      { name: "🛒 Loja", value: "`!loja` `!comprar <item> [qtd]` `!inv`" },
      { name: "🪪 Personagem", value: "`!perfil <UF> <cidade> <gen> <pol>` `!rg [@user]`" },
      { name: "👔 Profissão", value: "`!profs` `!curso <nome>` `!treinar` `!sal`" },
      { name: "❤️ Saúde", value: "`!saude` `!hospital` `!seguro` `!curar @user` `!defender @user`" },
      { name: "🦹 Crime", value: "`!crime <tipo>` `!roubar @user` `!ficha` `!prender @user [min]` `!fugir`" },
      { name: "🌾 Fazenda Vegetal", value: "`!plantar <semente>` `!plant` `!colher`" },
      { name: "🐄 Fazenda Animal", value: "`!fazenda` `!animal <esp> [nome]` `!alimentar <id>` `!abater <id>`" },
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
  return msg.reply({ embeds: [e1, e2] }).catch(() => {});
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
