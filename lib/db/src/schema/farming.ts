import { pgTable, text, integer, bigint, timestamp, serial, boolean } from "drizzle-orm/pg-core";

export const plots = pgTable("plots", {
  id: serial("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  crop: text("crop").notNull(),
  plantedAt: timestamp("planted_at").notNull().defaultNow(),
  readyAt: timestamp("ready_at").notNull(),
  harvested: boolean("harvested").notNull().default(false),
});

export type Plot = typeof plots.$inferSelect;
export type InsertPlot = typeof plots.$inferInsert;
