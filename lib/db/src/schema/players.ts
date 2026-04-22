import { pgTable, text, integer, bigint, real, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";

export const players = pgTable("players", {
  discordId: text("discord_id").primaryKey(),
  username: text("username").notNull(),
  balance: bigint("balance", { mode: "number" }).notNull().default(1000),
  bankBalance: bigint("bank_balance", { mode: "number" }).notNull().default(0),
  health: integer("health").notNull().default(100),
  maxHealth: integer("max_health").notNull().default(100),
  isHospitalized: boolean("is_hospitalized").notNull().default(false),
  hospitalizationEnd: timestamp("hospitalization_end"),
  isDead: boolean("is_dead").notNull().default(false),
  deathEnd: timestamp("death_end"),
  profession: text("profession"),
  professionLevel: integer("profession_level").notNull().default(0),
  isTraining: boolean("is_training").notNull().default(false),
  trainingEnd: timestamp("training_end"),
  trainingFor: text("training_for"),
  isCertified: boolean("is_certified").notNull().default(false),
  gangId: text("gang_id"),
  gangRank: text("gang_rank"),
  isJailed: boolean("is_jailed").notNull().default(false),
  jailEnd: timestamp("jail_end"),
  wantedLevel: integer("wanted_level").notNull().default(0),
  criminalRecord: integer("criminal_record").notNull().default(0),
  lastWork: timestamp("last_work"),
  lastCrime: timestamp("last_crime"),
  lastRob: timestamp("last_rob"),
  reputation: integer("reputation").notNull().default(0),
  insurance: boolean("insurance").notNull().default(false),
  insuranceEnd: timestamp("insurance_end"),
  lastSalary: timestamp("last_salary"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type Player = typeof players.$inferSelect;
export type InsertPlayer = typeof players.$inferInsert;
