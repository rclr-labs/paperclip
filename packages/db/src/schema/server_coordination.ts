import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Instance-level registry of live server processes that share this database.
 *
 * Each process registers its boot ID on startup and renews `expiresAt` while
 * it runs. Run ownership (`heartbeat_runs.controller_boot_id`,
 * `native_run_finalizations.controller_boot_id`) names a boot ID; this row
 * says which host that boot runs on and whether it is still alive. A numeric
 * PID is only meaningful when the owner runs on the same host.
 *
 * Holds no company or user data, so it is not company-scoped.
 */
export const serverInstances = pgTable(
  "server_instances",
  {
    bootId: text("boot_id").primaryKey(),
    hostname: text("hostname").notNull(),
    pid: integer("pid").notNull(),
    processStartedAt: timestamp("process_started_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    renewedAt: timestamp("renewed_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    expiresAtIdx: index("server_instances_expires_at_idx").on(table.expiresAt),
  }),
);

/**
 * Named instance-level leases, such as the heartbeat scheduler leader.
 * `generation` increases on every change of holder and fences stale leaders.
 */
export const serverLeases = pgTable("server_leases", {
  name: text("name").primaryKey(),
  holderBootId: text("holder_boot_id").notNull(),
  generation: integer("generation").notNull().default(1),
  acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull().defaultNow(),
  renewedAt: timestamp("renewed_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});
