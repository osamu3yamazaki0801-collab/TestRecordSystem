import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

let server;
let App;

before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  ({ default: App } = await server.ssrLoadModule('/src/App.jsx'));
});

after(async () => {
  await server?.close();
});

function response(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  };
}

async function mountApp(url, fetchMock) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url,
    pretendToBeVisual: true,
  });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLSelectElement: dom.window.HTMLSelectElement,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    SubmitEvent: dom.window.SubmitEvent,
    File: dom.window.File,
    FormData: dom.window.FormData,
    fetch: fetchMock,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previousGlobals = new Map();
  for (const [name, value] of Object.entries(globals)) {
    previousGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }

  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.getElementById('root'));
  await act(async () => {
    root.render(createElement(App));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  return {
    dom,
    cleanup: async () => {
      await act(async () => root.unmount());
      dom.window.close();
      for (const [name, descriptor] of previousGlobals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    },
  };
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  }
  assert.fail(message);
}

async function click(dom, element) {
  await act(async () => {
    element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
}

function findNav(dom, label) {
  return [...dom.window.document.querySelectorAll('.nav-link')]
    .find((link) => link.textContent.includes(label));
}

async function enterText(dom, input, value) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
}

async function selectValue(dom, select, value) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value').set;
    setter.call(select, value);
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
}

async function chooseFile(dom, input, filename) {
  await act(async () => {
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [new dom.window.File(['csv content'], filename, { type: 'text/csv' })],
    });
    input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
}

async function submitForm(dom) {
  await act(async () => {
    dom.window.document.querySelector('.registration-page form').dispatchEvent(
      new dom.window.SubmitEvent('submit', { bubbles: true, cancelable: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function makeSearchFetch(calls, createResponse) {
  return async (url, options = {}) => {
    const parsedUrl = new URL(url, 'http://localhost');
    const method = options.method || 'GET';
    calls.push({ path: `${parsedUrl.pathname}${parsedUrl.search}`, method, body: options.body });
    if (parsedUrl.pathname === '/api/session') {
      return response({ authenticated: true, username: 'operator', csrfToken: 'test-token' });
    }
    if (parsedUrl.pathname === '/api/equipment-config') {
      return response({ managerChoices: ['山田太郎'], instrumentChoices: [] });
    }
    if (parsedUrl.pathname === '/api/dashboard') {
      return response({ totalRecords: 0, monthRecords: 0, currentMonth: '2026年11月', latestRecord: null });
    }
    if (parsedUrl.pathname === '/api/records' && method === 'POST') {
      const result = createResponse(options.body);
      return result.httpStatus
        ? response(result.data, result.httpStatus)
        : response(result, 201);
    }
    if (parsedUrl.pathname === '/api/records/batch' && method === 'POST') {
      const result = createResponse(options.body);
      return result.httpStatus
        ? response(result.data, result.httpStatus)
        : response(result, 201);
    }
    if (parsedUrl.pathname === '/api/records') {
      return response([]);
    }
    return response({ error: `Unexpected request: ${method} ${parsedUrl.pathname}` }, 404);
  };
}

test('a successful single registration uploads its CSV and navigates to search', async () => {
  const calls = [];
  const file = { id: 8, fileName: 'single.csv' };
  const record = {
    id: 42,
    trialNo: 'T-042',
    projectName: '',
    productNo: '',
    registrationDate: '20261114',
    manager: '山田太郎',
    files: [file],
  };
  const fetchMock = makeSearchFetch(calls, (body) => {
    assert.ok(body instanceof FormData);
    assert.equal(body.get('trialNo'), 'T-042');
    assert.equal(body.get('resultFiles').name, 'single.csv');
    return { id: record.id, files: [file] };
  });
  const app = await mountApp('http://localhost/', fetchMock);
  try {
    await waitFor(() => findNav(app.dom, '記録の登録'), 'registration navigation was not rendered');
    await click(app.dom, findNav(app.dom, '記録の登録'));
    await waitFor(() => app.dom.window.document.querySelector('input[name="trialNo"]'), 'registration form was not rendered');
    await enterText(app.dom, app.dom.window.document.querySelector('input[name="trialNo"]'), record.trialNo);
    await selectValue(app.dom, app.dom.window.document.querySelector('select[name="manager"]'), record.manager);
    await chooseFile(app.dom, app.dom.window.document.querySelector('input[type="file"]'), file.fileName);
    await click(app.dom, app.dom.window.document.querySelector('.registration-page button[type="submit"]'));

    await waitFor(
      () => app.dom.window.document.querySelector('.search-record-row'),
      'registered record did not appear on the search screen',
    );
    assert.ok(findNav(app.dom, '記録の検索').classList.contains('active'));
    assert.ok(app.dom.window.document.querySelector('.search-record-row').textContent.includes(record.trialNo));
    assert.ok(calls.some((call) => call.path === '/api/records' && call.method === 'POST'));
  } finally {
    await app.cleanup();
  }
});

test('a failed registration stays on the registration screen', async () => {
  const calls = [];
  const fetchMock = makeSearchFetch(calls, () => ({
    httpStatus: 400,
    data: { error: 'CSVの形式が正しくありません。' },
  }));
  const app = await mountApp('http://localhost/', fetchMock);
  try {
    await waitFor(() => findNav(app.dom, '記録の登録'), 'registration navigation was not rendered');
    await click(app.dom, findNav(app.dom, '記録の登録'));
    await waitFor(() => app.dom.window.document.querySelector('input[name="trialNo"]'), 'registration form was not rendered');
    await enterText(app.dom, app.dom.window.document.querySelector('input[name="trialNo"]'), 'T-ERROR');
    await selectValue(app.dom, app.dom.window.document.querySelector('select[name="manager"]'), '山田太郎');
    await click(app.dom, app.dom.window.document.querySelector('.registration-page button[type="submit"]'));

    await waitFor(
      () => app.dom.window.document.body.textContent.includes('CSVの形式が正しくありません。'),
      'registration error was not shown',
    );
    assert.ok(findNav(app.dom, '記録の登録').classList.contains('active'));
    assert.equal(findNav(app.dom, '記録の検索').classList.contains('active'), false);
  } finally {
    await app.cleanup();
  }
});

test('batch registration associates each selected CSV with its input row', async () => {
  const calls = [];
  const records = [
    { id: 51, trialNo: 'T-051', projectName: '', productNo: '', registrationDate: '20261114', manager: '山田太郎', files: [] },
    { id: 52, trialNo: 'T-052', projectName: '', productNo: '', registrationDate: '20261114', manager: '山田太郎', files: [{ id: 9, fileName: 'second.csv' }] },
  ];
  const fetchMock = makeSearchFetch(calls, (body) => {
    assert.ok(body instanceof FormData);
    const submissions = JSON.parse(body.get('submissions'));
    assert.deepEqual(submissions.map((submission) => submission.trialNo), ['T-051', 'T-052']);
    assert.equal(body.get('resultFiles-0'), null);
    assert.equal(body.get('resultFiles-1').name, 'second.csv');
    return { records };
  });
  const app = await mountApp('http://localhost/', fetchMock);
  try {
    await waitFor(() => findNav(app.dom, '記録の登録'), 'registration navigation was not rendered');
    await click(app.dom, findNav(app.dom, '記録の登録'));
    await waitFor(() => app.dom.window.document.querySelector('input[name="trialNo"]'), 'registration form was not rendered');
    await enterText(app.dom, app.dom.window.document.querySelector('input[name="trialNo"]'), records[0].trialNo);
    await selectValue(app.dom, app.dom.window.document.querySelector('select[name="manager"]'), records[0].manager);
    await click(app.dom, [...app.dom.window.document.querySelectorAll('button')].find((button) => button.textContent === '記録を追加'));
    await waitFor(() => app.dom.window.document.querySelector('input[name="trialNo-1"]'), 'second registration row was not added');
    await enterText(app.dom, app.dom.window.document.querySelector('input[name="trialNo-1"]'), records[1].trialNo);
    await chooseFile(app.dom, app.dom.window.document.querySelectorAll('input[type="file"]')[1], 'second.csv');
    await click(app.dom, app.dom.window.document.querySelector('.registration-page button[type="submit"]'));

    await waitFor(
      () => app.dom.window.document.querySelector('.search-record-row'),
      'batch registration did not navigate to the search screen',
    );
    assert.ok(findNav(app.dom, '記録の検索').classList.contains('active'));
    assert.ok(calls.some((call) => call.path === '/api/records/batch' && call.method === 'POST'));
  } finally {
    await app.cleanup();
  }
});

test('opening a CSV record selects the trial results tab and renders imported data', async () => {
  const record = {
    id: 17,
    trialNo: 'T-017',
    projectName: '案件',
    productNo: 'A 17',
    registrationDate: '20261114',
    manager: '山田太郎',
    files: [{ id: 99, fileName: 'result.csv' }],
  };
  const jumpers = [
    { name: 'JP-1', setting: '2-3', confirmed: false },
    { name: 'BOOT', setting: 'OPEN', confirmed: true },
    { name: 'MODE', setting: 'LOW', confirmed: false },
  ];
  const equipment = {
    boards: [{ name: 'PWS132-A', revision: '', nega: '', serialNumber: '' }],
    instruments: [{ name: '', managementNo: '', testItems: '' }],
    software: [
      { name: 'テストプロ', sdFormat: 'TEST0306', version: '', checksum: '' },
      { name: 'PWM85 基板 FPGA', sdFormat: 'XPLD0885', version: '', checksum: '' },
      { name: 'INF267 基板 FPGA', sdFormat: 'XPLD0856', version: '', checksum: '' },
    ],
  };
  const measurement = { min: '0.1', minJudgement: 'PASS', max: '0.2', maxJudgement: 'PASS' };
  const ngMeasurement = { ...measurement, minJudgement: 'NG' };
  const partialMeasurement = { ...measurement, minJudgement: '' };
  const parsedCsv = {
    metadata: { 品名: 'Parsed product', 仕様書番号: 'SPEC-17', 試験番号: 'T-017' },
    sections: [
      {
        number: 1,
        title: '試験結果 1',
        temperatures: [1, 2, 3].map((number) => ({ label: `温度 ${number}(℃)`, value: String(number * 10) })),
        rows: [{
          no: 'B5-1-01',
          name: '入力試験',
          lowerLimit: '0',
          upperLimit: '1',
          unit: 'V',
          measurements: [measurement, measurement, measurement],
          judgement: 'PASS',
        }, {
          no: 'B5-1-02',
          name: '入力試験 NG',
          lowerLimit: '0',
          upperLimit: '1',
          unit: 'V',
          measurements: [ngMeasurement, measurement, measurement],
          judgement: 'UNJUDGED',
        }, {
          no: 'B5-1-03',
          name: '入力試験 未判定',
          lowerLimit: '0',
          upperLimit: '1',
          unit: 'V',
          measurements: [partialMeasurement, measurement, measurement],
          judgement: 'UNJUDGED',
        }],
        summary: { PASS: 1, FAIL: 0, UNJUDGED: 2 },
      },
      {
        number: 2,
        title: '試験結果 2',
        temperatures: [1, 2, 3].map((number) => ({ label: `温度 ${number}(℃)`, value: String(number * 10) })),
        rows: [{
          no: 'B7-01',
          name: 'PWM入力試験 PWMIn1 10%',
          specifiedValue: '410',
          unit: 'count',
          measurements: [measurement, measurement, measurement].map(({ min, minJudgement }) => ({
            value: min,
            judgement: minJudgement,
          })),
          judgement: 'PASS',
        }, {
          no: 'B3-1-16',
          name: 'INF265 デジタル入力試験 DI_B7',
          specifiedValue: '00008000',
          unit: 'HEX',
          measurements: [measurement, measurement, measurement].map(({ min, minJudgement }) => ({
            value: min,
            judgement: minJudgement,
          })),
          judgement: 'PASS',
        }],
        summary: { PASS: 2, FAIL: 0, UNJUDGED: 0 },
      },
    ],
  };
  const fetchMock = async (url) => {
    const { pathname } = new URL(url, 'http://localhost');
    if (pathname === '/api/session') return response({ authenticated: true, username: 'operator', csrfToken: 'test-token' });
    if (pathname === '/api/records') return response([record]);
    if (pathname === '/api/records/17/equipment') return response(equipment);
    if (pathname === '/api/records/17/jumpers') {
      return response(jumpers);
    }
    if (pathname === '/api/equipment-config') return response({ managerChoices: ['山田太郎'], instrumentChoices: [] });
    if (pathname === '/api/records/17/files/99/results') return response(parsedCsv);
    return response({ error: `Unexpected request: ${pathname}` }, 404);
  };
  const app = await mountApp('http://localhost/?recordId=17', fetchMock);
  try {
    await waitFor(
      () => app.dom.window.document.querySelector('.record-detail-tabs [aria-selected="true"]')?.textContent === '試験結果',
      'CSV records should open on the trial results tab',
    );
    await waitFor(
      () => app.dom.window.document.body.textContent.includes('B5-1-01'),
      'parsed CSV rows were not rendered',
    );
    assert.ok(app.dom.window.document.body.textContent.includes('Parsed product'));
    const ngJudgement = [...app.dom.window.document.querySelectorAll('.csv-judgement')]
      .find((element) => element.textContent === 'NG');
    assert.ok(ngJudgement?.classList.contains('fail'), 'NG judgement should use the failure color');
    assert.ok(app.dom.window.document.querySelector('.csv-summary').textContent.includes('FAIL 1'));
    assert.ok(app.dom.window.document.querySelector('.csv-summary').textContent.includes('未判定 1'));
    const judgementFilter = app.dom.window.document.querySelector('.csv-filters select');
    assert.deepEqual([...judgementFilter.options].map((option) => option.textContent), ['すべて', 'NG', '未判定', 'PASS']);
    await selectValue(app.dom, judgementFilter, 'NG');
    assert.deepEqual(
      [...app.dom.window.document.querySelectorAll('.trial-results-table tbody tr')]
        .map((row) => row.querySelector('th')?.textContent)
        .filter(Boolean),
      ['B5-1-02'],
    );
    await selectValue(app.dom, judgementFilter, 'UNJUDGED');
    assert.ok(app.dom.window.document.querySelector('.csv-summary').textContent.includes('未判定 1'));
    assert.deepEqual(
      [...app.dom.window.document.querySelectorAll('.trial-results-table tbody tr')]
        .map((row) => row.querySelector('th')?.textContent)
        .filter(Boolean),
      ['B5-1-03'],
    );
    await selectValue(app.dom, judgementFilter, '');
    const analogTable = app.dom.window.document.querySelector('.trial-results-table.analog');
    const analogWidths = [96, 382, 90, 90, 72, ...Array(6).fill([90, 70]).flat()];
    [...analogTable.querySelectorAll('col')].forEach((column, index) => {
      column.getBoundingClientRect = () => ({ width: analogWidths[index] });
    });
    const noColumnHandle = analogTable.querySelector('.csv-column-resize-handle');
    await act(async () => {
      noColumnHandle.dispatchEvent(new app.dom.window.MouseEvent('pointerdown', {
        bubbles: true,
        clientX: 100,
      }));
    });
    await act(async () => {
      noColumnHandle.dispatchEvent(new app.dom.window.MouseEvent('pointermove', {
        bubbles: true,
        clientX: 140,
      }));
    });
    assert.equal(analogTable.querySelector('col.csv-no-column').style.width, '136px');
    await act(async () => {
      noColumnHandle.dispatchEvent(new app.dom.window.MouseEvent('pointerup', {
        bubbles: true,
        clientX: 140,
      }));
    });

    const digitalTab = [...app.dom.window.document.querySelectorAll('.csv-section-tabs [role="tab"]')]
      .find((tab) => tab.textContent === '試験結果 2');
    await click(app.dom, digitalTab);
    const searchInput = app.dom.window.document.querySelector('.csv-filters input');
    await enterText(app.dom, searchInput, 'B7');
    assert.deepEqual(
      [...app.dom.window.document.querySelectorAll('.trial-results-table tbody tr')]
        .map((row) => row.querySelector('th')?.textContent)
        .filter(Boolean),
      ['B7-01'],
      'an item-number match should not include B3 rows whose name contains DI_B7',
    );
    await enterText(app.dom, searchInput, 'DI_B7');
    assert.deepEqual(
      [...app.dom.window.document.querySelectorAll('.trial-results-table tbody tr')]
        .map((row) => row.querySelector('th')?.textContent)
        .filter(Boolean),
      [],
      'search should match the No. column only, not the test name',
    );
    await enterText(app.dom, searchInput, '');
    const digitalTable = app.dom.window.document.querySelector('.trial-results-table:not(.analog)');
    const digitalWidths = [96, 402, 90, 72, ...Array(3).fill([90, 70]).flat()];
    [...digitalTable.querySelectorAll('col')].forEach((column, index) => {
      column.getBoundingClientRect = () => ({ width: digitalWidths[index] });
    });
    const unitHeader = [...digitalTable.querySelectorAll('thead tr:first-child th')]
      .find((header) => header.textContent.includes('単位'));
    const unitColumnHandle = unitHeader.querySelector('.csv-column-resize-handle');
    await act(async () => {
      unitColumnHandle.dispatchEvent(new app.dom.window.MouseEvent('pointerdown', {
        bubbles: true,
        clientX: 300,
      }));
    });
    await act(async () => {
      unitColumnHandle.dispatchEvent(new app.dom.window.MouseEvent('pointermove', {
        bubbles: true,
        clientX: 330,
      }));
    });
    assert.equal(digitalTable.querySelector('col.csv-unit-column').style.width, '102px');
    await act(async () => {
      unitColumnHandle.dispatchEvent(new app.dom.window.MouseEvent('pointerup', {
        bubbles: true,
        clientX: 330,
      }));
    });

    const checkTab = [...app.dom.window.document.querySelectorAll('[role="tab"]')]
      .find((tab) => tab.textContent === '試験前チェック');
    await click(app.dom, checkTab);
    await waitFor(
      () => app.dom.window.document.querySelector('.jumper-table'),
      'jumper settings table was not rendered',
    );
    assert.deepEqual(
      [...app.dom.window.document.querySelectorAll('.jumper-table tbody tr')].map((row) => row.cells[0].textContent),
      ['JP-1', 'BOOT', 'MODE'],
    );
    assert.ok(app.dom.window.document.querySelector('.jumper-table').textContent.includes('OPEN'));
  } finally {
    await app.cleanup();
  }
});
