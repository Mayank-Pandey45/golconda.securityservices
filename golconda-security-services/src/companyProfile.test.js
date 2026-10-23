import { createServer as createHttpServer } from "node:http";
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

test('dedicated profile renders approved document metadata, images, videos and home links', async () => {
  const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: { server: createHttpServer() } }, appType: 'custom' });
  try {
    const { default: CompanyProfile } = await server.ssrLoadModule('/src/CompanyProfile.jsx');
    const documents = ['document', 'image', 'video'].map((media_type, id) => ({ id, media_type, title: 'Approved ' + media_type, description: 'Published description', category: 'Public category', file_url: 'https://example.com/public/' + id }));
    const html = renderToStaticMarkup(React.createElement(CompanyProfile, { services: [{ id: 'service', title: 'Security service', description: 'Current catalogue' }], documents }));
    assert.match(html, /<h1>/);
    assert.ok(html.includes('href="/"') && html.includes('Return to home'));
    assert.ok(html.includes('href="/#contact"'));
    for (const type of ['document', 'image', 'video']) assert.ok(html.includes('Approved ' + type));
    assert.match(html, /Public category/);
    assert.match(html, /Published description/);
    assert.match(html, /<video[^>]+controls/);
    assert.match(html, /<img[^>]+loading="lazy"/);
    const empty = renderToStaticMarkup(React.createElement(CompanyProfile));
    assert.match(empty, /No approved company documents/);
    assert.doesNotMatch(empty, /493-2013|certified|licence number/i);
  } finally { await server.close(); }
});

test('Vercel profile deep links rewrite only to the SPA and leave API routing intact', async () => {
  const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.deepEqual(config.rewrites.filter(rule => !rule.source.startsWith('/api/')), [
    { source: '/company-profile', destination: '/index.html' },
    { source: '/company-profile/', destination: '/index.html' }
  ]);
});
