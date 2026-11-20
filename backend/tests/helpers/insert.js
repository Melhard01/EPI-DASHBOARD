/**
 * Test helper: turns a recorded `INSERT INTO <schema>.<table> (cols…) VALUES ($1…)`
 * statement and its parameters into { schema, table, row: { column: value } }.
 * Lets tests assert exactly WHICH table a form wrote to and what it stored.
 */
export function parseInsert(query) {
  const match = /^INSERT INTO ([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*) \(([^)]*)\) VALUES \(([^)]*)\)$/.exec(query.text);
  if (!match) return null;
  const [, schema, table, columnList, placeholderList] = match;
  const columns = columnList.split(', ');
  const placeholders = placeholderList.split(', ');
  const row = {};
  columns.forEach((column, i) => {
    row[column] = query.params[Number(placeholders[i].slice(1)) - 1];
  });
  return { schema, table, columns, row };
}

/** Only the INSERTs into submission tables (ignores rate-limit counters etc.). */
export function submissionInserts(queries) {
  return queries.map(parseInsert).filter((p) => p && p.table.endsWith('_submissions'));
}
