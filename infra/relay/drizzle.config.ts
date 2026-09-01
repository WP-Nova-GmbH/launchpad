import { defineConfig } from "drizzle-kit";

/**
 * Used by `drizzle-kit migrate` on self-hosted relays (infra/hetzner), where
 * migrations apply directly to the host's Postgres instead of through the
 * Alchemy deploy. Schema, output directory, and migrations table mirror the
 * Alchemy wiring in src/db.ts; keep them in sync.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/persistence/schema.ts",
  out: "./migrations/postgres",
  migrations: { table: "relay_migrations" },
  dbCredentials: { url: process.env.RELAY_DATABASE_URL ?? "" },
});
