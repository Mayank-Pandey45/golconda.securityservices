import test from 'node:test';
import assert from 'node:assert/strict';
import { scrollToPublicSection } from './publicNavigation.js';
test('cross-page homepage links scroll after React content has rendered', () => {
  let scrolled = false;
  const document = { getElementById(id) { assert.equal(id, 'contact'); return { scrollIntoView(options) { assert.equal(options.block, 'start'); scrolled = true; } }; } };
  assert.equal(scrollToPublicSection({ hash: '#contact', document }), true);
  assert.equal(scrolled, true);
});
test('missing and malformed public fragments are harmless', () => {
  const document = { getElementById: () => null };
  for (const hash of ['', '#missing', '#%ZZ']) assert.equal(scrollToPublicSection({ hash, document }), false);
});
