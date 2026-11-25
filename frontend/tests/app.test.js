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

function shippingSoftware() {
  return [{ name: '', sdFormat: '', version: '', checksum: '' }];
}

function appearanceInspection() {
  const items = [
    { key: 'boardRevision', name: '基板レビジョン', rows: 2, values: { PWS132: 'A', PWM85: 'A4', INF265: 'B0', MDM57: 'A2', INF271: 'D0', INF267: 'B0' } },
    { key: 'frontPanel', name: 'フロントパネルの銘板', rows: 2, values: { PWS132: 'PWS', PWM85: 'PWM-1', INF267: 'INF-1' } },
    { key: 'boardFit', name: '組合せ基板の勘合', rows: 1, values: { INF265: '', MDM57: '', INF271: '' } },
    { key: 'screws', name: 'ネジの締付けの確認', rows: 1, values: { PWS132: '', PWM85: '', INF265: '', MDM57: '', INF271: '' } },
    { key: 'sdCard', name: 'SDカード実装', rows: 1, values: { PWM85: '' } },
    { key: 'dustCap', name: 'MDM57防塵キャップ実装確認', rows: 1, values: { MDM57: '' } },
  ];
  return {
    boardGroups: [
      { name: 'PWS132', boards: ['PWS132'] },
      { name: 'PWM89', boards: ['PWM85', 'INF265', 'MDM57', 'INF271'] },
      { name: 'INF267', boards: ['INF267'] },
    ],
    items,
    checks: Object.fromEntries(items.flatMap((item) => Object.keys(item.values).map((board) => [`${item.key}:${board}`, false]))),
  };
}

