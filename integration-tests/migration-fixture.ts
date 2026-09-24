import { randomUUID } from "node:crypto";

const knex = require("knex");

export async function migrationStatements(migration: any): Promise<string[]> {
  const statements: string[] = [];
  await migration.prototype.up.call({
    addSql: (sql: string) => statements.push(sql),
  });
  return statements;
}

export async function applyMigration(db: any, migration: any) {
  for (const sql of await migrationStatements(migration)) await db.raw(sql);
}

/** Deliberately never reads DATABASE_URL or a production connection fallback. */
export async function withMigrationFixture(
  explicit: string | undefined,
  run: (db: any) => Promise<void>
) {
  if (!explicit)
    throw new Error("Explicit isolated migration database required");
  const url = new URL(explicit);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    !/^\/gp_(launch|incoming|order_promises|order_publications)$/.test(
      url.pathname
    )
  )
    throw new Error("Only a local migration fixture database is allowed");

  const schema = `gp_migration_${randomUUID().replace(/-/g, "")}`;
  const admin = knex({ client: "pg", connection: explicit });
  const db = knex({ client: "pg", connection: explicit, searchPath: [schema] });
  try {
    await admin.raw(`create schema ${schema}`);
    await run(db);
  } finally {
    await db.destroy();
    try {
      await admin.raw(`drop schema if exists ${schema} cascade`);
    } finally {
      await admin.destroy();
    }
  }
}
