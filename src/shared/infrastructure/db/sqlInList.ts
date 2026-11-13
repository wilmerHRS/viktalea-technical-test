import { sql, type SQL } from 'drizzle-orm';

/**
 * Inserta constantes del esquema en el SQL de la migración. Los datos de las consultas siguen
 * parametrizados.
 */
export const sqlInList = (values: readonly string[]): SQL =>
  sql`(${sql.join(
    values.map((value) => sql.raw(`'${value.replaceAll("'", "''")}'`)),
    sql`, `,
  )})`;
