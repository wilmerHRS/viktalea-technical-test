import { sql, type SQL } from 'drizzle-orm';

/** Inline schema constants, preserving migration SQL. Runtime query inputs stay parameterized. */
export const sqlInList = (values: readonly string[]): SQL =>
  sql`(${sql.join(values.map((value) => sql.raw(`'${value.replaceAll("'", "''")}'`)), sql`, `)})`;
