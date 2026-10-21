import assert from "node:assert/strict";
import { test } from "node:test";
import { getPublicProfileDocuments } from "./publicProfile.js";

test("public profile files are filtered to approved records and private objects use signed URLs", async () => {
  const credentialedUrl = new URL("https://example.com/document.pdf");
  credentialedUrl.username = "test-user";
  credentialedUrl.password = "test-password";
  const calls = [];
  const records = [
    { id: 1, title: "Approved brochure", description: "Public material", is_public: true, storage_path: "approved/brochure.pdf", category: "Brochure", media_type: "pdf", mime_type: "application/pdf" },
    { id: 2, title: "Private employee record", description: "Confidential", is_public: false, storage_path: "private/employee.pdf", category: "Other", media_type: "pdf" },
    { id: 3, title: "Approved external image", description: "Team event", is_public: true, file_url: "https://example.com/team.webp", category: "Company Activities", media_type: "image" },
    { id: 4, title: "Unsafe link", is_public: true, file_url: "javascript:alert(1)", category: "Other", media_type: "document" },
    { id: 5, title: "Credential URL", is_public: true, file_url: credentialedUrl.href, category: "Other", media_type: "document" },
  ];
  const query = {
    select(columns) { calls.push(["select", columns]); return this; },
    eq(field, value) { calls.push(["eq", field, value]); this.filter = { field, value }; return this; },
    order() { return this; },
    then(resolve, reject) { return Promise.resolve({ data: records.filter(row => row[this.filter.field] === this.filter.value), error: null }).then(resolve, reject); },
  };
  const database = {
    from(table) { assert.equal(table, "profile_docs"); return query; },
    storage: { from(bucket) { assert.equal(bucket, "company-profile"); return { async createSignedUrl(path, expiresIn) { calls.push(["sign", path, expiresIn]); return { data: { signedUrl: `https://signed.example/${path}?token=opaque` }, error: null }; } }; } },
  };

  const documents = await getPublicProfileDocuments(database);
  assert.deepEqual(documents.map(item => item.id), [1, 3]);
  assert.equal(documents[0].file_url, "https://signed.example/approved/brochure.pdf?token=opaque");
  assert.equal(documents[1].file_url, "https://example.com/team.webp");
  assert.equal("storage_path" in documents[0], false);
  assert.ok(calls.some(call => call[0] === "eq" && call[1] === "is_public" && call[2] === true));
  assert.ok(calls.some(call => call[0] === "sign" && call[1] === "approved/brochure.pdf" && call[2] === 3600));
});

test("public profile does not return rows whose private storage file cannot be signed", async () => {
  const query = {
    select() { return this; },
    eq() { return this; },
    order() { return this; },
    then(resolve, reject) { return Promise.resolve({ data: [{ id: 1, title: "Missing file", storage_path: "missing.pdf", is_public: true }], error: null }).then(resolve, reject); },
  };
  const database = { from() { return query; }, storage: { from() { return { async createSignedUrl() { return { data: null, error: new Error("not found") }; } }; } } };
  assert.deepEqual(await getPublicProfileDocuments(database), []);
});
