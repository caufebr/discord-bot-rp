import { pgTable, text, integer, bigint, real, boolean, timestamp, serial, jsonb } from "drizzle-orm/pg-core";

export const companies = pgTable("companies", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  ownerId: text("owner_id").notNull(),
  sector: text("sector").notNull(),
  description: text("description"),
  employees: jsonb("employees").notNull().default([]),
  revenue: bigint("revenue", { mode: "number" }).notNull().default(0),
  expenses: bigint("expenses", { mode: "number" }).notNull().default(0),
  stockSymbol: text("stock_symbol").unique(),
  totalShares: integer("total_shares").notNull().default(1000),
  availableShares: integer("available_shares").notNull().default(1000),
  sharePrice: bigint("share_price", { mode: "number" }).notNull().default(100),
  marketCap: bigint("market_cap", { mode: "number" }).notNull().default(100000),
  isPublic: boolean("is_public").notNull().default(false),
  priceHistory: jsonb("price_history").notNull().default([]),
  level: integer("level").notNull().default(1),
  reputation: integer("reputation").notNull().default(50),
  lastPayroll: timestamp("last_payroll"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const stockPortfolios = pgTable("stock_portfolios", {
  id: serial("id").primaryKey(),
  playerId: text("player_id").notNull(),
  companyId: text("company_id").notNull(),
  shares: integer("shares").notNull().default(0),
  avgBuyPrice: bigint("avg_buy_price", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const stockTransactions = pgTable("stock_transactions", {
  id: serial("id").primaryKey(),
  playerId: text("player_id").notNull(),
  companyId: text("company_id").notNull(),
  type: text("type").notNull(),
  shares: integer("shares").notNull(),
  pricePerShare: bigint("price_per_share", { mode: "number" }).notNull(),
  total: bigint("total", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const worldEvents = pgTable("world_events", {
  id: serial("id").primaryKey(),
  type: text("type").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  effect: jsonb("effect").notNull().default({}),
  isActive: boolean("is_active").notNull().default(true),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  endsAt: timestamp("ends_at"),
});

export type Company = typeof companies.$inferSelect;
export type StockPortfolio = typeof stockPortfolios.$inferSelect;
export type StockTransaction = typeof stockTransactions.$inferSelect;
export type WorldEvent = typeof worldEvents.$inferSelect;
