import { pgTable, text, integer, bigint, boolean, timestamp, serial } from "drizzle-orm/pg-core";

export const gangInvites = pgTable("gang_invites", {
  id: serial("id").primaryKey(),
  gangId: text("gang_id").notNull(),
  targetId: text("target_id").notNull(),
  inviterId: text("inviter_id").notNull(),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const pets = pgTable("pets", {
  id: serial("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  name: text("name").notNull(),
  species: text("species").notNull(),
  hunger: integer("hunger").notNull().default(100),
  alive: boolean("alive").notNull().default(true),
  lastFed: timestamp("last_fed").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type Pet = typeof pets.$inferSelect;
export type GangInvite = typeof gangInvites.$inferSelect;