function insertionKeys() {
  return [
    { name: 'P31', displayName: 'P31', positions: ['E', 'F', 'G', 'M'], confirmed: false },
    { name: 'P32', displayName: 'P32', positions: ['E', 'F', 'H', 'L'], confirmed: false },
    { name: 'P34', displayName: 'P34', positions: ['E', 'F', 'L', 'M'], confirmed: false },
    { name: 'P33', displayName: 'PS3', positions: ['E', 'H', 'K', 'L'], confirmed: false },
    { name: 'board:P31', displayName: 'INF265', side: 'board', positions: ['H', 'I', 'K', 'L'], confirmed: false },
    { name: 'board:P32', displayName: 'PWM85', side: 'board', positions: ['G', 'I', 'K', 'M'], confirmed: false },
    { name: 'board:P34', displayName: 'INF267', side: 'board', positions: ['G', 'H', 'I', 'K'], confirmed: false },
    { name: 'board:PS3', displayName: 'PWS132', side: 'board', positions: ['F', 'G', 'I', 'M'], confirmed: false },
  ];
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

async function chooseFile(dom, input, filename, type = 'text/csv', content = 'csv content') {
  await act(async () => {
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [new dom.window.File([content], filename, { type })],
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

function makeSearchFetch(calls, createResponse, dashboardSummary, workflowTasks = []) {
  let nextTrialNumber = 0;
  let managedUsers = [];
  return async (url, options = {}) => {
    const parsedUrl = new URL(url, 'http://localhost');
    const method = options.method || 'GET';
    calls.push({ path: `${parsedUrl.pathname}${parsedUrl.search}`, method, body: options.body });
    if (parsedUrl.pathname === '/api/session') {
      return response({ authenticated: true, userId: 1, username: 'operator', displayName: 'operator', role: 'admin', csrfToken: 'test-token' });
    }
    if (parsedUrl.pathname === '/api/workflow-users') {
      return response({ users: [{ id: 2, name: '山田太郎' }] });
    }
    if (parsedUrl.pathname === '/api/workflow-inbox') return response({ tasks: workflowTasks });
    if (parsedUrl.pathname === '/api/admin/users' && method === 'GET') {
      return response({
        users: managedUsers,
      });
    }
    if (parsedUrl.pathname === '/api/admin/users' && method === 'POST') {
      const user = {
        id: 2,
        username: 'staff-one',
        managerName: '山田太郎',
        managerEmail: '',
        role: 'user',
        isActive: true,
      };
      managedUsers = [user];
      return response(user, 201);
    }
    if (/^\/api\/admin\/users\/\d+$/.test(parsedUrl.pathname) && method === 'DELETE') {
      managedUsers = [];
      return response({ success: true });
    }
    if (parsedUrl.pathname === '/api/equipment-config') {
      return response({ managerChoices: ['山田太郎'], instrumentChoices: [] });
    }
    if (parsedUrl.pathname === '/api/dashboard') {
      return response(dashboardSummary || {
        totalRecords: 0,
        monthRecords: 0,
        currentMonth: '2026年11月',
        managerStats: { year: 2026, managers: [] },
      });
    }
    if (parsedUrl.pathname === '/api/trial-numbers/next' && method === 'POST') {
      nextTrialNumber += 1;
      return response({ trialNo: `260${String(nextTrialNumber - 1).padStart(5, '0')}` }, 201);
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
    if (parsedUrl.pathname === '/api/trial-results/preview' && method === 'POST') {
      return response({
        metadata: {
          品名: 'CSV品名',
          仕様書番号: 'SPEC-CSV-001',
          試験番号: 'CSV番号',
        },
        sections: [],
      });
    }
    if (parsedUrl.pathname === '/api/records') {
      return response([]);
    }
    return response({ error: `Unexpected request: ${method} ${parsedUrl.pathname}` }, 404);
  };
}

test('the dashboard provides registration and search buttons side by side', async () => {
  const app = await mountApp('http://localhost/', makeSearchFetch([], () => ({})));
  try {
    await waitFor(() => app.dom.window.document.querySelector('.welcome-actions'), 'dashboard actions were not rendered');
    const buttons = [...app.dom.window.document.querySelectorAll('.welcome-actions button')];
    assert.deepEqual(buttons.map((button) => button.textContent), ['記録の登録', '記録の検索']);

    await click(app.dom, buttons[1]);
    assert.ok(findNav(app.dom, '記録の検索').classList.contains('active'));
  } finally {
    await app.cleanup();
  }
});

test('the in-app workflow inbox shows tasks assigned to the signed-in user', async () => {
  const task = {
    recordId: 42,
    trialNo: '26000042',
    projectName: '案件',
    stageName: '調査',
    assigneeName: '山田太郎',
    isAssignedToMe: true,
  };
  const app = await mountApp(
    'http://localhost/',
    makeSearchFetch([], () => ({}), undefined, [task]),
  );
  try {
    await click(app.dom, findNav(app.dom, '回覧タスク'));
    await waitFor(() => app.dom.window.document.querySelector('.workflow-inbox tbody tr'), 'workflow task was not shown');
    const row = app.dom.window.document.querySelector('.workflow-inbox tbody tr');
    assert.ok(row.textContent.includes(task.trialNo));
    assert.ok(row.textContent.includes(task.stageName));
    assert.ok(row.textContent.includes('（自分）'));
  } finally {
    await app.cleanup();
  }
});

test('the administrator can create a manager account from user management', async () => {
  const calls = [];
  const app = await mountApp('http://localhost/', makeSearchFetch(calls, () => ({})));
  try {
    await click(app.dom, findNav(app.dom, 'ユーザー管理'));
    await waitFor(() => app.dom.window.document.querySelector('.user-create-form'), 'user management form was not shown');
    const form = app.dom.window.document.querySelector('.user-create-form');
    assert.ok(form.textContent.includes('半角英数字、ピリオド（.）、アンダースコア（_）、ハイフン（-）の3～50文字'));
    assert.ok(form.textContent.includes('日本語、半角数字、空白の30文字以内'));
    assert.equal(form.textContent.includes('メールアドレス（任意）'), false);
    assert.deepEqual(
      [...app.dom.window.document.querySelectorAll('.user-management table thead th')]
        .map((heading) => heading.textContent),
      ['ログインID', '担当者', 'メールアドレス', 'パスワード再設定', '権限・状態', '削除'],
    );
    const textInputs = form.querySelectorAll('input[type="text"]');
    await enterText(app.dom, textInputs[0], 'staff-one');
    await enterText(app.dom, textInputs[1], '山田太郎');
    await enterText(app.dom, form.querySelector('input[type="password"]'), 'safe individual password');
    await click(app.dom, form.querySelector('button[type="submit"]'));

    await waitFor(
      () => calls.some((call) => call.path === '/api/admin/users' && call.method === 'POST'),
      'account creation request was not sent',
    );
    const createCall = calls.find((call) => call.path === '/api/admin/users' && call.method === 'POST');
    assert.deepEqual(JSON.parse(createCall.body), {
      username: 'staff-one',
      managerName: '山田太郎',
      managerEmail: '',
      password: 'safe individual password',
    });
    await waitFor(() => app.dom.window.document.body.textContent.includes('アカウントを作成しました。'), 'account success message was not shown');
    app.dom.window.confirm = () => true;
    const userDeleteButton = [...app.dom.window.document.querySelectorAll('button')]
      .find((button) => button.textContent === '削除');
    await click(app.dom, userDeleteButton);
    await waitFor(
      () => calls.some((call) => call.path === '/api/admin/users/2' && call.method === 'DELETE'),
      'account deletion request was not sent',
    );
    await waitFor(
      () => app.dom.window.document.body.textContent.includes('アカウントを削除しました。'),
      'account deletion success message was not shown',
    );
  } finally {
    await app.cleanup();
  }
});

test('the registration form visibly marks trial number and manager as required', async () => {
  const app = await mountApp('http://localhost/', makeSearchFetch([], () => ({})));
  try {
    await waitFor(() => findNav(app.dom, '記録の登録'), 'registration navigation was not rendered');
    await click(app.dom, findNav(app.dom, '記録の登録'));
    await waitFor(() => app.dom.window.document.querySelector('.registration-page input[name="trialNo"]'), 'registration form was not rendered');

    const resultFileField = app.dom.window.document.querySelector('.record-field-result-file');
    assert.ok(resultFileField.textContent.includes('自動試験システムの試験結果CSVをインポートしてください。'));
    assert.equal(resultFileField.textContent.includes('任意・登録後に記録の詳細で表示'), false);
    const requiredFields = [...app.dom.window.document.querySelectorAll('.registration-page .required-badge')]
      .map((badge) => badge.parentElement.textContent.replace('必須', '').trim());
    assert.deepEqual(requiredFields, ['試験番号', '担当者']);
    const fieldOrder = [...app.dom.window.document.querySelectorAll('.registration-page .form-grid > .field')]
      .map((field) => field.className);
    assert.deepEqual(fieldOrder, [
      'field record-field-trial-no',
      'field record-field-manager',
      'field record-field-result-file result-file-picker',
      'field record-field-project-name',
      'field record-field-product-no',
      'field record-field-registration-date',
    ]);
    assert.equal(
      app.dom.window.document.querySelector('input[name="registrationDate"]').value,
      `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(new Date().getDate()).padStart(2, '0')}`,
    );
  } finally {
    await app.cleanup();
  }
});

test('registration rows automatically reserve the lowest available trial number', async () => {
  const calls = [];
  const app = await mountApp('http://localhost/', makeSearchFetch(calls, () => ({})));
  try {
    await click(app.dom, findNav(app.dom, '記録の登録'));
    await waitFor(() => app.dom.window.document.querySelector('input[name="trialNo"]'), 'registration form was not rendered');
    const firstNumber = app.dom.window.document.querySelector('input[name="trialNo"]');
    await waitFor(() => firstNumber.value === '26000000', 'first number was not allocated');
    assert.equal(app.dom.window.document.querySelector('.trial-number-controls button'), null);

    await click(app.dom, [...app.dom.window.document.querySelectorAll('button')].find((button) => button.textContent === '記録を追加'));
    await waitFor(() => app.dom.window.document.querySelector('input[name="trialNo-1"]'), 'second registration row was not added');
    const secondNumber = app.dom.window.document.querySelector('input[name="trialNo-1"]');
    await waitFor(() => secondNumber.value === '26000001', 'second number was not allocated');
    assert.equal(calls.filter((call) => call.path === '/api/trial-numbers/next' && call.method === 'POST').length, 2);
  } finally {
    await app.cleanup();
  }
});

test('the dashboard shows monthly manager counts and monthly response ratios', async () => {
  const dashboardSummary = {
    totalRecords: 3,
    monthRecords: 3,
    currentMonth: '2026年11月',
    managerStats: {
      year: 2026,
      managers: [
        { name: '山田太郎', counts: [2, ...Array(11).fill(0)] },
        { name: '佐藤花子', counts: [1, ...Array(11).fill(0)] },
      ],
    },
  };
  const app = await mountApp(
    'http://localhost/',
    makeSearchFetch([], () => ({}), dashboardSummary),
  );
  try {
    await waitFor(
      () => app.dom.window.document.querySelectorAll('.manager-chart-svg').length === 2,
      'monthly manager charts were not rendered',
    );
    const headings = [...app.dom.window.document.querySelectorAll('.manager-chart-heading h2')]
      .map((heading) => heading.textContent);
    assert.deepEqual(headings, ['対応件数', '対応比率']);
    assert.equal(app.dom.window.document.body.textContent.includes('直近の記録'), false);
    assert.equal(app.dom.window.document.body.textContent.includes('操作メニュー'), false);

    const countTitles = [...app.dom.window.document.querySelectorAll('.manager-chart-svg circle title')]
      .map((title) => title.textContent);
    assert.ok(countTitles.includes('山田太郎: 2件'));
    assert.ok(countTitles.includes('佐藤花子: 1件'));
    const rateTitles = [...app.dom.window.document.querySelectorAll('.manager-chart-svg rect title')]
      .map((title) => title.textContent);
    assert.ok(rateTitles.includes('山田太郎: 66.7% (2/3件)'));
    assert.ok(rateTitles.includes('佐藤花子: 33.3% (1/3件)'));
  } finally {
    await app.cleanup();
  }
});

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
    await waitFor(
      () => app.dom.window.document.querySelector('input[name="projectName"]').value === 'CSV品名'
        && app.dom.window.document.querySelector('input[name="productNo"]').value === 'SPEC-CSV-001',
      'CSV metadata was not copied to the registration fields',
    );
    await waitFor(
      () => app.dom.window.document.querySelector('.record-field-result-file .selected-file-name')?.textContent === file.fileName,
      'selected CSV filename was not shown',
    );
    assert.equal(
      app.dom.window.document.querySelector('.record-field-result-file').textContent.includes('自動試験システムの試験結果CSVをインポートしてください。'),
      false,
    );
    await click(app.dom, app.dom.window.document.querySelector('.registration-page button[type="submit"]'));

    await waitFor(
      () => app.dom.window.document.querySelector('.search-record-row'),
      'registered record did not appear on the search screen',
    );
    assert.ok(findNav(app.dom, '記録の検索').classList.contains('active'));
    assert.ok(app.dom.window.document.querySelector('.search-record-row').textContent.includes(record.trialNo));
    assert.match(
      app.dom.window.document.querySelector('.search-record-row').textContent,
      /\d{4}-\d{2}-\d{2}/,
    );
    assert.ok(calls.some((call) => call.path === '/api/records' && call.method === 'POST'));
  } finally {
    await app.cleanup();
  }
});

test('a duplicate-trial-number error stays on the registration screen and shows the message', async () => {
  const calls = [];
  const fetchMock = makeSearchFetch(calls, () => ({
    httpStatus: 409,
    data: { error: '試験番号「T-ERROR」は既に登録されています。' },
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
      () => app.dom.window.document.body.textContent.includes('試験番号「T-ERROR」は既に登録されています。'),
      'duplicate trial number message was not shown',
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

test('opening a CSV record starts on trial information and can render imported data', async () => {
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
    boards: [{ name: 'PWS132-A', serialNumber: '' }],
    instruments: [{ name: '', managementNo: '', testItems: '' }],
    shippingSoftware: shippingSoftware(),
    shippingSoftwareSameAsTrial: false,
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
    if (pathname === '/api/workflow-users') return response({ users: [] });
    if (pathname === '/api/records') return response([record]);
    if (pathname === '/api/records/17/equipment') return response(equipment);
    if (pathname === '/api/records/17/appearance-checks') return response(appearanceInspection());
    if (pathname === '/api/records/17/insertion-keys') return response(insertionKeys());
    if (pathname === '/api/records/17/manual-tests') return response([{
      key: 'power',
      number: '1',
      name: '電源確認',
      area: 'PWS132',
      items: [{
        key: 'voltage',
        name: 'P24A1(P24-P24)',
        lowerLimit: 23.52,
        upperLimit: 24.48,
        unit: 'V',
        benchLock: true,
        measuredValue: '24.00',
        judgement: 'PASS',
        benchLockChecked: false,
      }],
    }]);
    if (pathname === '/api/records/17/manual-test-conditions') {
      return response({ temperature: '23', humidity: '45' });
    }
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
      () => app.dom.window.document.querySelector('.record-detail-tabs [aria-selected="true"]')?.textContent === '試験情報',
      'CSV records should open on the trial information tab',
    );
    const trialResultsTab = [...app.dom.window.document.querySelectorAll('.record-detail-tabs [role="tab"]')]
      .find((tab) => tab.textContent === '試験結果');
    await click(app.dom, trialResultsTab);
    await waitFor(
      () => app.dom.window.document.body.textContent.includes('B5-1-01'),
      'parsed CSV rows were not rendered',
    );
    assert.deepEqual(
      [...app.dom.window.document.querySelectorAll('.csv-section-tabs [role="tab"]')]
        .map((tab) => tab.textContent),
      ['アナログ系', 'デジタル系'],
    );
    const manualTable = app.dom.window.document.querySelector('.manual-results-table');
    assert.equal(app.dom.window.document.querySelector('input[aria-label="温度"]').value, '23');
    assert.equal(app.dom.window.document.querySelector('input[aria-label="湿度"]').value, '45');
    assert.equal(manualTable.previousElementSibling, null);
    assert.equal(manualTable.querySelector('.manual-judgement').textContent, 'PASS');
    const measuredInput = manualTable.querySelector('input[type="text"]');
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        app.dom.window.HTMLInputElement.prototype,
        'value',
      ).set;
      valueSetter.call(measuredInput, '25');
      measuredInput.dispatchEvent(new app.dom.window.Event('input', { bubbles: true }));
    });
    assert.equal(manualTable.querySelector('.manual-judgement').textContent, 'NG');
    assert.ok(manualTable.querySelector('tr').classList.contains('manual-failed-row')
      || manualTable.querySelector('tbody tr').classList.contains('manual-failed-row'));
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
    assert.equal(analogTable.querySelectorAll('col.csv-analog-limit-column').length, 2);
    assert.equal(analogTable.querySelectorAll('col.csv-analog-measurement-column').length, 6);
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
      .find((tab) => tab.textContent === 'デジタル系');
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

    const infoTab = [...app.dom.window.document.querySelectorAll('.record-detail-tabs [role="tab"]')]
      .find((tab) => tab.textContent === '試験情報');
    await click(app.dom, infoTab);
    const boardTable = app.dom.window.document.querySelector('.equipment-table--boards');
    assert.deepEqual(
      [...boardTable.querySelectorAll('thead th')].map((header) => header.textContent),
      ['基板名', 'シリアル No.'],
    );
    assert.equal(boardTable.querySelectorAll('tbody input').length, 1);
    const serialInput = boardTable.querySelector('input[aria-label="PWS132-A シリアル No."]');
    await enterText(app.dom, serialInput, 'SERIAL-001');
    assert.equal(serialInput.value, 'SERIAL-001');

    const checkTab = [...app.dom.window.document.querySelectorAll('[role="tab"]')]
      .find((tab) => tab.textContent === '受入検査');
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

test('power board PDF reports upload and preview at the end of the pre-test check tab', async () => {
  const calls = [];
  const record = {
    id: 18,
    trialNo: 'T-018',
    projectName: '案件',
    productNo: 'A 18',
    registrationDate: '20261114',
    manager: '山田太郎',
    files: [],
    powerBoardReport: null,
  };
  const equipment = {
    boards: [{ name: 'PWS132-A', serialNumber: '' }],
    instruments: [],
    shippingSoftware: shippingSoftware(),
    shippingSoftwareSameAsTrial: false,
    software: [
      { name: 'テストプロ', sdFormat: 'TEST0306', version: '', checksum: '' },
      { name: 'PWM85 基板 FPGA', sdFormat: 'XPLD0885', version: '', checksum: '' },
      { name: 'INF267 基板 FPGA', sdFormat: 'XPLD0856', version: '', checksum: '' },
    ],
  };
  const jumpers = [{ name: 'W1', setting: '1-2', confirmed: false }];
  const fetchMock = async (url, options = {}) => {
    const parsedUrl = new URL(url, 'http://localhost');
    const method = options.method || 'GET';
    calls.push({ path: parsedUrl.pathname, method, body: options.body });
    if (parsedUrl.pathname === '/api/session') return response({ authenticated: true, username: 'operator', csrfToken: 'test-token' });
    if (parsedUrl.pathname === '/api/workflow-users') return response({ users: [] });
    if (parsedUrl.pathname === '/api/records') return response([record]);
    if (parsedUrl.pathname === '/api/records/18/equipment') return response(equipment);
    if (parsedUrl.pathname === '/api/records/18/appearance-checks') return response(appearanceInspection());
    if (parsedUrl.pathname === '/api/records/18/insertion-keys') return response(insertionKeys());
    if (parsedUrl.pathname === '/api/records/18/manual-tests') return response([]);
    if (parsedUrl.pathname === '/api/records/18/manual-test-conditions') return response({ temperature: '', humidity: '' });
    if (parsedUrl.pathname === '/api/records/18/jumpers') return response(jumpers);
    if (parsedUrl.pathname === '/api/equipment-config') return response({ managerChoices: ['山田太郎'], instrumentChoices: [] });
    if (parsedUrl.pathname === '/api/records/18/power-board-report' && method === 'POST') {
      assert.ok(options.body instanceof FormData);
      assert.equal(options.body.get('reportFile').name, 'power-board.pdf');
      return response({ report: { id: 71, fileName: 'power-board.pdf' } }, 201);
    }
    return response({ error: `Unexpected request: ${method} ${parsedUrl.pathname}` }, 404);
  };
  const app = await mountApp('http://localhost/?recordId=18', fetchMock);
  try {
    await waitFor(
      () => app.dom.window.document.querySelector('.record-detail-tabs'),
      'record detail was not rendered',
    );
    const checkTab = [...app.dom.window.document.querySelectorAll('[role="tab"]')]
      .find((tab) => tab.textContent === '受入検査');
    await click(app.dom, checkTab);
    await waitFor(
      () => app.dom.window.document.querySelector('.power-board-report-section'),
      'power board report section was not rendered',
    );
    const reportSection = app.dom.window.document.querySelector('.power-board-report-section');
    assert.equal(
      app.dom.window.document.getElementById('record-detail-panel-1').lastElementChild,
      reportSection,
    );
    assert.equal(reportSection.querySelector('h3').textContent, '電源基板試験成績票');
    await chooseFile(
      app.dom,
      reportSection.querySelector('input[type="file"]'),
      'power-board.pdf',
      'application/pdf',
      '%PDF-1.7\nsample\n%%EOF',
    );
    await waitFor(
      () => reportSection.querySelector('.power-board-report-preview'),
      'uploaded PDF preview was not rendered',
    );
    assert.equal(
      reportSection.querySelector('.power-board-report-preview').getAttribute('src'),
      '/api/records/18/power-board-report',
    );
    assert.ok(calls.some((call) => (
      call.path === '/api/records/18/power-board-report' && call.method === 'POST'
    )));
  } finally {
    await app.cleanup();
  }
});

test('shipping inspection saves independently and workflow assignees use individual accounts', async () => {
  const record = {
    id: 20, trialNo: 'T-020', projectName: '案件', productNo: 'A20',
    registrationDate: '20261114', manager: '山田太郎', files: [],
  };
  let equipment = {
    boards: [], instruments: [],
    software: [
      { name: 'テストプロ', sdFormat: 'TEST0306', version: 'ACCEPT-1', checksum: '' },
      { name: 'PWM85 基板 FPGA', sdFormat: 'XPLD0885', version: 'ACCEPT-PLD', checksum: '' },
      { name: 'INF267 基板 FPGA', sdFormat: 'XPLD0856', version: '', checksum: '' },
    ],
    shippingSoftware: shippingSoftware(),
    shippingSoftwareSameAsTrial: false,
  };
  const appearance = appearanceInspection();
  const saves = [];
  let failSave = true;
  const fetchMock = async (url, options = {}) => {
    const { pathname } = new URL(url, 'http://localhost');
    if (pathname === '/api/session') return response({
      authenticated: true, userId: 1, username: 'operator', displayName: 'operator', role: 'admin', csrfToken: 'test-token',
    });
    if (pathname === '/api/records') return response([record]);
    if (pathname === '/api/workflow-users') return response({ users: [{ id: 2, name: '山田太郎' }] });
    if (pathname === '/api/equipment-config') return response({
      managerChoices: ['山田太郎'],
      instrumentChoices: [],
    });
    if (pathname === '/api/records/20/equipment') return response(equipment);
    if (pathname === '/api/records/20/jumpers') return response([]);
    if (pathname === '/api/records/20/appearance-checks') return response(appearance);
    if (pathname === '/api/records/20/insertion-keys') return response(insertionKeys());
    if (pathname === '/api/records/20/manual-tests') return response([]);
    if (pathname === '/api/records/20/manual-test-conditions') return response({ temperature: '', humidity: '' });
    if (pathname === '/api/records/20/workflow') return response({ workflow: null });
    if (pathname === '/api/records/20/details' && options.method === 'PUT') {
      saves.push(options.body);
      if (failSave) return response({ error: '保存に失敗しました。' }, 500);
      equipment = JSON.parse(options.body.get('equipment'));
      return response({
        record, equipment, jumperChecks: {},
        appearanceChecks: appearance.checks, insertionKeys: insertionKeys(),
        manualTests: [], manualTestConditions: { temperature: '', humidity: '' },
      });
    }
    return response({ error: `Unexpected request: ${pathname}` }, 404);
  };
  const app = await mountApp('http://localhost/?recordId=20', fetchMock);
  try {
    const document = app.dom.window.document;
    await waitFor(() => document.querySelector('.record-detail-tabs'), 'detail tabs were not rendered');
    const tabs = [...document.querySelectorAll('.record-detail-tabs [role="tab"]')];
    assert.deepEqual(tabs.map((tab) => tab.textContent), ['試験情報', '受入検査', '試験結果', '出荷検査', '回覧']);
    await act(async () => tabs[0].dispatchEvent(new app.dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true })));
    assert.equal(tabs[4].getAttribute('aria-selected'), 'true');
    assert.equal(document.activeElement, tabs[4]);
    await click(app.dom, tabs[3]);
    const panel = document.getElementById('record-detail-panel-3');
    assert.equal(panel.hidden, false);
    assert.deepEqual([...panel.querySelectorAll('h3')].map((heading) => heading.textContent),
      ['出荷用ソフトインストール']);
    assert.equal(panel.querySelectorAll('tbody tr').length, 1);
    const inputs = [...panel.querySelectorAll('tbody input')];
    assert.equal(inputs.length, 4);
    assert.ok(inputs.every((input) => input.value === '' && input.maxLength === 100));
    const name = panel.querySelector('input[aria-label="出荷用ソフトインストール ソフト"]');
    const sdFormat = panel.querySelector('input[aria-label="出荷用ソフトインストール SD 形式"]');
    const version = panel.querySelector('input[aria-label="出荷用ソフトインストール バージョン"]');
    const checksum = panel.querySelector('input[aria-label="出荷用ソフトインストール チェックサム"]');
    await enterText(app.dom, name, '出荷アプリ');
    await enterText(app.dom, sdFormat, 'SHIP001');
    await enterText(app.dom, version, 'SHIP-1');
    await enterText(app.dom, checksum, 'ABC123');
    const sameSoftware = panel.querySelector('input[type="checkbox"]');
    assert.equal(sameSoftware.checked, false);
    await click(app.dom, sameSoftware);
    assert.equal(sameSoftware.checked, true);
    assert.ok(inputs.every((input) => input.disabled));
    assert.deepEqual(inputs.map((input) => input.value), ['出荷アプリ', 'SHIP001', 'SHIP-1', 'ABC123']);
    assert.ok(panel.textContent.includes('チェックを外すと編集できます。'));
    await click(app.dom, tabs[1]);
    assert.equal(document.querySelector('input[aria-label="テストプロ バージョン"]').value, 'ACCEPT-1');
    assert.equal(document.querySelector('input[aria-label="PWM85 基板 FPGA バージョン"]').value, 'ACCEPT-PLD');
    await click(app.dom, tabs[3]);
    const commonButtons = [...document.querySelectorAll('.record-detail-common button')];
    const saveButton = commonButtons.find((button) => button.textContent === '保存');
    const cancelButton = commonButtons.find((button) => button.textContent === 'キャンセル');
    let beforeUnload = new app.dom.window.Event('beforeunload', { cancelable: true });
    await act(async () => app.dom.window.dispatchEvent(beforeUnload));
    assert.equal(beforeUnload.defaultPrevented, true, 'unsaved changes should warn before closing');
    assert.equal(saveButton.disabled, false, 'cancelling close must leave save enabled');
    assert.deepEqual(inputs.map((input) => input.value), ['出荷アプリ', 'SHIP001', 'SHIP-1', 'ABC123']);
    await click(app.dom, saveButton);
    assert.ok(document.body.textContent.includes('保存に失敗しました。'));
    assert.equal(sameSoftware.checked, true);
    assert.ok(inputs.every((input) => input.disabled));
    assert.deepEqual(inputs.map((input) => input.value), ['出荷アプリ', 'SHIP001', 'SHIP-1', 'ABC123']);
    failSave = false;
    await click(app.dom, saveButton);
    assert.equal(saves.length, 2);
    const saved = JSON.parse(saves[1].get('equipment'));
    assert.equal(saved.shippingSoftwareSameAsTrial, true);
    assert.deepEqual(saved.shippingSoftware, [{
      name: '出荷アプリ', sdFormat: 'SHIP001', version: 'SHIP-1', checksum: 'ABC123',
    }]);
    assert.equal(saved.software[0].version, 'ACCEPT-1');
    assert.equal(saved.software[1].version, 'ACCEPT-PLD');
    beforeUnload = new app.dom.window.Event('beforeunload', { cancelable: true });
    await act(async () => app.dom.window.dispatchEvent(beforeUnload));
    assert.equal(beforeUnload.defaultPrevented, false, 'successful save should clear the close warning');
    await click(app.dom, sameSoftware);
    assert.ok(inputs.every((input) => !input.disabled));
    for (const input of inputs) await enterText(app.dom, input, 'UNSAVED');
    app.dom.window.confirm = () => true;
    await click(app.dom, cancelButton);
    assert.equal(sameSoftware.checked, true, 'cancel should restore the saved check state');
    assert.ok(inputs.every((input) => input.disabled));
    assert.deepEqual(inputs.map((input) => input.value), ['出荷アプリ', 'SHIP001', 'SHIP-1', 'ABC123']);
    await click(app.dom, sameSoftware);
    await click(app.dom, saveButton);
    assert.equal(saves.length, 3);
    assert.equal(JSON.parse(saves[2].get('equipment')).shippingSoftwareSameAsTrial, false);
    assert.ok(inputs.every((input) => !input.disabled));
    assert.deepEqual(inputs.map((input) => input.value), ['出荷アプリ', 'SHIP001', 'SHIP-1', 'ABC123']);
    await click(app.dom, tabs[4]);
    await waitFor(() => document.querySelectorAll('#record-detail-panel-4 .workflow-panel select').length === 4, 'workflow fields were not loaded');
    const workflowLabels = [...document.querySelectorAll('#record-detail-panel-4 .workflow-panel label.field')];
    const stageSelects = workflowLabels
      .filter((label) => label.querySelector('span').textContent === '段階名')
      .map((label) => label.querySelector('select'));
    const assigneeSelects = workflowLabels
      .filter((label) => label.querySelector('span').textContent === '担当者')
      .map((label) => label.querySelector('select'));
    assert.deepEqual(stageSelects.map((select) => [...select.options].map((option) => option.value)), [
      ['', '担当', '調査', '承認'],
      ['', '担当', '調査', '承認'],
    ]);
    assert.ok(assigneeSelects.every((select) => (
      [...select.options].some((option) => option.value === '2' && option.textContent === '山田太郎')
    )));
    await selectValue(app.dom, assigneeSelects[0], '2');
    assert.equal(document.querySelector('#record-detail-panel-4 input[type="email"]'), null);
  } finally {
    await app.cleanup();
  }
});

test('appearance inspection checks cancel, save and retain input on failure with other details', async () => {
  const record = {
    id: 19, trialNo: 'T-019', projectName: '案件', productNo: 'A 19',
    registrationDate: '20261114', manager: '山田太郎', files: [],
  };
  const equipment = {
    boards: [{ name: 'PWS132', serialNumber: '' }],
    instruments: [],
    shippingSoftware: shippingSoftware(),
    shippingSoftwareSameAsTrial: false,
    software: [
      { name: 'テストプロ', sdFormat: 'TEST0306', version: '', checksum: '' },
      { name: 'PWM85 基板 FPGA', sdFormat: 'XPLD0885', version: '', checksum: '' },
      { name: 'INF267 基板 FPGA', sdFormat: 'XPLD0856', version: '', checksum: '' },
    ],
  };
  const appearance = appearanceInspection();
  appearance.checks['dustCap:MDM57'] = true;
  appearance.boardGroups.push({ name: 'AUX', boards: ['AUX'] });
  appearance.items.push(
    { key: 'seal', name: '封印確認', rows: 1, values: { AUX: 'OK' } },
    { key: 'packing', name: '梱包確認', rows: 2, values: { PWS132: '付属品', AUX: '' } },
  );
  appearance.checks['seal:AUX'] = false;
  appearance.checks['packing:PWS132'] = false;
  appearance.checks['packing:AUX'] = false;
  const saves = [];
  let failSave = true;
  const fetchMock = async (url, options = {}) => {
    const { pathname } = new URL(url, 'http://localhost');
    if (pathname === '/api/session') return response({ authenticated: true, username: 'operator', csrfToken: 'test-token' });
    if (pathname === '/api/workflow-users') return response({ users: [] });
    if (pathname === '/api/records') return response([record]);
    if (pathname === '/api/records/19/equipment') return response(equipment);
    if (pathname === '/api/records/19/jumpers') return response([{ name: 'W1', setting: '1-2', confirmed: false }]);
    if (pathname === '/api/records/19/appearance-checks') return response(appearance);
    if (pathname === '/api/records/19/insertion-keys') {
      return response(insertionKeys().map((item) => ({ ...item, confirmed: ['P34', 'board:P32'].includes(item.name) })));
    }
    if (pathname === '/api/records/19/manual-tests') return response([]);
    if (pathname === '/api/records/19/manual-test-conditions') return response({ temperature: '', humidity: '' });
    if (pathname === '/api/equipment-config') return response({ managerChoices: ['山田太郎'], instrumentChoices: [] });
    if (pathname === '/api/records/19/details' && options.method === 'PUT') {
      saves.push(options.body);
      if (failSave) return response({ error: '外観確認の保存に失敗しました。' }, 500);
      return response({
        record, equipment,
        jumperChecks: JSON.parse(options.body.get('jumperChecks')),
        appearanceChecks: JSON.parse(options.body.get('appearanceChecks')),
        insertionKeys: insertionKeys().map((item) => ({
          ...item, confirmed: JSON.parse(options.body.get('insertionKeyChecks'))[item.name],
        })),
        manualTests: [],
        manualTestConditions: JSON.parse(options.body.get('manualTestConditions')),
      });
    }
    return response({ error: `Unexpected request: ${pathname}` }, 404);
  };
  const app = await mountApp('http://localhost/?recordId=19', fetchMock);
  try {
    const document = app.dom.window.document;
    await waitFor(() => document.querySelector('.record-detail-tabs'), 'record detail was not rendered');
    const acceptanceTab = [...document.querySelectorAll('.record-detail-tabs [role="tab"]')]
      .find((tab) => tab.textContent === '受入検査');
    await click(app.dom, acceptanceTab);
    const panel = document.getElementById('record-detail-panel-1');
    assert.deepEqual(
      [...panel.querySelectorAll('h3')].map((heading) => heading.textContent),
      ['外観確認', '誤挿入キー確認', 'ジャンパ設定', 'インストールソフト', 'PLDバージョン', '電源基板試験成績票'],
    );
    const section = panel.querySelector('.appearance-inspection');
    assert.equal(panel.firstElementChild, section);
    const insertion = panel.querySelector('.insertion-key-inspection');
    const sides = insertion.querySelector('.insertion-key-layout > .insertion-key-sides');
    assert.deepEqual([...sides.children].map((side) => side.querySelector('.insertion-key-instruction').textContent),
      ['バックボード側', '基板側']);
    const insertionTable = insertion.querySelector('table');
    assert.equal(insertion.querySelector('.insertion-key-instruction').textContent, 'バックボード側');
    assert.deepEqual([...insertionTable.tHead.rows[0].cells].map((cell) => cell.textContent),
      ['位置', 'P31', 'P32', 'P34', 'PS3']);
    const positionRows = [...insertionTable.tBodies[0].rows].slice(0, -1);
    assert.deepEqual(positionRows.map((row) => row.cells[0].textContent),
      ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'K', 'L', 'M']);
    assert.deepEqual([1, 2, 3, 4].map((column) => positionRows
      .filter((row) => row.cells[column].querySelector('.insertion-key-slot--filled'))
      .map((row) => row.cells[0].textContent)),
    [['E', 'F', 'G', 'M'], ['E', 'F', 'H', 'L'], ['E', 'F', 'L', 'M'], ['E', 'H', 'K', 'L']]);
    assert.ok([...insertionTable.rows].slice(0, -1).every((row) => row.cells.length === 5));
    assert.equal(insertionTable.tBodies[0].rows[12].cells[0].textContent, '確認');
    assert.equal(insertionTable.tBodies[0].rows[12].cells[1].colSpan, 4);
    const boardTable = insertion.querySelector('table[aria-label="基板側の誤挿入キー確認"]');
    assert.deepEqual([...boardTable.tHead.rows[0].cells].map((cell) => cell.textContent),
      ['位置', 'INF265', 'PWM85', 'INF267', 'PWS132']);
    const boardRows = [...boardTable.tBodies[0].rows].slice(0, -1);
    assert.deepEqual(boardRows.map((row) => row.cells[0].textContent),
      ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'K', 'L', 'M']);
    assert.deepEqual([1, 2, 3, 4].map((column) => boardRows
      .filter((row) => row.cells[column].querySelector('.insertion-key-slot--filled'))
      .map((row) => row.cells[0].textContent)),
    [['H', 'I', 'K', 'L'], ['G', 'I', 'K', 'M'], ['G', 'H', 'I', 'K'], ['F', 'G', 'I', 'M']]);
    assert.ok([...boardTable.rows].slice(0, -1).every((row) => row.cells.length === 5));
    assert.equal(boardTable.tBodies[0].rows[12].cells[1].colSpan, 4);
    assert.equal(insertion.querySelectorAll('input[type="checkbox"]').length, 2);
    const boardCheck = boardTable.querySelector('input[aria-label="基板側の誤挿入キーを確認"]');
    assert.equal(boardCheck.checked, false);
    const connectorCheck = insertionTable.querySelector('input[aria-label="バックボード側の誤挿入キーを確認"]');
    assert.equal(connectorCheck.checked, false);
    const table = section.querySelector('table');
    assert.equal(table.querySelectorAll('tbody').length, 8);
    assert.equal(table.querySelectorAll('tbody tr').length, 11);
    assert.equal(table.querySelectorAll('input[type="checkbox"]').length, 22);
    assert.equal(table.querySelector('th[colspan="4"]').textContent, 'PWM89');
    assert.deepEqual(
      [...table.querySelectorAll('tbody:first-of-type .appearance-expected')].map((cell) => cell.textContent),
      ['A', 'A4', 'B0', 'A2', 'D0', 'B0'],
    );
    const groups = table.querySelectorAll('tbody');
    assert.equal(groups[0].querySelector('th').rowSpan, 2);
    assert.equal(groups[0].querySelectorAll('tr:first-child input').length, 0);
    assert.equal(groups[0].querySelectorAll('tr:last-child input').length, 6);
    const nameplateCells = [...groups[1].querySelectorAll('tr:first-child td')].slice(1);
    assert.deepEqual(nameplateCells.map((cell) => cell.textContent), ['PWS', 'PWM-1', '-', '-', '-', 'INF-1', '-']);
    assert.equal(nameplateCells[2].rowSpan, 2, 'not-applicable cells should span both lines');
    assert.equal(groups[6].querySelectorAll('tr').length, 1);
    assert.equal(groups[6].querySelector('.appearance-inline-value').textContent, 'OK');
    assert.equal(groups[7].querySelectorAll('tr').length, 2);
    assert.equal(groups[7].querySelector('th').rowSpan, 2);
    assert.equal(groups[7].querySelectorAll('input').length, 2);
    const revision = table.querySelector('input[aria-label="PWS132 基板レビジョンを確認"]');
    const dustCap = table.querySelector('input[aria-label="MDM57 MDM57防塵キャップ実装確認を確認"]');
    assert.equal(dustCap.checked, true);
    assert.equal(revision.checked, false);
    await click(app.dom, revision);
    const saveButton = document.querySelector('button[form="record-edit-form"]');
    await click(app.dom, saveButton);
    await waitFor(() => saves.length === 1, 'save was not submitted');
    assert.deepEqual(JSON.parse(saves[0].get('insertionKeyChecks')), {
      P31: false, P32: false, P34: true, P33: false,
      'board:P31': false, 'board:P32': true, 'board:P34': false, 'board:PS3': false,
    });
    saves.length = 0;
    await click(app.dom, connectorCheck);
    assert.equal(boardCheck.checked, false, 'checking one side should not affect the other');
    await click(app.dom, boardCheck);
    assert.equal(revision.checked, true);
    assert.equal(connectorCheck.checked, true);
    assert.equal(revision.nextElementSibling.textContent, '✅');
    assert.equal(saves.length, 0, 'toggling should wait for the shared save');
    assert.ok(document.querySelector('.status-text.warning'));
    app.dom.window.confirm = () => true;
    const cancelButton = [...document.querySelectorAll('.record-detail-common button')]
      .find((button) => button.textContent === 'キャンセル');
    await click(app.dom, cancelButton);
    assert.equal(revision.checked, false);
    assert.equal(connectorCheck.checked, false);
    assert.equal(boardCheck.checked, false);
    assert.equal(dustCap.checked, true);
    await click(app.dom, revision);
    await click(app.dom, connectorCheck);
    await click(app.dom, boardCheck);
    const seal = table.querySelector('input[aria-label="AUX 封印確認を確認"]');
    await click(app.dom, seal);
    await click(app.dom, saveButton);
    await waitFor(() => saves.length === 1, 'save was not submitted');
    assert.ok(document.body.textContent.includes('外観確認の保存に失敗しました。'));
    assert.equal(revision.checked, true);
    assert.equal(connectorCheck.checked, true);
    assert.equal(boardCheck.checked, true);
    assert.ok(document.querySelector('.status-text.warning'));
    failSave = false;
    await click(app.dom, saveButton);
    await waitFor(() => saves.length === 2, 'save retry was not submitted');
    assert.equal(JSON.parse(saves[1].get('appearanceChecks'))['boardRevision:PWS132'], true);
    assert.equal(JSON.parse(saves[1].get('appearanceChecks'))['dustCap:MDM57'], true);
    assert.equal(JSON.parse(saves[1].get('appearanceChecks'))['seal:AUX'], true);
    assert.deepEqual(JSON.parse(saves[1].get('insertionKeyChecks')), {
      P31: true, P32: true, P34: true, P33: true,
      'board:P31': true, 'board:P32': true, 'board:P34': true, 'board:PS3': true,
    });
    assert.equal(document.querySelector('.status-text.warning'), null);
    await click(app.dom, revision);
    await click(app.dom, connectorCheck);
    await click(app.dom, boardCheck);
    await click(app.dom, cancelButton);
    assert.equal(revision.checked, true, 'cancel should restore the latest successful save');
    assert.equal(connectorCheck.checked, true, 'cancel should restore the saved connector check');
    assert.equal(boardCheck.checked, true, 'cancel should restore the saved board check');
    await click(app.dom, connectorCheck);
    await click(app.dom, boardCheck);
    await click(app.dom, saveButton);
    await waitFor(() => saves.length === 3, 'clearing both sides was not submitted');
    assert.ok(Object.values(JSON.parse(saves[2].get('insertionKeyChecks'))).every((checked) => checked === false));
  } finally {
    await app.cleanup();
  }
});
