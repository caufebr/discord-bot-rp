import { pgTable, text, integer, bigint, real, timestamp, serial } from "drizzle-orm/pg-core";

export const worldEconomy = pgTable("world_economy", {
  id: integer("id").primaryKey().default(1),
  inflation: real("inflation").notNull().default(1.0),
  gdp: bigint("gdp", { mode: "number" }).notNull().default(1000000),
  taxRate: real("tax_rate").notNull().default(0.1),
  bankTaxRate: real("bank_tax_rate").notNull().default(0.02),
  incomeTaxRate: real("income_tax_rate").notNull().default(0.15),
  totalMoneySupply: bigint("total_money_supply", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const marketPrices = pgTable("market_prices", {
  id: serial("id").primaryKey(),
  item: text("item").notNull().unique(),
  basePrice: bigint("base_price", { mode: "number" }).notNull(),
  currentPrice: bigint("current_price", { mode: "number" }).notNull(),
  demand: real("demand").notNull().default(1.0),
  supply: real("supply").notNull().default(1.0),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const transactions = pgTable("transactions", {
  id: serial("id").primaryKey(),
  fromId: text("from_id"),
  toId: text("to_id"),
  amount: bigint("amount", { mode: "number" }).notNull(),
  type: text("type").notNull(),
  description: text("description"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type WorldEconomy = typeof worldEconomy.$inferSelect;
export type MarketPrice = typeof marketPrices.$inferSelect;
export type Transaction = typeof transactions.$inferSelect;
