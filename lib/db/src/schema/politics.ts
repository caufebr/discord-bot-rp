import { pgTable, text, integer, boolean, timestamp, serial, jsonb } from "drizzle-orm/pg-core";

export const elections = pgTable("elections", {
  id: serial("id").primaryKey(),
  position: text("position").notNull(),
  candidates: jsonb("candidates").notNull().default([]),
  votes: jsonb("votes").notNull().default({}),
  isActive: boolean("is_active").notNull().default(false),
  startTime: timestamp("start_time"),
  endTime: timestamp("end_time"),
  winnerId: text("winner_id"),
});

export const government = pgTable("government", {
  id: integer("id").primaryKey().default(1),
  presidentId: text("president_id"),
  mayorId: text("mayor_id"),
  activeLaws: jsonb("active_laws").notNull().default([]),
  taxMultiplier: integer("tax_multiplier").notNull().default(100),
  crimeMultiplier: integer("crime_multiplier").notNull().default(100),
  policeSalaryMultiplier: integer("police_salary_multiplier").notNull().default(100),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const laws = pgTable("laws", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  effect: text("effect").notNull(),
  proposedBy: text("proposed_by").notNull(),
  approvedAt: timestamp("approved_at"),
  isActive: boolean("is_active").notNull().default(true),
});

export type Election = typeof elections.$inferSelect;
export type Government = typeof government.$inferSelect;
export type Law = typeof laws.$inferSelect;
