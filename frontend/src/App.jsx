import { useEffect, useRef, useState } from 'react';
import TrialResults from './TrialResults';
import Workflow from './Workflow';
import WorkflowInbox from './WorkflowInbox';
import UserManagement from './UserManagement';
import PasswordChange from './PasswordChange';

// 添付ファイルの最大サイズは 100MB。
// 画面遷移ごとの見出し文言と検索条件の初期値をまとめて管理する。
const MAX_FILE_SIZE = 100 * 1024 * 1024;
const MAX_TOTAL_FILE_SIZE = 100 * 1024 * 1024;
const MIN_COMMON_PANEL_WIDTH = 220;
const MAX_COMMON_PANEL_WIDTH = 640;
const MIN_WORKSPACE_WIDTH = 280;
const DETAIL_RESIZER_WIDTH = 12;
const DETAIL_COLUMN_GAP = 24;
const DEFAULT_SOFTWARE_SECTIONS = [
  {
    key: 'software-install',
    title: 'インストールソフト',
    rows: [{ name: 'テストプロ', sdFormat: 'TEST0306' }],
  },
  {
    key: 'pld-version',
    title: 'PLDバージョン',
    rows: [
      { name: 'PWM85 基板 FPGA', sdFormat: 'XPLD0885' },
      { name: 'INF267 基板 FPGA', sdFormat: 'XPLD0856' },
    ],
  },
];
const SECTION_DETAILS = {
  dashboardSection: {
    title: '試験記録の管理',
    description: '制御ユニットのルーチン試験結果を登録・参照します。',
  },
  registerSection: {
    title: '記録の登録',
    description: '新しい試験記録を登録します。',
  },
  searchSection: {
    title: '記録の検索',
    description: '登録済みの試験記録を検索できます。',
  },
  workflowInboxSection: {
    title: '回覧タスク',
    description: 'ログイン中の担当者に割り当てられた回覧を確認します。',
  },
  userManagementSection: {
    title: 'ユーザー管理',
    description: '担当者アカウントを作成・管理します。',
  },
  passwordChangeSection: {
    title: 'パスワード変更',
    description: '自分のパスワードを変更します。',
  },
};
const EMPTY_FILTERS = {
  trialNo: '',
  projectName: '',
  productNo: '',
  date: '',
  manager: '',
};
let registrationRowSequence = 0;

// API 通信で 4xx/5xx を分かりやすく扱うためのエラー型。
class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// 共通の fetch ラッパー。
// CSRF トークン付きの POST/PUT/DELETE だけヘッダーを付与する。
async function apiRequest(url, csrfToken, options = {}) {
  const headers = new Headers(options.headers || {});
  if (csrfToken && options.method && options.method !== 'GET') {
    headers.set('X-CSRF-Token', csrfToken);
  }
  const response = await fetch(url, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(
      data.error || '通信に失敗しました。',
      response.status,
    );
  }
  return data;
}

function todayDateString() {
  const today = new Date();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  return `${today.getFullYear()}${month}${day}`;
}

function emptyRegistrationValues() {
  return {
    rowId: ++registrationRowSequence,
    trialNo: '',
    projectName: '',
    productNo: '',
    registrationDate: todayDateString(),
    manager: '',
    resultFile: null,
  };
}

function formatRegistrationDate(value) {
  if (value.length !== 8) {
    return value;
  }
  return `${value.slice(0, 4)}/${value.slice(4, 6)}/${value.slice(6, 8)}`;
}

function buildManagerStats(records, year) {
  const countsByManager = new Map();
  for (const record of records) {
    if (
      typeof record.registrationDate !== 'string'
      || !record.registrationDate.startsWith(String(year))
      || typeof record.manager !== 'string'
    ) {
      continue;
    }
    const month = Number(record.registrationDate.slice(4, 6));
    if (!Number.isInteger(month) || month < 1 || month > 12) continue;
    const counts = countsByManager.get(record.manager) || Array(12).fill(0);
    counts[month - 1] += 1;
    countsByManager.set(record.manager, counts);
  }
  return {
    year,
    managers: [...countsByManager.entries()]
      .sort(([first], [second]) => first.localeCompare(second, 'ja'))
      .map(([name, counts]) => ({ name, counts })),
  };
}

const CHART_COLORS = ['#17658a', '#ef6b2e', '#1d702b', '#00a2d8', '#a62698', '#58a83b'];
const CHART_WIDTH = 760;
const CHART_HEIGHT = 350;
const CHART_LEFT = 58;
const CHART_RIGHT = 744;
const CHART_TOP = 24;
const CHART_BOTTOM = 258;
const CHART_PLOT_HEIGHT = CHART_BOTTOM - CHART_TOP;
const CHART_PLOT_WIDTH = CHART_RIGHT - CHART_LEFT;

function getCountScale(managers) {
  const maximumCount = Math.max(0, ...managers.flatMap((manager) => manager.counts));
  if (maximumCount === 0) return { maximum: 1, step: 1 };
  const targetStep = maximumCount / 7;
  const magnitude = 10 ** Math.floor(Math.log10(targetStep));
  const normalizedStep = targetStep / magnitude;
  const step = (normalizedStep <= 1 ? 1 : normalizedStep <= 2 ? 2 : normalizedStep <= 5 ? 5 : 10) * magnitude;
  return { maximum: Math.ceil(maximumCount / step) * step, step };
}

function ManagerChartLegend({ managers }) {
  return (
    <ul className="manager-chart-legend">
      {managers.map((manager, index) => (
        <li key={manager.name}>
          <span className="manager-chart-swatch" style={{ backgroundColor: CHART_COLORS[index % CHART_COLORS.length] }} aria-hidden="true"></span>
          {manager.name}
        </li>
      ))}
    </ul>
  );
}

function ManagerMonthlyChart({ managerStats, mode }) {
  const isRateChart = mode === 'rate';
  const title = isRateChart ? '対応比率' : '対応件数';
  const managers = managerStats?.managers || [];
  const hasData = managers.some((manager) => manager.counts.some((count) => count > 0));
  const { maximum, step } = getCountScale(managers);
  const countTicks = Array.from({ length: Math.floor(maximum / step) + 1 }, (_, index) => index * step);
  const months = Array.from({ length: 12 }, (_, index) => index + 1);
  const formatRate = (rate) => `${Number(rate.toFixed(1))}%`;

  return (
    <article className="content-card manager-chart-card">
      <div className="manager-chart-heading">
        <h2>{title}</h2>
        <span>{managerStats?.year ? `${managerStats.year}年` : '年間集計'}</span>
      </div>
      {hasData ? (
        <>
          <div className="manager-chart-scroll">
            <svg
              className="manager-chart-svg"
              viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
              role="img"
              aria-label={`${managerStats.year}年の個人別月次${title}${isRateChart ? '。比率は月ごとの対応件数を合計した値に対する割合です。' : ''}`}
            >
              <title>{`${managerStats.year}年の${title}`}</title>
              {(isRateChart ? [0, 20, 40, 60, 80, 100] : countTicks).map((tick) => {
                const y = isRateChart
                  ? CHART_BOTTOM - (tick / 100) * CHART_PLOT_HEIGHT
                  : CHART_BOTTOM - (tick / maximum) * CHART_PLOT_HEIGHT;
                return (
                  <g key={tick}>
                    <line x1={CHART_LEFT} x2={CHART_RIGHT} y1={y} y2={y} className="manager-chart-gridline" />
                    <text x={CHART_LEFT - 9} y={y + 4} textAnchor="end" className="manager-chart-axis-label">
                      {isRateChart ? `${tick}%` : tick}
                    </text>
                  </g>
                );
              })}
              {months.map((month, monthIndex) => {
                const x = CHART_LEFT + (CHART_PLOT_WIDTH * (monthIndex + 0.5)) / 12;
                return (
                  <text
                    key={month}
                    x={x}
                    y={CHART_BOTTOM + 40}
                    transform={`rotate(-45 ${x} ${CHART_BOTTOM + 40})`}
                    textAnchor="end"
                    className="manager-chart-axis-label"
                  >
                    {managerStats.year}年{month}月
                  </text>
                );
              })}
              {isRateChart ? months.map((month, monthIndex) => {
                const total = managers.reduce((sum, manager) => sum + manager.counts[monthIndex], 0);
                let stackedCount = 0;
                const x = CHART_LEFT + (CHART_PLOT_WIDTH * (monthIndex + 0.5)) / 12;
                return managers.map((manager, managerIndex) => {
                  const count = manager.counts[monthIndex];
                  if (count === 0 || total === 0) return null;
                  const height = (count / total) * CHART_PLOT_HEIGHT;
                  const y = CHART_BOTTOM - ((stackedCount + count) / total) * CHART_PLOT_HEIGHT;
                  stackedCount += count;
                  return (
                    <rect
                      key={`${month}-${manager.name}`}
                      x={x - 16}
                      y={y}
                      width="32"
                      height={height}
                      fill={CHART_COLORS[managerIndex % CHART_COLORS.length]}
                    >
                      <title>{`${manager.name}: ${formatRate((count / total) * 100)} (${count}/${total}件)`}</title>
                    </rect>
                  );
                });
              }) : managers.map((manager, managerIndex) => {
                const points = manager.counts.map((count, monthIndex) => {
                  const x = CHART_LEFT + (CHART_PLOT_WIDTH * (monthIndex + 0.5)) / 12;
                  const y = CHART_BOTTOM - (count / maximum) * CHART_PLOT_HEIGHT;
                  return { x, y, count };
                });
                return (
                  <g key={manager.name}>
                    <polyline
                      points={points.map(({ x, y }) => `${x},${y}`).join(' ')}
                      fill="none"
                      stroke={CHART_COLORS[managerIndex % CHART_COLORS.length]}
                      strokeWidth="3"
                      strokeLinejoin="round"
                      strokeLinecap="round"
                    />
                    {points.map(({ x, y, count }, monthIndex) => (
                      <circle
                        key={monthIndex}
                        cx={x}
                        cy={y}
                        r="4"
                        fill={CHART_COLORS[managerIndex % CHART_COLORS.length]}
                      >
                        <title>{`${manager.name}: ${count}件`}</title>
                      </circle>
                    ))}
                  </g>
                );
              })}
            </svg>
          </div>
          <ManagerChartLegend managers={managers} />
        </>
      ) : (
        <p className="dashboard-chart-empty">
          {managerStats ? `${managerStats.year}年の対応記録はありません。` : '集計を読み込み中です。'}
        </p>
      )}
    </article>
  );
}

