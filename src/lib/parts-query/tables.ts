type Cell = string | number | boolean | null;
export type QueryTables = Record<string, { columns: Record<string, string>; rows: Record<string, Cell>[] }>;
const identifier = (value: string) => '"' + value.replaceAll('"', '""') + '"';
function literal(value: Cell): string {
  if (value === null) return 'NULL';
  if (typeof value === 'string') return "'" + value.replaceAll("'", "''") + "'";
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (!Number.isFinite(value)) throw new Error('Non-finite value in query projection');
  return String(value);
}

/** Small typed snapshot; SQL literals are escaped, and empty tables retain their schema. */
export async function loadTables(connection: { query(sql: string): unknown }, tables: QueryTables) {
  await connection.query('BEGIN TRANSACTION');
  try {
    for (const [name, table] of Object.entries(tables)) {
      const columns = Object.keys(table.columns);
      const schema = columns.map(column => {
        const type = table.columns[column];
        if (!['VARCHAR', 'INTEGER', 'DOUBLE', 'BOOLEAN', 'BIGINT'].includes(type)) throw new Error(`Unsupported projection type: ${type}`);
        return `${identifier(column)} ${type}`;
      });
      await connection.query(`CREATE TABLE ${identifier(name)} (${schema.join(', ')})`);
      for (let offset = 0; offset < table.rows.length; offset += 200) {
        const values = table.rows.slice(offset, offset + 200).map(row =>
          '(' + columns.map(column => literal(row[column] ?? null)).join(',') + ')');
        await connection.query(`INSERT INTO ${identifier(name)} VALUES ${values.join(',')}`);
      }
    }
    await connection.query('COMMIT');
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  }
}
