import { pgTable, text, integer, bigint, real, boolean, timestamp, serial, jsonb } from "drizzle-orm/pg-core";

export const gangs = pgTable("gangs", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  tag: text("tag").notNull().unique(),
  leaderId: text("leader_id").notNull(),
  bankBalance: bigint("bank_balance", { mode: "number" }).notNull().default(0),
  reputation: integer("reputation").notNull().default(0),
  memberCount: integer("member_count").notNull().default(1),
  isAtWar: boolean("is_at_war").notNull().default(false),
  warTarget: text("war_target"),
  warStarted: timestamp("war_started"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const territories = pgTable("territories", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  controlledBy: text("controlled_by"),
  passiveIncome: bigint("passive_income", { mode: "number" }).notNull().default(500),
  defenseBonus: real("defense_bonus").notNull().default(1.0),
  lastCollected: timestamp("last_collected"),
});

export type Gang = typeof gangs.$inferSelect;
export type Territory = typeof territories.$inferSelect;
