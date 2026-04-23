import { pgTable, text, integer, bigint, real, boolean, timestamp, serial, jsonb } from "drizzle-orm/pg-core";

export const cars = pgTable("cars", {
  id: serial("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  model: text("model").notNull(),
  category: text("category").notNull(),
  basePrice: bigint("base_price", { mode: "number" }).notNull(),
  currentValue: bigint("current_value", { mode: "number" }).notNull(),
  condition: integer("condition").notNull().default(100),
  lastMaintenance: timestamp("last_maintenance").notNull().defaultNow(),
  km: integer("km").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const houses = pgTable("houses", {
  id: serial("id").primaryKey(),
  ownerId: text("owner_id").notNull().unique(),
  type: text("type").notNull().default("barraco"),
  level: integer("level").notNull().default(1),
  upgrades: jsonb("upgrades").notNull().default({}).$type<Record<string, number>>(),
  baseValue: bigint("base_value", { mode: "number" }).notNull().default(5000),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const farmAnimals = pgTable("farm_animals", {
  id: serial("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  species: text("species").notNull(),
  name: text("name"),
  hunger: integer("hunger").notNull().default(100),
  weight: integer("weight").notNull().default(10),
  alive: boolean("alive").notNull().default(true),
  readyAt: timestamp("ready_at"),
  lastFed: timestamp("last_fed").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const debts = pgTable("debts", {
  id: serial("id").primaryKey(),
  debtorId: text("debtor_id").notNull(),
  creditorId: text("creditor_id"),
  originalAmount: bigint("original_amount", { mode: "number" }).notNull(),
  remainingAmount: bigint("remaining_amount", { mode: "number" }).notNull(),
  interestRate: real("interest_rate").notNull().default(0.05),
  dueAt: timestamp("due_at").notNull(),
  paid: boolean("paid").notNull().default(false),
  defaulted: boolean("defaulted").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const seasons = pgTable("seasons", {
  id: integer("id").primaryKey().default(1),
  number: integer("number").notNull().default(1),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  endsAt: timestamp("ends_at").notNull(),
});

export type Car = typeof cars.$inferSelect;
export type House = typeof houses.$inferSelect;
export type FarmAnimal = typeof farmAnimals.$inferSelect;
export type Debt = typeof debts.$inferSelect;
export type Season = typeof seasons.$inferSelect;