// フォーム入力値の妥当性をチェックする。
// バリデーションは画面側でも行い、サーバー側の入力チェックと齟齬が起きにくくする。
function validateRegistration(values) {
  const validText = (value, maxLength, pattern) => (
    Boolean(value.trim())
    && value.trim().length <= maxLength
    && pattern.test(value.trim())
  );
  if (!validText(values.trialNo, 20, /^[A-Za-z0-9-]+$/)) {
    return '試験番号は半角英数字またはハイフンで20文字以内で入力してください。';
  }
  if (values.projectName.trim() && !validText(values.projectName, 30, /^[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF0-9A-Za-z\s-]+$/)) {
    return '案件名は日本語または英数字で30文字以内で入力してください。';
  }
  if (values.productNo.trim() && !validText(values.productNo, 30, /^[A-Za-z0-9 -]+$/)) {
    return '製番は30文字以内で、スペースを含む半角英数字を入力してください。';
  }
  if (!/^\d{8}$/.test(values.registrationDate.trim())) {
    return '登録日はyyyymmdd形式で入力してください。';
  }
  if (!validText(
    values.manager,
    30,
    /^[\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Han}\s]+$/u,
  )) {
    return '担当者は日本語で入力してください。';
  }
  return '';
}

function Message({ children, type = '' }) {
  return (
    <p className={`status-text${type ? ` ${type}` : ''}`} aria-live="polite">
      {children}
    </p>
  );
}

