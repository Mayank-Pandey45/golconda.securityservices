import assert from "node:assert/strict";
import { test } from "node:test";
import { readAllRows, SUPABASE_READ_PAGE_SIZE } from "./paginatedQuery.js";

test("Supabase reads continue past the default row cap with non-overlapping ranges", async () => {
  const source = Array.from({ length: 1207 }, (_, id) => ({ id }));
  const ranges = [];
  const rows = await readAllRows(() => ({
    range(from, to) {
      ranges.push([from, to]);
      return Promise.resolve({ data: source.slice(from, to + 1), error: null });
    },
  }));

  assert.equal(SUPABASE_READ_PAGE_SIZE, 500);
  assert.deepEqual(ranges, [[0, 499], [500, 999], [1000, 1499]]);
  assert.equal(rows.length, source.length);
  assert.equal(rows.at(-1).id, 1206);
});

test("Supabase pagination stops on a short page and propagates database errors", async () => {
  let calls = 0;
  const rows = await readAllRows(() => ({
    range() {
      calls += 1;
      return Promise.resolve({ data: [{ id: calls }], error: null });
    },
  }), { pageSize: 3 });
  assert.equal(calls, 1);
  assert.deepEqual(rows, [{ id: 1 }]);

  await assert.rejects(readAllRows(() => ({ range: async () => ({ data: null, error: new Error("database unavailable") }) })), /database unavailable/);
});
