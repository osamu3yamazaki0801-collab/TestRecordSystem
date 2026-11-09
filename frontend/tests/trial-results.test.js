import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

let server;
let TrialResults;

before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  ({ default: TrialResults } = await server.ssrLoadModule('/src/TrialResults.jsx'));
});

after(async () => {
  await server?.close();
});

function renderResults(overrides = {}) {
  return renderToStaticMarkup(createElement(TrialResults, {
    recordId: 1,
    files: [],
    pendingFiles: [],
    csrfToken: 'test-token',
    request: async () => ({}),
    setAuthenticated: () => {},
    setLoginError: () => {},
    ...overrides,
  }));
}

test('records without attachments render without a CSV panel or exception', () => {
  assert.equal(renderResults(), '');
});

test('records with legacy attachments render without a CSV panel or exception', () => {
  assert.equal(renderResults({ files: [{ id: 1, fileName: 'result.txt' }] }), '');
});

test('saved CSV files render a loading state before parsing completes', () => {
  const output = renderResults({ files: [{ id: 1, fileName: 'result.csv' }] });
  assert.ok(output.includes('CSVを読み込み中...'));
});