function App() {
  // csrfToken は再レンダリングのたびに変わらないよう useRef で保持する。
  const csrfToken = useRef('');
  // 登録フォームのリセットに使う参照。
  const registerForm = useRef(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [username, setUsername] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [detailRecordId] = useState(() => new URLSearchParams(window.location.search).get('recordId'));
  const [section, setSection] = useState('dashboardSection');
  const [loginError, setLoginError] = useState('');
  const [sessionMessage, setSessionMessage] = useState('');
  const [dashboard, setDashboard] = useState(null);
  const [dashboardMessage, setDashboardMessage] = useState({ text: '', type: '' });
  const [registerMessage, setRegisterMessage] = useState({ text: '', type: '' });
  const [searchMessage, setSearchMessage] = useState({ text: '', type: '' });
  const [searchFilters, setSearchFilters] = useState(EMPTY_FILTERS);
  const [records, setRecords] = useState([]);
  const [registrationRows, setRegistrationRows] = useState(() => [emptyRegistrationValues()]);
  const [editingRecordId, setEditingRecordId] = useState(null);
  const [existingFiles, setExistingFiles] = useState([]);
  const [previewFiles, setPreviewFiles] = useState([]);
  const [removedFileIds, setRemovedFileIds] = useState([]);
  const [registering, setRegistering] = useState(false);
  const [deletingRecordId, setDeletingRecordId] = useState(null);
  const [selectedRecordId, setSelectedRecordId] = useState(null);
  const [detailRecord, setDetailRecord] = useState(null);
  const [detailEquipment, setDetailEquipment] = useState(null);
  const [instrumentChoices, setInstrumentChoices] = useState([]);
  const [managerChoices, setManagerChoices] = useState(null);
  const [workflowUsers, setWorkflowUsers] = useState([]);
  const [softwareSections, setSoftwareSections] = useState(DEFAULT_SOFTWARE_SECTIONS);
  const [detailJumpers, setDetailJumpers] = useState(null);
  const [detailAppearance, setDetailAppearance] = useState(null);
  const [detailInsertionKeys, setDetailInsertionKeys] = useState(null);
  const [detailManualTests, setDetailManualTests] = useState(null);
  const [detailManualConditions, setDetailManualConditions] = useState(null);
  const savedDetails = useRef({ equipment: null, jumpers: null, appearance: null, insertionKeys: null, manualTests: null, manualConditions: null });
  const [detailMessage, setDetailMessage] = useState({ text: '', type: '' });
  const [recordDirty, setRecordDirty] = useState(false);

  // 初期表示時にセッション状態を確認し、ログイン済みならそのままアプリ画面を表示する。
  useEffect(() => {
    let active = true;
    apiRequest('/api/session', '').then((session) => {
      if (!active) return;
      csrfToken.current = session.csrfToken;
      if (session.authenticated) {
        setUsername(session.displayName || session.username);
        setIsAdmin(session.role === 'admin');
        setAuthenticated(true);
      }
    }).catch((error) => {
      if (active) setLoginError(`サーバーに接続できません。${error.message}`);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!authenticated || detailRecordId !== null) return undefined;
    let active = true;
    Promise.all([
      apiRequest('/api/equipment-config', csrfToken.current),
      apiRequest('/api/workflow-users', csrfToken.current),
    ]).then(([config, assignees]) => {
      if (!active) return;
      setManagerChoices(config.managerChoices);
      setWorkflowUsers(assignees.users);
      setSoftwareSections(config.softwareSections || DEFAULT_SOFTWARE_SECTIONS);
    }).catch((error) => {
      if (!active) return;
      setManagerChoices([]);
      setWorkflowUsers([]);
      setRegisterMessage({ text: error.message, type: 'error' });
      if (error instanceof ApiError && error.status === 401) {
        csrfToken.current = '';
        setAuthenticated(false);
        setLoginError(error.message);
      }
    });
    return () => { active = false; };
  }, [authenticated, detailRecordId]);

  useEffect(() => {
    if (!authenticated || detailRecordId !== null || section !== 'dashboardSection') return undefined;
    let active = true;
    async function loadDashboard() {
      try {
        const summary = await apiRequest('/api/dashboard', csrfToken.current);
        if (!active) return;
        setDashboard(summary);
        setDashboardMessage({ text: '', type: '' });
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          try {
            const allRecords = await apiRequest('/api/records', csrfToken.current);
            if (!active) return;
            const now = new Date();
            const currentMonth = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
            setDashboard({
              totalRecords: allRecords.length,
              monthRecords: allRecords.filter((record) => record.registrationDate.startsWith(currentMonth)).length,
              currentMonth: `${now.getFullYear()}年${now.getMonth() + 1}月`,
              managerStats: buildManagerStats(allRecords, now.getFullYear()),
            });
            setDashboardMessage({
              text: '集計APIを利用できないため、記録一覧から集計しています。アプリサーバーを再起動してください。',
              type: 'warning',
            });
            return;
          } catch (fallbackError) {
            if (active) {
              setDashboardMessage({ text: fallbackError.message, type: 'error' });
            }
            return;
          }
        }
        if (active) {
          if (error instanceof ApiError && error.status === 401) {
            csrfToken.current = '';
            setAuthenticated(false);
            setLoginError(error.message);
          }
          setDashboardMessage({ text: error.message, type: 'error' });
        }
      }
    }
    loadDashboard();
    return () => {
      active = false;
    };
  }, [authenticated, section, detailRecordId]);

  useEffect(() => {
    if (!authenticated || detailRecordId === null) return undefined;
    let active = true;
    if (!/^[1-9]\d*$/.test(detailRecordId)) {
      setDetailMessage({ text: '記録IDが正しくありません。', type: 'error' });
      return undefined;
    }
    setDetailMessage({ text: '記録を読み込み中...', type: '' });
    Promise.all([
      apiRequest('/api/records', csrfToken.current),
      apiRequest(`/api/records/${detailRecordId}/equipment`, csrfToken.current),
      apiRequest(`/api/records/${detailRecordId}/jumpers`, csrfToken.current),
      apiRequest('/api/equipment-config', csrfToken.current),
      apiRequest(`/api/records/${detailRecordId}/appearance-checks`, csrfToken.current),
      apiRequest(`/api/records/${detailRecordId}/insertion-keys`, csrfToken.current),
      apiRequest(`/api/records/${detailRecordId}/manual-tests`, csrfToken.current),
      apiRequest(`/api/records/${detailRecordId}/manual-test-conditions`, csrfToken.current),
      apiRequest('/api/workflow-users', csrfToken.current),
    ]).then(([result, equipment, jumpers, config, appearance, insertionKeys, manualTests, manualConditions, assignees]) => {
      if (!active) return;
      const record = result.find((item) => String(item.id) === detailRecordId);
      if (!record) {
        setDetailMessage({ text: '記録が見つかりません。削除された可能性があります。', type: 'error' });
        return;
      }
      handleEditRecord(record);
      setDetailEquipment(equipment);
      setInstrumentChoices(config.instrumentChoices);
      setManagerChoices(config.managerChoices);
      setWorkflowUsers(assignees.users);
      setSoftwareSections(config.softwareSections || DEFAULT_SOFTWARE_SECTIONS);
      setDetailJumpers(jumpers);
      setDetailAppearance(appearance);
      setDetailInsertionKeys(insertionKeys);
      const loadedManualTests = Array.isArray(manualTests) ? manualTests : [];
      setDetailManualTests(loadedManualTests);
      setDetailManualConditions(manualConditions);
      savedDetails.current = { equipment, jumpers, appearance, insertionKeys, manualTests: loadedManualTests, manualConditions };
      setDetailMessage({ text: '', type: '' });
    }).catch((error) => {
      if (!active) return;
      setDetailMessage({ text: error.message, type: 'error' });
      if (error.status === 401) {
        csrfToken.current = '';
        setAuthenticated(false);
        setLoginError(error.message);
      }
    });
    return () => { active = false; };
  }, [authenticated, detailRecordId]);

  useEffect(() => {
    if (!authenticated || detailRecordId !== null || section !== 'searchSection') return undefined;
    const refresh = () => setSearchFilters((filters) => ({ ...filters }));
    const handleVisibility = () => { if (document.visibilityState === 'visible') refresh(); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [authenticated, detailRecordId, section]);

  useEffect(() => {
    if (!authenticated || section !== 'searchSection') return undefined;
    let active = true;
    const timer = window.setTimeout(async () => {
      const params = new URLSearchParams(searchFilters);
      try {
        const result = await apiRequest(`/api/records?${params}`, csrfToken.current);
        if (active) {
          setRecords(result);
          setSearchMessage({ text: '', type: '' });
        }
      } catch (error) {
        if (active) {
          setSearchMessage({ text: error.message, type: 'error' });
          if (error instanceof ApiError && error.status === 401) {
            csrfToken.current = '';
            setAuthenticated(false);
            setLoginError(error.message);
          }
        }
      }
    }, 200);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [authenticated, section, searchFilters]);

  function navigateTo(target) {
    if (SECTION_DETAILS[target]) {
      setSection(target);
    }
  }

  function openRecordDetails(record) {
    setSelectedRecordId(record.id);
    window.open(`/?recordId=${encodeURIComponent(record.id)}`, '_blank', 'noopener,noreferrer');
  }

  function clearRegistrationDraft() {
    registerForm.current?.reset();
    setRegistrationRows([emptyRegistrationValues()]);
    setEditingRecordId(null);
    setExistingFiles([]);
    setPreviewFiles([]);
    setRemovedFileIds([]);
    setRecordDirty(false);
    setDetailEquipment(null);
    setDetailJumpers(null);
    setDetailAppearance(null);
    setDetailInsertionKeys(null);
    setDetailManualTests(null);
    setDetailManualConditions(null);
    savedDetails.current = { equipment: null, jumpers: null, appearance: null, insertionKeys: null, manualTests: null, manualConditions: null };
  }

  // ログイン処理。
  // サーバーへ ID / パスワードを送信し、成功したらログイン状態を切り替える。
  async function handleLogin(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const result = await apiRequest('/api/login', csrfToken.current, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: form.get('userId'),
          password: form.get('password'),
        }),
      });
      csrfToken.current = result.csrfToken;
      setUsername(result.displayName || result.username);
      setIsAdmin(result.role === 'admin');
      setLoginError('');
      setSessionMessage('');
      setAuthenticated(true);
      setSection('dashboardSection');
    } catch (error) {
      setLoginError(error.message);
    }
  }

  // ログアウト処理。
  // サーバー側セッションを終了し、画面をログイン状態へ戻す。
  async function handleLogout() {
    try {
      await apiRequest('/api/logout', csrfToken.current, { method: 'POST' });
      csrfToken.current = '';
      setAuthenticated(false);
      setUsername('');
      setIsAdmin(false);
      setDashboard(null);
      setLoginError('');
      setSessionMessage('');
      setRegisterMessage({ text: '', type: '' });
      setSearchMessage({ text: '', type: '' });
      setDetailRecord(null);
      clearRegistrationDraft();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        csrfToken.current = '';
        setAuthenticated(false);
        setLoginError(error.message);
        clearRegistrationDraft();
      } else {
        setSessionMessage(error.message);
      }
    }
  }

  async function allocateTrialNumber(rowId) {
    try {
      const result = await apiRequest(
        '/api/trial-numbers/next',
        csrfToken.current,
        { method: 'POST' },
      );
      setRegistrationRows((current) => current.map((row) => (
        row.rowId === rowId ? { ...row, trialNo: result.trialNo } : row
      )));
      setRegisterMessage({ text: `試験番号「${result.trialNo}」を採番しました。`, type: 'success' });
      return true;
    } catch (error) {
      setRegisterMessage({ text: error.message, type: 'error' });
      if (error instanceof ApiError && error.status === 401) {
        csrfToken.current = '';
        setAuthenticated(false);
        setLoginError(error.message);
      }
      return false;
    }
  }

  // 試験記録の登録・変更処理。複数件の新規登録は JSON、それ以外はフォームデータで送信する。
  async function handleRegister(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const isEditing = editingRecordId !== null;
    if (isEditing) {
      if (!detailEquipment || !detailJumpers || !detailAppearance || !detailInsertionKeys || !detailManualTests || !detailManualConditions) {
        setRegisterMessage({ text: '詳細情報の読み込みが完了していません。', type: 'error' });
        return;
      }
      if (['boards', 'instruments', 'software', 'shippingSoftware'].some((group) => detailEquipment[group].some((row) => (
        Object.values(row).some((value) => typeof value !== 'string' || value.length > 100)
      )))) {
        setRegisterMessage({ text: '機器情報の各項目は100文字以内で入力してください。', type: 'error' });
        return;
      }
      formData.set('equipment', JSON.stringify(detailEquipment));
      formData.set('jumperChecks', JSON.stringify(Object.fromEntries(
        detailJumpers.map((jumper) => [jumper.name, jumper.confirmed]),
      )));
      formData.set('appearanceChecks', JSON.stringify(detailAppearance.checks));
      formData.set('insertionKeyChecks', JSON.stringify(Object.fromEntries(
        detailInsertionKeys.map((connector) => [connector.name, connector.confirmed]),
      )));
      formData.set('manualTestResults', JSON.stringify(Object.fromEntries(
        detailManualTests.flatMap((test) => test.items).map((item) => [
          item.key,
          {
            measuredValue: item.measuredValue,
            benchLockChecked: item.benchLockChecked,
          },
        ]),
      )));
      formData.set('manualTestConditions', JSON.stringify(detailManualConditions));
    }
    const fieldNames = ['trialNo', 'projectName', 'productNo', 'registrationDate', 'manager'];
    const valuesList = isEditing
      ? [Object.fromEntries(fieldNames.map((name) => [name, String(formData.get(name) || '').trim()]))]
      : registrationRows.map((row) => Object.fromEntries(
        fieldNames.map((name) => [name, String(row[name] || '').trim()]),
      ));
    const validationError = valuesList
      .map((values, index) => ({ error: validateRegistration(values), index }))
      .find(({ error }) => error);
    if (validationError) {
      const prefix = valuesList.length > 1 ? `${validationError.index + 1}件目: ` : '';
      setRegisterMessage({ text: `${prefix}${validationError.error}`, type: 'error' });
      return;
    }
    const selectedFiles = isEditing
      ? formData.getAll('resultFiles').filter((file) => file instanceof File && file.name)
      : registrationRows.map((row) => row.resultFile).filter((file) => file instanceof File && file.name);
    if (isEditing && selectedFiles.length > 1) {
      setRegisterMessage({ text: '試験結果ファイルは1件だけ登録できます。', type: 'error' });
      return;
    }
    if (selectedFiles.some((file) => !/\.csv$/i.test(file.name))) {
      setRegisterMessage({ text: '試験結果ファイルはCSV形式（.csv）を選択してください。', type: 'error' });
      return;
    }
    if (selectedFiles.some((file) => file.size > MAX_FILE_SIZE)) {
      setRegisterMessage({ text: '添付ファイルは1件あたり100 MB以下にしてください。', type: 'error' });
      return;
    }
    if (selectedFiles.reduce((total, file) => total + file.size, 0) > MAX_TOTAL_FILE_SIZE) {
      setRegisterMessage({ text: '添付ファイルの合計は100 MB以下にしてください。', type: 'error' });
      return;
    }
    if (isEditing) {
      const filesToRemove = existingFiles
        .filter((file) => removedFileIds.includes(file.id))
        .map((file) => file.fileName);
      if (filesToRemove.length && !window.confirm(
        `次の添付ファイルを削除します。\n${filesToRemove.join('\n')}\n続行しますか？`,
      )) {
        return;
      }
      removedFileIds.forEach((fileId) => formData.append('removeFileIds', String(fileId)));
    }

    setRegistering(true);
    try {
      const requestOptions = { method: isEditing ? 'PUT' : 'POST' };
      let requestUrl = '/api/records';
      if (isEditing) {
        requestUrl = `/api/records/${encodeURIComponent(editingRecordId)}/details`;
        requestOptions.body = formData;
      } else if (valuesList.length > 1) {
        requestUrl = '/api/records/batch';
        const batchFormData = new FormData();
        batchFormData.set('submissions', JSON.stringify(valuesList));
        registrationRows.forEach((row, index) => {
          if (row.resultFile instanceof File && row.resultFile.name) {
            batchFormData.append(`resultFiles-${index}`, row.resultFile);
          }
        });
        requestOptions.body = batchFormData;
      } else {
        fieldNames.forEach((name) => formData.set(name, valuesList[0][name]));
        if (registrationRows[0].resultFile instanceof File && registrationRows[0].resultFile.name) {
          formData.append('resultFiles', registrationRows[0].resultFile);
        }
        requestOptions.body = formData;
      }
      const result = await apiRequest(requestUrl, csrfToken.current, requestOptions);
      if (isEditing) {
        handleEditRecord(result.record);
        const updatedJumpers = detailJumpers.map((jumper) => ({ ...jumper, confirmed: result.jumperChecks[jumper.name] }));
        const updatedAppearance = { ...detailAppearance, checks: result.appearanceChecks };
        setDetailEquipment(result.equipment);
        setDetailJumpers(updatedJumpers);
        setDetailAppearance(updatedAppearance);
        setDetailInsertionKeys(result.insertionKeys);
        setDetailManualTests(result.manualTests);
        setDetailManualConditions(result.manualTestConditions);
        savedDetails.current = {
          equipment: result.equipment, jumpers: updatedJumpers,
          appearance: updatedAppearance, insertionKeys: result.insertionKeys,
          manualTests: result.manualTests, manualConditions: result.manualTestConditions,
        };
      } else {
        const createdRecords = result.records || [{
          id: result.id,
          ...valuesList[0],
          files: result.files || [],
        }];
        setRecords((current) => [
          ...createdRecords.map((record) => ({ ...record, files: record.files || [] })).reverse(),
          ...current,
        ]);
        setSelectedRecordId(createdRecords[createdRecords.length - 1].id);
        setSearchFilters({ ...EMPTY_FILTERS });
        clearRegistrationDraft();
        setSection('searchSection');
      }
      setRegisterMessage({
        text: isEditing ? '記録を変更しました。' : `登録が完了しました（${valuesList.length}件）。`,
        type: 'success',
      });
    } catch (error) {
      setRegisterMessage({ text: error.message, type: 'error' });
      if (error instanceof ApiError && error.status === 401) {
        csrfToken.current = '';
        setAuthenticated(false);
        setLoginError(error.message);
        clearRegistrationDraft();
      }
    } finally {
      setRegistering(false);
    }
  }

  function handleCopyRecord(record) {
    setSection('registerSection');
    setEditingRecordId(null);
    setRecordDirty(true);
    setExistingFiles([]);
    setRemovedFileIds([]);
    setRegistrationRows([{
      rowId: ++registrationRowSequence,
      trialNo: record.trialNo,
      projectName: record.projectName,
      productNo: record.productNo,
      registrationDate: record.registrationDate,
      manager: record.manager,
      resultFile: null,
    }]);
    setRegisterMessage({
      text: '記録をコピーしました。必要に応じて新しい試験結果CSVを選択してください。',
      type: 'success',
    });
  }

  function handleEditRecord(record) {
    registerForm.current?.reset();
    setPreviewFiles([]);
    setDetailRecord(record);
    setRecordDirty(false);
    setEditingRecordId(record.id);
    setExistingFiles(record.files || []);
    setRemovedFileIds([]);
    setRegistrationRows([{
      rowId: ++registrationRowSequence,
      trialNo: record.trialNo,
      projectName: record.projectName,
      productNo: record.productNo,
      registrationDate: record.registrationDate,
      manager: record.manager,
    }]);
    setRegisterMessage({ text: '', type: '' });
  }

  function handleDetailFilesChanged(recordId, files) {
    setExistingFiles(files);
    setDetailRecord((current) => current && current.id === recordId
      ? { ...current, files, fileName: files[0]?.fileName || null }
      : current);
  }

  function handlePowerBoardReportChanged(recordId, powerBoardReport) {
    setRecords((current) => current.map((item) => item.id === recordId
      ? { ...item, powerBoardReport }
      : item));
    setDetailRecord((current) => current && current.id === recordId
      ? { ...current, powerBoardReport }
      : current);
  }

  async function handleDeleteRecord(record) {
    if (!window.confirm(
      `試験番号「${record.trialNo}」の記録と添付ファイルを削除します。この操作は取り消せません。`,
    )) {
      return;
    }

    setDeletingRecordId(record.id);
    try {
      await apiRequest(`/api/records/${encodeURIComponent(record.id)}`, csrfToken.current, {
        method: 'DELETE',
      });
      setRecords((currentRecords) => currentRecords.filter((item) => item.id !== record.id));
      setSearchMessage({ text: '記録を削除しました。', type: 'success' });
    } catch (error) {
      setSearchMessage({ text: error.message, type: 'error' });
      if (error instanceof ApiError && error.status === 401) {
        csrfToken.current = '';
        setAuthenticated(false);
        setLoginError(error.message);
      }
    } finally {
      setDeletingRecordId(null);
    }
  }

  // 登録フォームの入力をクリアして、今日の日付を再設定する。
  function cancelRegister() {
    if (detailRecord) {
      if (recordDirty && !window.confirm('未保存の変更をすべて破棄しますか？')) return;
      handleEditRecord(detailRecord);
      setDetailEquipment(savedDetails.current.equipment);
      setDetailJumpers(savedDetails.current.jumpers);
      setDetailAppearance(savedDetails.current.appearance);
      setDetailInsertionKeys(savedDetails.current.insertionKeys);
      setDetailManualTests(savedDetails.current.manualTests);
      setDetailManualConditions(savedDetails.current.manualConditions);
    } else {
      if (recordDirty && !window.confirm('未保存の入力を破棄して記録の検索画面へ移動しますか？')) return;
      clearRegistrationDraft();
      setSection('searchSection');
    }
    setRegisterMessage({ text: '', type: '' });
  }

  // 未ログイン時はログイン画面のみを表示し、認証後にメインアプリを描画する。
  if (!authenticated) {
    return (
      <div className="screen login-screen active">
        <div className="login-card">
          <h1>試験記録台帳</h1>
          <p className="subtitle">ログインしてください</p>
          <form id="loginForm" onSubmit={handleLogin}>
            <label className="field">
              <span>ユーザID</span>
              <input name="userId" type="text" autoComplete="username" required />
            </label>
            <label className="field">
              <span>パスワード</span>
              <input name="password" type="password" autoComplete="current-password" required />
            </label>
            <button type="submit" className="primary-button">ログイン</button>
            <p className="error-text" aria-live="polite">{loginError}</p>
          </form>
        </div>
      </div>
    );
  }

  const details = SECTION_DETAILS[section];
  const pageTitle = details.title;
  const pageDescription = details.description;

  const registrationForm = (
    <RegistrationForm
      registerForm={registerForm}
      handleRegister={handleRegister}
      registrationRows={registrationRows}
      setRegistrationRows={setRegistrationRows}
      allocateTrialNumber={allocateTrialNumber}
      managerChoices={managerChoices}
      editingRecordId={editingRecordId}
      registering={registering}
      cancelRegister={cancelRegister}
      registerMessage={registerMessage}
      onChange={() => setRecordDirty(true)}
    />
  );

  if (detailRecordId !== null) {
    return (
      <main className="record-detail-page">
        {detailRecord ? (
          <RecordDetails
            key={detailRecord.id}
            record={detailRecord}
            csrfToken={csrfToken.current}
            onClose={() => window.close()}
            recordDirty={recordDirty}
            equipment={detailEquipment}
            instrumentChoices={instrumentChoices}
            managerChoices={managerChoices}
            workflowUsers={workflowUsers}
            setEquipment={setDetailEquipment}
            jumpers={detailJumpers}
            setJumpers={setDetailJumpers}
            appearance={detailAppearance}
            setAppearance={setDetailAppearance}
            insertionKeys={detailInsertionKeys}
            setInsertionKeys={setDetailInsertionKeys}
            manualTests={detailManualTests}
            setManualTests={setDetailManualTests}
            softwareSections={softwareSections}
            manualConditions={detailManualConditions}
            setManualConditions={setDetailManualConditions}
            onDirty={() => setRecordDirty(true)}
            cancelRegister={cancelRegister}
            registerMessage={registerMessage}
            pendingFiles={previewFiles}
            removedFileIds={removedFileIds}
            registering={registering}
            registrationForm={registrationForm}
            existingFiles={existingFiles}
            onFilesChanged={handleDetailFilesChanged}
            onPowerBoardReportChanged={handlePowerBoardReportChanged}
            setAuthenticated={setAuthenticated}
            setLoginError={setLoginError}
          />
        ) : (
          <>
            <h1>記録の詳細</h1>
            <Message type={detailMessage.type}>{detailMessage.text || '記録を読み込み中...'}</Message>
            <a className="file-link" href="/">概要へ</a>
          </>
        )}
      </main>
    );
  }

  return (
    <div className="app-shell active">
      <aside className="sidebar">
        <a className="brand" href="#" onClick={(event) => { event.preventDefault(); navigateTo('dashboardSection'); }}>
          <span className="brand-mark" aria-hidden="true">試</span>
          <span>
            <span className="brand-kicker">TEST RECORD</span>
            <strong>試験記録台帳</strong>
          </span>
        </a>

        <nav className="side-nav" aria-label="メインメニュー">
          <NavLink target="dashboardSection" section={section} onNavigate={navigateTo} icon="⌂">概要</NavLink>
          <NavLink target="registerSection" section={section} onNavigate={navigateTo} icon="＋">記録の登録</NavLink>
          <NavLink target="searchSection" section={section} onNavigate={navigateTo} icon="⌕">記録の検索</NavLink>
          <NavLink target="workflowInboxSection" section={section} onNavigate={navigateTo} icon="↪">回覧タスク</NavLink>
          {isAdmin && <NavLink target="userManagementSection" section={section} onNavigate={navigateTo} icon="♙">ユーザー管理</NavLink>}
          <NavLink target="passwordChangeSection" section={section} onNavigate={navigateTo} icon="🔑">パスワード変更</NavLink>
        </nav>

        <div className="sidebar-bottom">
          <div className="sidebar-note">
            <span className="sidebar-note-icon" aria-hidden="true">i</span>
            <strong>試験記録を一元管理</strong>
            <p>登録した記録と試験結果を確認できます。</p>
          </div>
          <div className="user-card">
            <span className="user-avatar" aria-hidden="true">U</span>
            <div className="user-details">
              <strong>{username}</strong>
              <small>ログイン中</small>
            </div>
            <button type="button" className="logout-button" onClick={handleLogout}>ログアウト</button>
          </div>
        </div>
      </aside>

      <main className="main-area">
        <header className="page-header">
          <div>
            <p className="eyebrow"><span className="eyebrow-dash" aria-hidden="true"></span> TRIAL LEDGER</p>
            <h1>{pageTitle}</h1>
            <p>{pageDescription}</p>
          </div>
          <div className="page-header-actions">
            <span className="system-status"><span className="status-dot" aria-hidden="true"></span>システム稼働中</span>
          </div>
        </header>
        {sessionMessage && <Message type="error">{sessionMessage}</Message>}

        {section === 'dashboardSection' && (
          <section className="page-section active">
            <div className="dashboard-top">
              <article className="welcome-card">
                <p className="card-kicker">TRIAL RECORD MANAGEMENT</p>
                <h2>試験記録を<br />かんたんに管理</h2>
                <p>試験結果と関連情報を登録し、必要な記録をすぐに検索できます。</p>
                <div className="welcome-actions">
                  <button type="button" className="outline-button" onClick={() => navigateTo('registerSection')}>記録の登録</button>
                  <button type="button" className="outline-button" onClick={() => navigateTo('searchSection')}>記録の検索</button>
                </div>
                <span className="welcome-orbit" aria-hidden="true"></span>
              </article>
              <div className="stat-stack">
                <article className="stat-card">
                  <div className="stat-label"><span>登録済み記録</span><span className="gold-icon" aria-hidden="true">▤</span></div>
                  <div className="stat-value"><strong>{dashboard?.totalRecords ?? '-'}</strong><span>件</span></div>
                  <p className="stat-caption">これまでに登録された試験記録</p>
                </article>
                <article className="stat-card">
                  <div className="stat-label"><span>今月の登録</span><span className="gold-icon" aria-hidden="true">▦</span></div>
                  <div className="stat-value"><strong>{dashboard?.monthRecords ?? '-'}</strong><span>件</span></div>
                  <p className="stat-caption">{dashboard?.currentMonth || ''}</p>
                </article>
              </div>
            </div>
            {dashboardMessage.text && <Message type={dashboardMessage.type}>{dashboardMessage.text}</Message>}
            <div className="dashboard-bottom">
              <ManagerMonthlyChart managerStats={dashboard?.managerStats} mode="count" />
              <ManagerMonthlyChart managerStats={dashboard?.managerStats} mode="rate" />
            </div>
          </section>
        )}

        {section === 'registerSection' && (
          <section className="page-section active registration-page">
            {registrationForm}
          </section>
        )}

        {section === 'searchSection' && (
          <section className="page-section active">
            <div className="search-panel">
              <div className="search-grid">
                <SearchField label="試験番号" name="trialNo" fieldClassName="record-field-trial-no" value={searchFilters.trialNo} onChange={setSearchFilters} placeholder="試験番号" maxLength={20} />
                <SearchField label="案件名" name="projectName" fieldClassName="record-field-project-name" value={searchFilters.projectName} onChange={setSearchFilters} placeholder="案件名" maxLength={30} />
                <SearchField label="製番" name="productNo" fieldClassName="record-field-product-no" value={searchFilters.productNo} onChange={setSearchFilters} placeholder="製番" maxLength={30} />
                <SearchField label="登録日" name="date" fieldClassName="record-field-registration-date" value={searchFilters.date} onChange={setSearchFilters} placeholder="yyyymmdd" maxLength={8} />
                <SearchField label="担当者" name="manager" fieldClassName="record-field-manager" value={searchFilters.manager} onChange={setSearchFilters} placeholder="担当者" maxLength={30} />
              </div>
              {searchMessage.text && <Message type={searchMessage.type}>{searchMessage.text}</Message>}
            </div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>試験番号</th><th>案件名</th><th>製番</th><th>登録日</th><th>担当者</th><th>操作</th></tr></thead>
                <tbody>
                  {records.length ? records.map((record) => (
                    <tr
                      key={record.id}
                      className={`search-record-row${selectedRecordId === record.id ? ' selected' : ''}`}
                      tabIndex={0}
                      aria-label={`${record.trialNo}${selectedRecordId === record.id ? ' 選択中' : ''}`}
                      onClick={() => setSelectedRecordId(record.id)}
                      onDoubleClick={(event) => {
                        if (event.target.closest('button, a')) return;
                        openRecordDetails(record);
                      }}
                      onKeyDown={(event) => {
                        if (event.target !== event.currentTarget) return;
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          openRecordDetails(record);
                        } else if (event.key === ' ') {
                          event.preventDefault();
                          setSelectedRecordId(record.id);
                        }
                      }}
                    >
                      <td>{record.trialNo}</td>
                      <td>{record.projectName}</td>
                      <td>{record.productNo}</td>
                      <td>{record.registrationDate}</td>
                      <td>{record.manager}</td>
                      <td>
                        <div className="record-actions">
                          <a
                            className="copy-button secondary-button"
                            href={`/?recordId=${encodeURIComponent(record.id)}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            title="別タブで詳細を開く"
                            onClick={() => setSelectedRecordId(record.id)}
                          >
                            詳細
                          </a>
                          <button
                            type="button"
                            className="copy-button secondary-button"
                            onClick={() => handleCopyRecord(record)}
                          >
                            コピー
                          </button>
                          <button
                            type="button"
                            className="delete-button"
                            onClick={() => handleDeleteRecord(record)}
                            disabled={deletingRecordId !== null}
                          >
                            {deletingRecordId === record.id ? '削除中...' : '削除'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  )) : <tr><td colSpan="6" className="empty-row">該当するデータはありません。</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {section === 'workflowInboxSection' && (
          <WorkflowInbox
            active={section === 'workflowInboxSection'}
            csrfToken={csrfToken.current}
            request={apiRequest}
            setAuthenticated={setAuthenticated}
            setLoginError={setLoginError}
          />
        )}

        {section === 'userManagementSection' && isAdmin && (
          <UserManagement
            active={section === 'userManagementSection'}
            csrfToken={csrfToken.current}
            request={apiRequest}
            setAuthenticated={setAuthenticated}
            setLoginError={setLoginError}
          />
        )}

        {section === 'passwordChangeSection' && (
          <PasswordChange />
        )}
      </main>
    </div>
  );
}

function RegistrationForm({ registerForm, handleRegister, registrationRows, setRegistrationRows, allocateTrialNumber, managerChoices, editingRecordId, registering, cancelRegister, registerMessage, onChange }) {
  const availableManagers = managerChoices || [];
  const isEditing = editingRecordId !== null;
  const [allocatingRowIds, setAllocatingRowIds] = useState([]);

  function updateRow(index, name, value) {
    setRegistrationRows((rows) => rows.map((row, rowIndex) => (
      rowIndex === index ? { ...row, [name]: value } : row
    )));
  }

  function addRow() {
    const sharedValues = registrationRows[0] || emptyRegistrationValues();
    setRegistrationRows((rows) => [
      ...rows,
      {
        ...sharedValues,
        rowId: ++registrationRowSequence,
        trialNo: '',
        productNo: '',
        resultFile: null,
      },
    ]);
    onChange();
  }

  async function allocateNumber(rowId) {
    setAllocatingRowIds((current) => [...current, rowId]);
    try {
      await allocateTrialNumber(rowId);
    } finally {
      setAllocatingRowIds((current) => current.filter((id) => id !== rowId));
    }
  }

  return (
    <form id={isEditing ? 'record-edit-form' : undefined} ref={registerForm} className="form-panel" onSubmit={handleRegister} onChange={onChange}>
      <fieldset className="record-form-fields" disabled={registering}>
        {!isEditing && <p className="field-help">追加した行には、1件目の案件名・登録日・担当者が引き継がれます。</p>}
        {registrationRows.map((values, index) => {
          const rowId = values.rowId ?? index;
          const managerOptions = values.manager && !availableManagers.includes(values.manager)
            ? [values.manager, ...availableManagers]
            : availableManagers;
          const fieldName = (name) => (index === 0 ? name : `${name}-${index}`);
          return (
            <section className="registration-entry" key={values.rowId ?? index} aria-label={!isEditing ? `記録 ${index + 1}` : undefined}>
              {!isEditing && (
                <header className="registration-entry-heading">
                  <h3>記録 {index + 1}</h3>
                  {registrationRows.length > 1 && (
                    <button type="button" className="secondary-button" onClick={() => {
                      setRegistrationRows((rows) => rows.filter((_, rowIndex) => rowIndex !== index));
                      onChange();
                    }}>
                      この行を削除
                    </button>
                  )}
                </header>
              )}
              <div className="form-grid">
                <div className="field record-field-trial-no">
                  <span>試験番号<span className="required-badge">必須</span></span>
                  <div className="trial-number-controls">
                    <input
                      name={fieldName('trialNo')}
                      type="text"
                      maxLength="20"
                      placeholder="例: 26110001"
                      aria-label={`記録 ${index + 1} の試験番号`}
                      value={values.trialNo}
                      onChange={(event) => updateRow(index, 'trialNo', event.target.value)}
                      required
                    />
                    {!isEditing && (
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={registering || allocatingRowIds.includes(rowId)}
                        onClick={() => allocateNumber(rowId)}
                      >{allocatingRowIds.includes(rowId) ? '採番中...' : '採番'}</button>
                    )}
                  </div>
                </div>
                <label className="field record-field-project-name"><span>案件名</span><input name={fieldName('projectName')} type="text" maxLength="30" placeholder="例: JR東海N700S CI" value={values.projectName} onChange={(event) => updateRow(index, 'projectName', event.target.value)} /></label>
                <label className="field record-field-product-no"><span>製番</span><input name={fieldName('productNo')} type="text" maxLength="30" placeholder="例: 12345678 DG 0001" value={values.productNo} onChange={(event) => updateRow(index, 'productNo', event.target.value)} /></label>
                <label className="field record-field-registration-date"><span>登録日</span><input name={fieldName('registrationDate')} type="text" maxLength="8" value={values.registrationDate} onChange={(event) => updateRow(index, 'registrationDate', event.target.value)} placeholder="yyyymmdd" required /></label>
                <label className="field record-field-manager">
                  <span>担当者<span className="required-badge">必須</span></span>
                  <select name={fieldName('manager')} value={values.manager} onChange={(event) => updateRow(index, 'manager', event.target.value)} required disabled={managerChoices === null}>
                    <option value="" disabled>{managerChoices === null ? '読み込み中...' : managerOptions.length ? '担当者を選択' : '候補がありません'}</option>
                    {managerOptions.map((manager) => <option key={manager} value={manager}>{manager}</option>)}
                  </select>
                  {managerChoices?.length === 0 && <small className="field-help">equipment-config.json の managerChoices に担当者名を設定してください。</small>}
                </label>
                {!isEditing && (
                  <div className="field record-field-result-file result-file-picker">
                    <span>試験結果（CSV）</span>
                    <label className="secondary-button file-picker-control">
                      <span>ファイルを選択</span>
                      <input
                        type="file"
                        accept=".csv,text/csv"
                        disabled={registering}
                        onChange={(event) => updateRow(index, 'resultFile', event.currentTarget.files?.[0] || null)}
                      />
                    </label>
                    {values.resultFile
                      ? <small className="selected-file-name">{values.resultFile.name}</small>
                      : <small className="field-help">自動試験システムの試験結果CSVをインポートしてください。</small>}
                  </div>
                )}
              </div>
            </section>
          );
        })}
        {!isEditing && (
          <div className="button-row">
            <button type="button" className="secondary-button" onClick={addRow}>記録を追加</button>
            <button type="submit" className="primary-button" disabled={registering}>{registering ? '処理中...' : `${registrationRows.length}件を登録`}</button>
            <button type="button" className="secondary-button" onClick={cancelRegister}>キャンセル</button>
          </div>
        )}
      </fieldset>
      {editingRecordId === null && registerMessage.text && <Message type={registerMessage.type}>{registerMessage.text}</Message>}
    </form>
  );
}

function RecordDetails({ record, onClose, recordDirty, registering, registrationForm, equipment, instrumentChoices, managerChoices, workflowUsers, softwareSections, setEquipment, jumpers, setJumpers, appearance, setAppearance, insertionKeys, setInsertionKeys, manualTests, setManualTests, manualConditions, setManualConditions, onDirty, cancelRegister, registerMessage, pendingFiles, existingFiles, onFilesChanged, onPowerBoardReportChanged, csrfToken, setAuthenticated, setLoginError }) {
  const [activeTab, setActiveTab] = useState(() => (
    existingFiles.some((file) => /\.csv$/i.test(file.fileName)) ? 2 : 0
  ));
  const [commonPanelWidth, setCommonPanelWidth] = useState(240);
  const [fileActionPending, setFileActionPending] = useState(false);
  const [fileActionMessage, setFileActionMessage] = useState({ text: '', type: '' });
  const [reportActionPending, setReportActionPending] = useState(false);
  const [reportActionMessage, setReportActionMessage] = useState({ text: '', type: '' });
  const dividerDrag = useRef(null);
  const detailTabs = [
    '試験情報',
    '受入検査',
    '試験結果',
    '出荷検査',
    '回覧',
  ];

  function getMaxCommonPanelWidth(divider) {
    const contentWidth = divider.parentElement.getBoundingClientRect().width;
    const reservedWidth = MIN_WORKSPACE_WIDTH + DETAIL_RESIZER_WIDTH + DETAIL_COLUMN_GAP * 2;
    return Math.max(MIN_COMMON_PANEL_WIDTH, Math.min(MAX_COMMON_PANEL_WIDTH, contentWidth - reservedWidth));
  }

  function startDividerDrag(event) {
    event.preventDefault();
    dividerDrag.current = { pointerX: event.clientX, panelWidth: commonPanelWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveDivider(event) {
    if (!dividerDrag.current) return;
    const drag = dividerDrag.current;
    const maxWidth = getMaxCommonPanelWidth(event.currentTarget);
    setCommonPanelWidth(Math.min(
      maxWidth,
      Math.max(MIN_COMMON_PANEL_WIDTH, drag.panelWidth + event.clientX - drag.pointerX),
    ));
  }

  function stopDividerDrag(event) {
    dividerDrag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function resizeDividerWithKeyboard(event) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const maxWidth = getMaxCommonPanelWidth(event.currentTarget);
    const nextWidth = event.key === 'Home' ? MIN_COMMON_PANEL_WIDTH
      : event.key === 'End' ? maxWidth
        : commonPanelWidth + (event.key === 'ArrowRight' ? 16 : -16);
    setCommonPanelWidth(Math.min(maxWidth, Math.max(MIN_COMMON_PANEL_WIDTH, nextWidth)));
  }

  async function uploadTrialResults(event) {
    const input = event.currentTarget;
    const file = input.files[0];
    input.value = '';
    if (!file) return;

    const formData = new FormData();
    formData.append('resultFile', file);
    setFileActionPending(true);
    setFileActionMessage({ text: '試験結果CSVを保存中...', type: '' });
    try {
      const result = await apiRequest(`/api/records/${record.id}/files`, csrfToken, {
        method: 'POST',
        body: formData,
      });
      onFilesChanged(record.id, result.files);
      setFileActionMessage({ text: '試験結果CSVを保存しました。', type: 'success' });
    } catch (error) {
      setFileActionMessage({ text: error.message, type: 'error' });
      if (error.status === 401) {
        setAuthenticated(false);
        setLoginError(error.message);
      }
    } finally {
      setFileActionPending(false);
    }
  }

  async function deleteTrialResults(file) {
    if (!window.confirm(`試験結果ファイル「${file.fileName}」を削除しますか？`)) return;
    setFileActionPending(true);
    setFileActionMessage({ text: '試験結果CSVを削除中...', type: '' });
    try {
      const result = await apiRequest(
        `/api/records/${record.id}/files/${file.id}`,
        csrfToken,
        { method: 'DELETE' },
      );
      onFilesChanged(record.id, result.files);
      setFileActionMessage({ text: '試験結果CSVを削除しました。', type: 'success' });
    } catch (error) {
      setFileActionMessage({ text: error.message, type: 'error' });
      if (error.status === 401) {
        setAuthenticated(false);
        setLoginError(error.message);
      }
    } finally {
      setFileActionPending(false);
    }
  }

  async function uploadPowerBoardReport(event) {
    const input = event.currentTarget;
    const file = input.files[0];
    input.value = '';
    if (!file) return;

    const formData = new FormData();
    formData.append('reportFile', file);
    setReportActionPending(true);
    setReportActionMessage({ text: '電源基板試験成績票を保存中...', type: '' });
    try {
      const result = await apiRequest(`/api/records/${record.id}/power-board-report`, csrfToken, {
        method: 'POST',
        body: formData,
      });
      onPowerBoardReportChanged(record.id, result.report);
      setReportActionMessage({ text: '電源基板試験成績票を保存しました。', type: 'success' });
    } catch (error) {
      setReportActionMessage({ text: error.message, type: 'error' });
      if (error.status === 401) {
        setAuthenticated(false);
        setLoginError(error.message);
      }
    } finally {
      setReportActionPending(false);
    }
  }

  async function deletePowerBoardReport() {
    if (!window.confirm('電源基板試験成績票を削除しますか？')) return;
    setReportActionPending(true);
    setReportActionMessage({ text: '電源基板試験成績票を削除中...', type: '' });
    try {
      const result = await apiRequest(
        `/api/records/${record.id}/power-board-report`,
        csrfToken,
        { method: 'DELETE' },
      );
      onPowerBoardReportChanged(record.id, result.report);
      setReportActionMessage({ text: '電源基板試験成績票を削除しました。', type: 'success' });
    } catch (error) {
      setReportActionMessage({ text: error.message, type: 'error' });
      if (error.status === 401) {
        setAuthenticated(false);
        setLoginError(error.message);
      }
    } finally {
      setReportActionPending(false);
    }
  }

  function closeDetails() {
    if (registering || fileActionPending || reportActionPending) return;
    onClose();
  }

  useEffect(() => {
    document.title = `${record.trialNo} - 記録の詳細`;
  }, [record.trialNo]);

  useEffect(() => {
    const handleBeforeUnload = (event) => {
      if (!recordDirty && !registering && !fileActionPending && !reportActionPending) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [recordDirty, registering, fileActionPending, reportActionPending]);

  return (
    <section
      className="record-detail-content"
      aria-label="記録の詳細"
      style={{ '--detail-common-width': `${commonPanelWidth}px` }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          closeDetails();
        }
      }}
    >
      <div className="record-detail-common">
        {registrationForm}
        <div className="button-row">
          {recordDirty && <span className="status-text warning">未保存</span>}
          <button type="submit" form="record-edit-form" className="primary-button" disabled={registering || fileActionPending || reportActionPending || !equipment || !jumpers || !appearance || !insertionKeys || !manualTests || !manualConditions}>
            {registering ? '保存中...' : '保存'}
          </button>
          <button type="button" className="secondary-button" disabled={registering || fileActionPending || reportActionPending} onClick={cancelRegister}>キャンセル</button>
        </div>
        {registerMessage.text && <Message type={registerMessage.type}>{registerMessage.text}</Message>}
      </div>
      <div
        className="record-detail-resizer"
        role="separator"
        aria-label="共通情報の幅を調整"
        aria-orientation="vertical"
        aria-valuemin={MIN_COMMON_PANEL_WIDTH}
        aria-valuemax={MAX_COMMON_PANEL_WIDTH}
        aria-valuenow={commonPanelWidth}
        aria-valuetext={`共通情報 ${commonPanelWidth} ピクセル`}
        tabIndex={0}
        onPointerDown={startDividerDrag}
        onPointerMove={moveDivider}
        onPointerUp={stopDividerDrag}
        onPointerCancel={stopDividerDrag}
        onKeyDown={resizeDividerWithKeyboard}
      />
      <div className="record-detail-workspace">
      <div className="record-detail-tabs" role="tablist" aria-label="記録詳細">
        {detailTabs.map((title, index) => (
          <button
            key={title}
            type="button"
            role="tab"
            id={`record-detail-tab-${index}`}
            aria-controls={`record-detail-panel-${index}`}
            aria-selected={activeTab === index}
            tabIndex={activeTab === index ? 0 : -1}
            onClick={() => setActiveTab(index)}
            onKeyDown={(event) => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? detailTabs.length - 1
                : (index + (event.key === 'ArrowRight' ? 1 : -1) + detailTabs.length) % detailTabs.length;
              setActiveTab(next);
              event.currentTarget.parentElement.children[next].focus();
            }}
          >{title}</button>
        ))}
      </div>
      {detailTabs.map((_, index) => (
        <div
          key={index}
          role="tabpanel"
          id={`record-detail-panel-${index}`}
          aria-labelledby={`record-detail-tab-${index}`}
          hidden={activeTab !== index}
        >
          {index === 0 && <EquipmentForm equipment={equipment} instrumentChoices={instrumentChoices} setEquipment={setEquipment} disabled={registering} onDirty={onDirty} groupKeys={['boards', 'instruments']} />}
          {index === 1 && (
            <>
              <AppearanceInspection appearance={appearance} setAppearance={setAppearance} disabled={registering} onDirty={onDirty} />
              <InsertionKeyInspection connectors={insertionKeys} setConnectors={setInsertionKeys} disabled={registering} onDirty={onDirty} />
              <h3 className="jumper-heading">ジャンパ設定</h3>
              {jumpers ? (
                <div className="equipment-table-wrap jumper-table-wrap">
                  <table className="jumper-table equipment-table" aria-label="ジャンパ設定の確認" aria-busy={registering}>
                    <thead><tr><th scope="col">ジャンパ名</th><th scope="col">設定</th><th scope="col">確認結果</th></tr></thead>
                    <tbody>
                      {jumpers.length === 0 ? (
                        <tr><td colSpan="3">ジャンパ設定はありません。</td></tr>
                      ) : jumpers.map((jumper) => (
                        <tr key={jumper.name}>
                          <td>{jumper.name}</td>
                          <td>{jumper.setting}</td>
                          <td>
                            <ConfirmationCheckbox
                              label={`${jumper.name}の設定を確認`}
                              checked={jumper.confirmed}
                              disabled={registering}
                              onChange={() => {
                                setJumpers((current) => current.map((item) => item.name === jumper.name ? { ...item, confirmed: !item.confirmed } : item));
                                onDirty();
                              }}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <Message>読み込み中...</Message>}
              <EquipmentForm equipment={equipment} softwareSections={softwareSections} setEquipment={setEquipment} disabled={registering} onDirty={onDirty} groupKeys={['software']} />
              <section className="power-board-report-section" aria-labelledby="power-board-report-title">
                <h3 id="power-board-report-title">電源基板試験成績票</h3>
                {record.powerBoardReport ? (
                  <>
                    <div className="power-board-report-controls">
                      <span>{record.powerBoardReport.fileName}</span>
                      <div className="button-row">
                        <a
                          className="secondary-button"
                          href={`/api/records/${record.id}/power-board-report`}
                          target="_blank"
                          rel="noopener noreferrer"
                        >PDFを別タブで開く</a>
                        <button
                          type="button"
                          className="delete-button"
                          disabled={registering || fileActionPending || reportActionPending}
                          onClick={deletePowerBoardReport}
                        >{reportActionPending ? '削除中...' : '削除する'}</button>
                      </div>
                    </div>
                    <iframe
                      className="power-board-report-preview"
                      title="電源基板試験成績票"
                      src={`/api/records/${record.id}/power-board-report`}
                    />
                  </>
                ) : (
                  <div className="field file-field result-file-picker">
                    <span>試験成績票PDFファイル</span>
                    <label className={`secondary-button file-picker-control${reportActionPending ? ' is-disabled' : ''}`}>
                      <span>{reportActionPending ? '登録中...' : 'ファイルを選択'}</span>
                      <input
                        type="file"
                        accept=".pdf,application/pdf"
                        disabled={registering || fileActionPending || reportActionPending}
                        onChange={uploadPowerBoardReport}
                      />
                    </label>
                    <small className="field-help">電源基板の試験成績票PDFを登録してください。</small>
                  </div>
                )}
                {reportActionMessage.text && <Message type={reportActionMessage.type}>{reportActionMessage.text}</Message>}
              </section>
            </>
          )}
          {index === 2 && (
            <>
              <ManualTrialResults
                tests={manualTests}
                setTests={setManualTests}
                conditions={manualConditions}
                setConditions={setManualConditions}
                disabled={registering}
                onDirty={onDirty}
              />
              {existingFiles.length === 0 && (
                <div className="result-file-registration">
                  <h2>試験結果CSVを登録</h2>
                  <div className="field file-field result-file-picker">
                    <span>試験結果ファイル</span>
                    <label className={`secondary-button file-picker-control${fileActionPending ? ' is-disabled' : ''}`}>
                      <span>ファイルを選択</span>
                      <input
                        type="file"
                        accept=".csv,text/csv"
                        disabled={registering || fileActionPending || reportActionPending}
                        onChange={uploadTrialResults}
                      />
                    </label>
                    <small className="field-help">自動試験システムの試験結果CSVをインポートしてください。</small>
                  </div>
                </div>
              )}
              <TrialResults
                recordId={record.id}
                files={existingFiles}
                pendingFiles={pendingFiles}
                csrfToken={csrfToken}
                request={apiRequest}
                setAuthenticated={setAuthenticated}
                setLoginError={setLoginError}
                fileActionPending={fileActionPending || reportActionPending}
                onDeleteFile={() => deleteTrialResults(existingFiles[0])}
              />
              {fileActionMessage.text && <Message type={fileActionMessage.type}>{fileActionMessage.text}</Message>}
            </>
          )}
          {index === 3 && (
            <EquipmentForm equipment={equipment} setEquipment={setEquipment} disabled={registering} onDirty={onDirty} groupKeys={['shippingSoftware']} />
          )}
          {index === 4 && (
            <Workflow
              record={record}
              workflowUsers={workflowUsers}
              active={activeTab === 4}
              csrfToken={csrfToken}
              request={apiRequest}
              setAuthenticated={setAuthenticated}
              setLoginError={setLoginError}
            />
          )}
        </div>
      ))}
      </div>
    </section>
  );
}

function manualJudgement(value, lowerLimit, upperLimit) {
  if (!value.trim()) return '';
  const number = Number(value);
  if (!Number.isFinite(number)) return 'NG';
  return number >= Number(lowerLimit) && number <= Number(upperLimit) ? 'PASS' : 'NG';
}

function formatManualLimit(value) {
  if (typeof value === 'string') return value;
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function ManualTrialResults({ tests, setTests, conditions, setConditions, disabled, onDirty }) {
  if (!tests || !conditions) return <Message>手動試験を読み込み中...</Message>;

  function updateItem(itemKey, values) {
    setTests((current) => current.map((test) => ({
      ...test,
      items: test.items.map((item) => item.key === itemKey ? { ...item, ...values } : item),
    })));
    onDirty();
  }

  function updateCondition(name, value) {
    setConditions((current) => ({ ...current, [name]: value }));
    onDirty();
  }

  return (
    <section className="manual-results-section" aria-labelledby="manual-results-title">
      <h2 id="manual-results-title">手動試験</h2>
      <div className="manual-test-conditions" aria-label="試験環境">
        <label>
          <span>温度</span>
          <input
            type="text"
            inputMode="decimal"
            value={conditions.temperature}
            maxLength={100}
            disabled={disabled}
            aria-label="温度"
            onChange={(event) => updateCondition('temperature', event.target.value)}
          />
          <span>℃</span>
        </label>
        <label>
          <span>湿度</span>
          <input
            type="text"
            inputMode="decimal"
            value={conditions.humidity}
            maxLength={100}
            disabled={disabled}
            aria-label="湿度"
            onChange={(event) => updateCondition('humidity', event.target.value)}
          />
          <span>%RH</span>
        </label>
      </div>
      {tests.length === 0 && <p>手動試験項目はありません。</p>}
      <div className="manual-results-table-wrap">
        <table className="manual-results-table" aria-label="手動試験結果">
          <thead>
            <tr>
              <th scope="col">No.</th>
              <th scope="col">試験項目</th>
              <th scope="col">区分</th>
              <th scope="col">規定値</th>
              <th scope="col">測定値</th>
              <th scope="col">判定</th>
              <th scope="col">ペンキロック</th>
            </tr>
          </thead>
          {tests.map((test) => (
            <tbody key={test.key}>
              {test.items.map((item, index) => {
                const judgement = manualJudgement(
                  item.measuredValue,
                  item.lowerLimit,
                  item.upperLimit,
                );
                return (
                  <tr key={item.key} className={judgement === 'NG' ? 'manual-failed-row' : ''}>
                    {index === 0 && (
                      <>
                        <th scope="rowgroup" rowSpan={test.items.length}>{test.number}</th>
                        <th scope="rowgroup" rowSpan={test.items.length}>{test.name}</th>
                        <th scope="rowgroup" rowSpan={test.items.length}>{test.area}</th>
                      </>
                    )}
                    <td className="manual-section-value">
                      {item.name && <span className="manual-item-name">{item.name}</span>}
                      <span>{formatManualLimit(item.lowerLimit)} ～ {formatManualLimit(item.upperLimit)} {item.unit}</span>
                    </td>
                    <td>
                      <input
                        type="text"
                        inputMode="decimal"
                        aria-label={`${test.name} ${item.name}の測定値`}
                        value={item.measuredValue}
                        maxLength={100}
                        disabled={disabled}
                        onChange={(event) => updateItem(item.key, { measuredValue: event.target.value })}
                      />
                    </td>
                    <td>
                      <span className={`manual-judgement ${judgement === 'PASS' ? 'pass' : judgement === 'NG' ? 'fail' : 'unjudged'}`}>
                        {judgement || '－'}
                      </span>
                    </td>
                    <td>
                      {item.benchLock ? (
                        <input
                          type="checkbox"
                          aria-label={`${test.name} ${item.name}のペンキロックを確認`}
                          checked={item.benchLockChecked}
                          disabled={disabled}
                          onChange={(event) => updateItem(item.key, {
                            benchLockChecked: event.target.checked,
                          })}
                        />
                      ) : '－'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          ))}
        </table>
      </div>
    </section>
  );
}

function ConfirmationCheckbox({ label, checked, disabled, onChange }) {
  return (
    <label className="jumper-check" title={`${label}：${checked ? '確認済み' : '未確認'}`}>
      <input type="checkbox" aria-label={label} checked={checked} disabled={disabled} onChange={onChange} />
      <span aria-hidden="true">{checked ? '\u2705' : '\u25a1'}</span>
    </label>
  );
}

const INSERTION_KEY_POSITIONS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'K', 'L', 'M'];

function InsertionKeyInspection({ connectors, setConnectors, disabled, onDirty }) {
  if (!connectors) return <Message>誤挿入キー確認を読み込み中...</Message>;
  return (
    <section className="insertion-key-inspection" aria-labelledby="insertion-key-title">
      <h3 id="insertion-key-title" className="jumper-heading">誤挿入キー確認</h3>
      <div className="insertion-key-layout">
        <div className="insertion-key-sides">
          <InsertionKeyTable
            title="バックボード側"
            positions={INSERTION_KEY_POSITIONS}
            connectors={connectors.filter((connector) => connector.side !== 'board')}
            setConnectors={setConnectors}
            disabled={disabled}
            onDirty={onDirty}
          />
          <InsertionKeyTable
            title="基板側"
            positions={INSERTION_KEY_POSITIONS}
            connectors={connectors.filter((connector) => connector.side === 'board')}
            setConnectors={setConnectors}
            disabled={disabled}
            onDirty={onDirty}
          />
        </div>
      </div>
    </section>
  );
}

function InsertionKeyTable({ title, positions, connectors, setConnectors, disabled, onDirty }) {
  const confirmed = connectors.length > 0 && connectors.every((connector) => connector.confirmed);
  return (
    <div className="insertion-key-side">
      <p className="insertion-key-instruction">{title}</p>
      <div className="insertion-key-scroll">
        <table className="insertion-key-table" aria-label={`${title}の誤挿入キー確認`}>
          <colgroup>
            <col className="insertion-key-position-column" />
            <col span="4" className="insertion-key-connector-column" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">位置</th>
              {connectors.map((connector) => (
                <th scope="col" key={connector.name}>{connector.displayName}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {positions.map((position) => (
              <tr key={position}>
                <th scope="row">{position}</th>
                {connectors.map((connector) => {
                  const filled = connector.positions.includes(position);
                  return (
                    <td key={connector.name}><span className={`insertion-key-slot${filled ? ' insertion-key-slot--filled' : ''}`} role="img" aria-label={filled ? 'キーあり' : 'キーなし'} /></td>
                  );
                })}
              </tr>
            ))}
            <tr>
              <th scope="row">確認</th>
              <td colSpan={4}>
                <ConfirmationCheckbox
                  label={`${title}の誤挿入キーを確認`}
                  checked={confirmed}
                  disabled={disabled}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    const names = new Set(connectors.map((connector) => connector.name));
                    setConnectors((current) => current.map((item) => names.has(item.name)
                      ? { ...item, confirmed: checked } : item));
                    onDirty();
                  }}
                />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AppearanceInspection({ appearance, setAppearance, disabled, onDirty }) {
  if (!appearance) return <Message>外観確認を読み込み中...</Message>;
  const { boardGroups, items, checks } = appearance;
  const boards = boardGroups.flatMap((group) => group.boards);
  const headerRows = boardGroups.some((group) => group.boards.length > 1) ? 2 : 1;

  function renderCheck(item, board) {
    const key = `${item.key}:${board}`;
    return (
      <ConfirmationCheckbox
        label={`${board} ${item.name}を確認`}
        checked={checks[key]}
        disabled={disabled}
        onChange={() => {
          setAppearance((current) => ({
            ...current,
            checks: { ...current.checks, [key]: !current.checks[key] },
          }));
          onDirty();
        }}
      />
    );
  }

  return (
    <section className="appearance-inspection" aria-labelledby="appearance-inspection-title">
      <h3 id="appearance-inspection-title" className="jumper-heading">外観確認</h3>
      <div className="equipment-table-wrap appearance-table-wrap">
        <table
          className="equipment-table appearance-table"
          aria-label="外観確認"
          aria-busy={disabled}
          style={{ '--appearance-table-width': `${280 + boards.length * 60}px` }}
        >
          <colgroup>
            <col className="appearance-number-column" />
            <col className="appearance-item-column" />
            {boards.map((board) => <col key={board} />)}
          </colgroup>
          <thead>
            <tr>
              <th scope="col" rowSpan={headerRows}>NO</th>
              <th scope="col" rowSpan={headerRows}>項目</th>
              {boardGroups.map((group) => (
                <th
                  key={group.name}
                  scope={group.boards.length > 1 ? 'colgroup' : 'col'}
                  colSpan={group.boards.length}
                  rowSpan={group.boards.length === 1 ? headerRows : 1}
                >{group.name}</th>
              ))}
            </tr>
            {headerRows === 2 && (
              <tr>
                {boardGroups.filter((group) => group.boards.length > 1).flatMap((group) => (
                  group.boards.map((board) => <th key={board} scope="col">{board}</th>)
                ))}
              </tr>
            )}
          </thead>
          {items.length === 0 ? (
            <tbody><tr><td colSpan={boards.length + 2}>外観確認項目はありません。</td></tr></tbody>
          ) : items.map((item, index) => (
            <tbody key={item.key}>
              {Array.from({ length: item.rows }, (_, lineIndex) => (
                <tr key={lineIndex}>
                  {lineIndex === 0 && (
                    <>
                      <td rowSpan={item.rows}>{index + 1}</td>
                      <th scope={item.rows === 2 ? 'rowgroup' : 'row'} rowSpan={item.rows}>{item.name}</th>
                    </>
                  )}
                  {boards.map((board) => {
                    const expected = item.values[board];
                    if (expected === undefined) {
                      return lineIndex === 0 ? <td key={board} rowSpan={item.rows}>-</td> : null;
                    }
                    return (
                      <td key={board} className={item.rows === 2 && lineIndex === 0 ? 'appearance-expected' : undefined}>
                        {item.rows === 2 && lineIndex === 0 ? expected : (
                          <>
                            {item.rows === 1 && expected && <span className="appearance-inline-value">{expected}</span>}
                            {renderCheck(item, board)}
                          </>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
    </section>
  );
}

const EQUIPMENT_SECTIONS = [
  {
    key: 'boards', title: '基板情報',
    columns: [
      { key: 'name', label: '基板名', fixed: true },
      { key: 'serialNumber', label: 'シリアル No.' },
    ],
  },
  {
    key: 'instruments', title: '使用計測器',
    columns: [
      { key: 'name', label: '計測器' },
      { key: 'managementNo', label: '管理番号' },
      { key: 'testItems', label: '試験項目' },
    ],
  },
  {
    key: 'shippingSoftware', title: '出荷用ソフトインストール',
    columns: [
      { key: 'name', label: 'ソフト' },
      { key: 'sdFormat', label: 'SD 形式' },
      { key: 'version', label: 'バージョン' },
      { key: 'checksum', label: 'チェックサム' },
    ],
  },
];

function EquipmentForm({ equipment, instrumentChoices = [], softwareSections = [], setEquipment, disabled, onDirty, groupKeys }) {
  function changeField(group, rowIndex, field, value) {
    setEquipment((current) => ({
      ...current,
      [group]: current[group].map((row, index) => index === rowIndex ? { ...row, [field]: value } : row),
    }));
    onDirty();
  }

  function changeInstrument(rowIndex, name) {
    const choice = instrumentChoices.find((item) => item.name === name);
    setEquipment((current) => ({
      ...current,
      instruments: current.instruments.map((row, index) => index === rowIndex
        ? { ...row, name, managementNo: choice?.managementNo || '' }
        : row),
    }));
    onDirty();
  }

  if (!equipment) {
    return <Message>機器情報を読み込み中...</Message>;
  }
  const softwareGroups = groupKeys.includes('software')
    ? softwareSections.map((section, sectionIndex) => {
      const rowOffset = softwareSections
        .slice(0, sectionIndex)
        .reduce((total, current) => total + current.rows.length, 0);
      return {
        key: 'software',
        sectionId: section.key,
        title: section.title,
        rowIndexes: section.rows.map((_, index) => rowOffset + index),
        columns: [
          { key: 'name', label: 'ソフト', fixed: true },
          { key: 'sdFormat', label: 'SD 形式', fixed: true },
          { key: 'version', label: 'バージョン' },
          { key: 'checksum', label: 'チェックサム' },
        ],
      };
    })
    : [];

  return (
    <div className="equipment-form" aria-busy={disabled}>
      <fieldset disabled={disabled}>
        {groupKeys.includes('instruments') && (
          <datalist id="instrument-name-options">
            {instrumentChoices.map((choice) => <option key={choice.name} value={choice.name} />)}
          </datalist>
        )}
        {[...EQUIPMENT_SECTIONS.filter((group) => groupKeys.includes(group.key)), ...softwareGroups].map((group) => (
          <section key={group.sectionId || group.key} aria-labelledby={`equipment-${group.sectionId || group.key}-heading`}>
            <h3 id={`equipment-${group.sectionId || group.key}-heading`} className="jumper-heading">{group.title}</h3>
            {group.key === 'shippingSoftware' && (
              <>
                <label className="shipping-software-lock">
                  <input
                    type="checkbox"
                    checked={equipment.shippingSoftwareSameAsTrial}
                    onChange={(event) => {
                      const checked = event.target.checked;
                      setEquipment((current) => ({ ...current, shippingSoftwareSameAsTrial: checked }));
                      onDirty();
                    }}
                  />
                  試験時と同じソフト
                </label>
                {equipment.shippingSoftwareSameAsTrial && (
                  <p className="field-help" role="status">入力欄は編集できません。チェックを外すと編集できます。</p>
                )}
              </>
            )}
            <div className="equipment-table-wrap">
              <table className={`equipment-table equipment-table--${group.key} equipment-table--${group.sectionId || group.key}`} aria-label={group.title}>
                <thead><tr>{group.columns.map((column) => <th key={column.key} scope="col">{column.label}</th>)}</tr></thead>
                <tbody>
                  {(group.rowIndexes || equipment[group.key].map((_, index) => index)).map((rowIndex) => {
                    const row = equipment[group.key][rowIndex];
                    return (
                      <tr key={rowIndex}>
                        {group.columns.map((column) => (
                          <td key={column.key}>
                            {column.fixed ? row[column.key] : group.key === 'instruments' && column.key === 'name' ? (
                              <input
                                type="text"
                                list="instrument-name-options"
                                aria-label={`使用計測器 ${rowIndex + 1}行目 計測器`}
                                value={row.name}
                                maxLength={100}
                                onChange={(event) => changeInstrument(rowIndex, event.target.value)}
                              />
                            ) : (
                              <input
                                type="text"
                                aria-label={`${group.key === 'instruments' ? `使用計測器 ${rowIndex + 1}行目` : group.key === 'shippingSoftware' ? group.title : row.name} ${column.label}`}
                                value={row[column.key]}
                                maxLength={100}
                                disabled={group.key === 'shippingSoftware' && equipment.shippingSoftwareSameAsTrial}
                                onChange={(event) => changeField(group.key, rowIndex, column.key, event.target.value)}
                              />
                            )}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        ))}
      </fieldset>
    </div>
  );
}

// サイドメニューのリンクを共通化した小さなコンポーネント。
function NavLink({ target, section, onNavigate, icon, children }) {
  const active = target === section;
  return (
    <a
      className={`nav-link${active ? ' active' : ''}`}
      href="#"
      aria-current={active ? 'page' : 'false'}
      onClick={(event) => { event.preventDefault(); onNavigate(target); }}
    >
      <span aria-hidden="true">{icon}</span> {children}
    </a>
  );
}

// 検索フォームの各入力欄を共通化したコンポーネント。
function SearchField({ label, name, fieldClassName, value, onChange, placeholder, maxLength }) {
  return (
    <label className={`field${fieldClassName ? ` ${fieldClassName}` : ''}`}>
      <span>{label}</span>
      <input
        type="text"
        maxLength={maxLength}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange((filters) => ({ ...filters, [name]: event.target.value }))}
      />
    </label>
  );
}

export default App;
