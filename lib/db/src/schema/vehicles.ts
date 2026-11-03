import { createInsertSchema } from "drizzle-zod";
import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const vehiclesTable = pgTable("vehicles", {
  registrationNumber: text("registration_number").primaryKey(),
  onSite: boolean("on_site").notNull().default(false),
  keysStatus: text("keys_status").notNull().default("unknown"),
  addedAt: timestamp("added_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  onSiteAt: timestamp("on_site_at", { withTimezone: true }),
});

export const insertVehicleSchema = createInsertSchema(vehiclesTable).omit({
  addedAt: true,
  updatedAt: true,
});

export type InsertVehicle = z.infer<typeof insertVehicleSchema>;
export type Vehicle = typeof vehiclesTable.$inferSelect;
