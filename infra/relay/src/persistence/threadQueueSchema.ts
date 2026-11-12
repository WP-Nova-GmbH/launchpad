import { sql } from "drizzle-orm";
import { pgTable, varchar, integer, jsonb, check } from "drizzle-orm/pg-core";

/** Latest applied queue only; chat history pagination never decides queue controls. */
export const relayThreadCurrentQueues = pgTable(
  "relay_thread_current_queues",
  {
    threadId: varchar("thread_id", { length: 191 }).primaryKey(),
    cursor: integer("cursor").notNull(),
    queueJson: jsonb("queue_json").notNull(),
  },
  (table) => [check("relay_thread_current_queues_cursor", sql`${table.cursor} >= 0`)],
);
