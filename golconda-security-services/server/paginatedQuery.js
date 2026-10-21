export const SUPABASE_READ_PAGE_SIZE = 500;

/** Read every row from a stable, ordered Supabase query without relying on the API row cap. */
export async function readAllRows(queryFactory, { pageSize = SUPABASE_READ_PAGE_SIZE } = {}) {
  if (typeof queryFactory !== "function") throw new TypeError("A query factory is required.");
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000) {
    throw new RangeError("Page size must be between 1 and 1000 rows.");
  }

  const rows = [];
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await queryFactory().range(offset, offset + pageSize - 1);
    if (error) throw error;
    if (!Array.isArray(data)) throw new Error("Paginated database query returned an invalid result.");
    rows.push(...data);
    if (data.length < pageSize) return rows;
  }
}
