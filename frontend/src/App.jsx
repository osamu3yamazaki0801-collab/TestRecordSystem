import { useEffect, useRef, useState } from 'react';

// 添付ファイルの最大サイズは 100MB。
// 画面遷移ごとの見出し文言と検索条件の初期値をまとめて管理する。
const MAX_FILE_SIZE = 100 * 1024 * 1024;
const MAX_TOTAL_FILE_SIZE = 100 * 1024 * 1024;
const SECTION_DETAILS = {
  dashboardSection: {
    title: '試験記録の管理',
    description: '制御ユニットのルーチン試験結果を登録・参照します。',
  },
  searchSection: {
    title: '記録の登録・検索',
    description: '試験記録を登録し、条件で検索します。',
  },
};
const EMPTY_FILTERS = {
  trialNo: '',
  productNo: '',
  date: '',
  manager: '',
};

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
    trialNo: '',
    projectName: '',
    productNo: '',
    registrationDate: todayDateString(),
    manager: '',
  };
}

function formatRegistrationDate(value) {
  if (value.length !== 8) {
    return value;
  }
  return `${value.slice(0, 4)}/${value.slice(4, 6)}/${value.slice(6, 8)}`;
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
  const [section, setSection] = useState('dashboardSection');
  const [loginError, setLoginError] = useState('');
  const [sessionMessage, setSessionMessage] = useState('');
  const [dashboard, setDashboard] = useState(null);
  const [dashboardMessage, setDashboardMessage] = useState({ text: '', type: '' });
  const [registerMessage, setRegisterMessage] = useState({ text: '', type: '' });
  const [searchMessage, setSearchMessage] = useState({ text: '', type: '' });
  const [searchFilters, setSearchFilters] = useState(EMPTY_FILTERS);
  const [records, setRecords] = useState([]);
  const [registrationValues, setRegistrationValues] = useState(emptyRegistrationValues);
  const [editingRecordId, setEditingRecordId] = useState(null);
  const [existingFiles, setExistingFiles] = useState([]);
  const [removedFileIds, setRemovedFileIds] = useState([]);
  const [registering, setRegistering] = useState(false);
  const [deletingRecordId, setDeletingRecordId] = useState(null);
  const [selectedRecordId, setSelectedRecordId] = useState(null);
  const [detailRecord, setDetailRecord] = useState(null);
  const [recordDirty, setRecordDirty] = useState(false);
  const [newRecordOpen, setNewRecordOpen] = useState(false);

  // 初期表示時にセッション状態を確認し、ログイン済みならそのままアプリ画面を表示する。
  useEffect(() => {
    let active = true;
    apiRequest('/api/session', '').then((session) => {
      if (!active) return;
      csrfToken.current = session.csrfToken;
      if (session.authenticated) {
        setUsername(session.username);
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
    if (!authenticated || section !== 'dashboardSection') return undefined;
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
              latestRecord: allRecords[0] || null,
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
  }, [authenticated, section]);

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

  function openNewRecord() {
    clearRegistrationDraft();
    setRegisterMessage({ text: '', type: '' });
    setSection('searchSection');
    setNewRecordOpen(true);
  }

  function closeNewRecord() {
    if (registering) return;
    if (recordDirty && !window.confirm('未保存の入力を破棄して閉じますか？')) return;
    setNewRecordOpen(false);
    clearRegistrationDraft();
    setRegisterMessage({ text: '', type: '' });
  }

  function clearRegistrationDraft() {
    registerForm.current?.reset();
    setRegistrationValues(emptyRegistrationValues());
    setEditingRecordId(null);
    setExistingFiles([]);
    setRemovedFileIds([]);
    setRecordDirty(false);
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
      setUsername(result.username);
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
      setDashboard(null);
      setLoginError('');
      setSessionMessage('');
      setRegisterMessage({ text: '', type: '' });
      setSearchMessage({ text: '', type: '' });
      setNewRecordOpen(false);
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

  // 試験記録の登録・変更処理。
  // 入力値の検証後、フォームの内容を multipart/form-data でサーバーへ送る。
  async function handleRegister(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const isEditing = editingRecordId !== null;
    if (!isEditing) {
      ['projectName', 'productNo', 'registrationDate'].forEach((name) => {
        formData.set(name, registrationValues[name]);
      });
    }
    const values = Object.fromEntries(
      ['trialNo', 'projectName', 'productNo', 'registrationDate', 'manager']
        .map((name) => [name, String(formData.get(name) || '').trim()]),
    );
    const validationError = validateRegistration(values);
    if (validationError) {
      setRegisterMessage({ text: validationError, type: 'error' });
      return;
    }
    const selectedFiles = formData.getAll('resultFiles')
      .filter((file) => file instanceof File && file.name);
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
      const result = await apiRequest(
        isEditing ? `/api/records/${encodeURIComponent(editingRecordId)}` : '/api/records',
        csrfToken.current,
        {
          method: isEditing ? 'PUT' : 'POST',
          body: formData,
        },
      );
      if (isEditing) {
        const updatedRecords = await apiRequest('/api/records', csrfToken.current);
        const updatedRecord = updatedRecords.find((record) => record.id === editingRecordId);
        if (updatedRecord) handleEditRecord(updatedRecord);
        setSearchFilters((filters) => ({ ...filters }));
      } else {
        setRecords((current) => [{ id: result.id, ...values, files: [] }, ...current]);
        setSelectedRecordId(result.id);
        setSearchFilters({ ...EMPTY_FILTERS });
        setSearchMessage({ text: '記録を登録しました。', type: 'success' });
        setNewRecordOpen(false);
        clearRegistrationDraft();
      }
      setRegisterMessage({
        text: isEditing ? '記録を変更しました。' : '登録が完了しました。',
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
    openNewRecord();
    setEditingRecordId(null);
    setExistingFiles([]);
    setRemovedFileIds([]);
    setRegistrationValues({
      trialNo: record.trialNo,
      projectName: record.projectName,
      productNo: record.productNo,
      registrationDate: record.registrationDate,
      manager: record.manager,
    });
    setRegisterMessage({
      text: '記録をコピーしました。試験結果ファイルは登録後に記録の詳細から追加できます。',
      type: 'success',
    });
  }

  function handleEditRecord(record) {
    registerForm.current?.reset();
    setDetailRecord(record);
    setRecordDirty(false);
    setEditingRecordId(record.id);
    setExistingFiles(record.files || []);
    setRemovedFileIds([]);
    setRegistrationValues({
      trialNo: record.trialNo,
      projectName: record.projectName,
      productNo: record.productNo,
      registrationDate: record.registrationDate,
      manager: record.manager,
    });
    setRegisterMessage({ text: '', type: '' });
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
      if (recordDirty && !window.confirm('未保存の記録の変更を破棄しますか？')) return;
      handleEditRecord(detailRecord);
    } else {
      closeNewRecord();
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
  const latestRecord = dashboard?.latestRecord;

  const registrationForm = (
    <RegistrationForm
      registerForm={registerForm}
      handleRegister={handleRegister}
      registrationValues={registrationValues}
      setRegistrationValues={setRegistrationValues}
      editingRecordId={editingRecordId}
      existingFiles={existingFiles}
      removedFileIds={removedFileIds}
      setRemovedFileIds={setRemovedFileIds}
      registering={registering}
      cancelRegister={cancelRegister}
      registerMessage={registerMessage}
      onChange={() => setRecordDirty(true)}
    />
  );

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
          <NavLink target="searchSection" section={section} onNavigate={navigateTo} icon="⌕">記録の登録・検索</NavLink>
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
            {section === 'searchSection' && (
              <button type="button" className="primary-button" onClick={openNewRecord}>新規登録</button>
            )}
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
                  <button type="button" className="outline-button" onClick={() => navigateTo('searchSection')}>記録の登録・検索</button>
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
              <article className="content-card">
                <div className="content-card-heading">
                  <div><p className="card-kicker">LATEST RECORD</p><h2>直近の記録</h2></div>
                  <span className="heading-icon" aria-hidden="true">↗</span>
                </div>
                <div className="latest-record">
                  {latestRecord ? (
                    <>
                      <div className="latest-topline">
                        <span className="latest-label">TEST NO.</span>
                        <span className="latest-chevron" aria-hidden="true">›</span>
                      </div>
                      <h3 className="latest-title">{latestRecord.trialNo}</h3>
                      <div className="latest-meta">
                        <div><span className="latest-meta-label">製番</span><span className="latest-meta-value">{latestRecord.productNo}</span></div>
                        <div><span className="latest-meta-label">登録日</span><span className="latest-meta-value">{formatRegistrationDate(latestRecord.registrationDate)}</span></div>
                      </div>
                    </>
                  ) : <p className="dashboard-placeholder">登録された試験記録はありません。</p>}
                </div>
              </article>
              <article className="content-card">
                <div className="content-card-heading">
                  <div><p className="card-kicker">QUICK ACCESS</p><h2>操作メニュー</h2></div>
                  <span className="heading-icon" aria-hidden="true">⌘</span>
                </div>
                <div className="quick-links">
                  <button type="button" className="quick-link" onClick={() => navigateTo('searchSection')}>
                    <span className="quick-icon search-icon" aria-hidden="true">⌕</span>
                    <span className="quick-copy"><strong>記録の登録・検索</strong><small>登録済みの記録を確認</small></span>
                    <span className="quick-arrow" aria-hidden="true">›</span>
                  </button>
                </div>
              </article>
            </div>
          </section>
        )}

        {section === 'searchSection' && (
          <section className="page-section active">
            <div className="search-panel">
              <div className="search-grid">
                <SearchField label="試験番号" name="trialNo" value={searchFilters.trialNo} onChange={setSearchFilters} placeholder="試験番号" maxLength={20} />
                <SearchField label="製番" name="productNo" value={searchFilters.productNo} onChange={setSearchFilters} placeholder="製番" maxLength={30} />
                <SearchField label="登録日" name="date" value={searchFilters.date} onChange={setSearchFilters} placeholder="yyyymmdd" maxLength={8} />
                <SearchField label="担当者" name="manager" value={searchFilters.manager} onChange={setSearchFilters} placeholder="担当者" maxLength={30} />
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
                        setSelectedRecordId(record.id);
                        handleEditRecord(record);
                      }}
                      onKeyDown={(event) => {
                        if (event.target !== event.currentTarget) return;
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          setSelectedRecordId(record.id);
                          handleEditRecord(record);
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
                          <button
                            type="button"
                            className="copy-button secondary-button"
                            onClick={() => {
                              setSelectedRecordId(record.id);
                              handleEditRecord(record);
                            }}
                          >
                            詳細
                          </button>
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
      </main>
      {section === 'searchSection' && newRecordOpen && (
        <NewRecordDialog onClose={closeNewRecord} registering={registering}>
          {registrationForm}
        </NewRecordDialog>
      )}
      {section === 'searchSection' && detailRecord && (
        <RecordDetails
          key={detailRecord.id}
          record={detailRecord}
          csrfToken={csrfToken.current}
          onClose={() => { setDetailRecord(null); clearRegistrationDraft(); setRegisterMessage({ text: '', type: '' }); }}
          recordDirty={recordDirty}
          registering={registering}
          registrationForm={registrationForm}
          setAuthenticated={setAuthenticated}
          setLoginError={setLoginError}
        />
      )}
    </div>
  );
}

function NewRecordDialog({ children, onClose, registering }) {
  const dialog = useRef(null);
  useEffect(() => {
    const element = dialog.current;
    element.showModal();
    return () => element.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="record-detail-dialog new-record-dialog"
      aria-labelledby="new-record-title"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <header className="record-detail-heading">
        <h2 id="new-record-title">新規登録</h2>
        <button type="button" className="detail-close" aria-label="閉じる" title="閉じる" disabled={registering} onClick={onClose}>{'\u00d7'}</button>
      </header>
      {children}
    </dialog>
  );
}

function RegistrationForm({ registerForm, handleRegister, registrationValues, setRegistrationValues, editingRecordId, existingFiles, removedFileIds, setRemovedFileIds, registering, cancelRegister, registerMessage, onChange }) {
  return (
    <form ref={registerForm} className="form-panel" onSubmit={handleRegister} onChange={onChange}>
      <fieldset className="record-form-fields" disabled={registering}>
        <div className="form-grid">
          <label className="field"><span>試験番号</span><input name="trialNo" type="text" maxLength="20" placeholder="例: T-001" value={registrationValues.trialNo} onChange={(event) => setRegistrationValues((values) => ({ ...values, trialNo: event.target.value }))} required /></label>
          {editingRecordId !== null && (
            <>
              <label className="field"><span>案件名</span><input name="projectName" type="text" maxLength="30" placeholder="例: X製品試験" value={registrationValues.projectName} onChange={(event) => setRegistrationValues((values) => ({ ...values, projectName: event.target.value }))} /></label>
              <label className="field"><span>製番</span><input name="productNo" type="text" maxLength="30" placeholder="例: A 12345" value={registrationValues.productNo} onChange={(event) => setRegistrationValues((values) => ({ ...values, productNo: event.target.value }))} /></label>
              <label className="field"><span>登録日</span><input name="registrationDate" type="text" maxLength="8" value={registrationValues.registrationDate} onChange={(event) => setRegistrationValues((values) => ({ ...values, registrationDate: event.target.value }))} placeholder="yyyymmdd" required /></label>
            </>
          )}
          <label className="field"><span>担当者</span><input name="manager" type="text" maxLength="30" placeholder="例: 山田太郎" value={registrationValues.manager} onChange={(event) => setRegistrationValues((values) => ({ ...values, manager: event.target.value }))} required /></label>
          {editingRecordId !== null && (
            <label className="field file-field">
              <span>試験結果</span>
              <input name="resultFiles" type="file" multiple />
              <small className="field-help">既存ファイルは維持されます。追加するファイルは1件100MB以下、合計100MBまでです。</small>
            </label>
          )}
        </div>
        {editingRecordId !== null && (
          <div className="existing-files">
            <strong>現在の添付ファイル</strong>
            {existingFiles.length ? (
              <ul>{existingFiles.map((file) => (
                <li key={file.id}>
                  <a className="file-link" href={`/api/records/${encodeURIComponent(editingRecordId)}/files/${encodeURIComponent(file.id)}`}>{file.fileName}</a>
                  <label className="remove-file">
                    <input type="checkbox" checked={removedFileIds.includes(file.id)} onChange={(event) => {
                      setRemovedFileIds((current) => event.target.checked ? [...current, file.id] : current.filter((id) => id !== file.id));
                    }} />
                    削除する
                  </label>
                </li>
              ))}</ul>
            ) : <p className="field-help">添付ファイルはありません。</p>}
          </div>
        )}
        <div className="button-row">
          <button type="submit" className="primary-button" disabled={registering}>{registering ? '処理中...' : editingRecordId === null ? '登録' : '変更を保存'}</button>
          <button type="button" className="secondary-button" onClick={cancelRegister}>{editingRecordId === null ? 'キャンセル' : '変更をキャンセル'}</button>
        </div>
      </fieldset>
      {registerMessage.text && <Message type={registerMessage.type}>{registerMessage.text}</Message>}
    </form>
  );
}

function RecordDetails({ record, csrfToken, onClose, recordDirty, registering, registrationForm, setAuthenticated, setLoginError }) {
  const dialog = useRef(null);
  const [jumpers, setJumpers] = useState(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState({ text: '', type: '' });
  const [equipmentDirty, setEquipmentDirty] = useState(false);

  function closeDetails() {
    if (registering) return;
    if ((recordDirty || equipmentDirty) && !window.confirm('未保存の変更を破棄して閉じますか？')) return;
    onClose();
  }

  useEffect(() => {
    const element = dialog.current;
    element.showModal();
    return () => element.close();
  }, []);

  useEffect(() => {
    let active = true;
    apiRequest(`/api/records/${record.id}/jumpers`, csrfToken).then((result) => {
      if (active) setJumpers(result);
    }).catch((error) => {
      if (!active) return;
      setMessage({ text: error.message, type: 'error' });
      if (error.status === 401) {
        setLoginError(error.message);
        setAuthenticated(false);
      }
    });
    return () => { active = false; };
  }, [record.id, csrfToken, setAuthenticated, setLoginError]);

  async function toggleConfirmation(jumper) {
    setSaving(true);
    setMessage({ text: '', type: '' });
    try {
      const result = await apiRequest(`/api/records/${record.id}/jumpers/${jumper.name}`, csrfToken, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmed: !jumper.confirmed }),
      });
      setJumpers((current) => current.map((item) => item.name === result.name ? result : item));
      setMessage({ text: `${jumper.name}の確認結果を保存しました。`, type: 'success' });
    } catch (error) {
      setMessage({ text: error.message, type: 'error' });
      if (error.status === 401) {
        setLoginError(error.message);
        setAuthenticated(false);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      className="record-detail-dialog"
      aria-labelledby="record-detail-title"
      onCancel={(event) => { event.preventDefault(); closeDetails(); }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          closeDetails();
        }
      }}
    >
      <header className="record-detail-heading">
        <h2 id="record-detail-title">記録の詳細</h2>
        <button
          type="button"
          className="detail-close"
          aria-label="閉じる"
          title="閉じる"
          disabled={registering}
          onClick={closeDetails}
        >{ '\u00d7' }</button>
      </header>
      {registrationForm}
      <h3 className="jumper-heading">ジャンパ設定</h3>
      {jumpers ? (
        <div className="equipment-table-wrap jumper-table-wrap">
          <table className="jumper-table equipment-table" aria-label="ジャンパ設定の確認" aria-busy={saving}>
            <thead><tr><th scope="col">ジャンパ名</th><th scope="col">設定</th><th scope="col">確認結果</th></tr></thead>
            <tbody>
              {jumpers.map((jumper) => (
                <tr key={jumper.name}>
                  <td>{jumper.name}</td>
                  <td>{jumper.setting}</td>
                  <td>
                    <label className="jumper-check" title={`${jumper.name}：${jumper.confirmed ? '確認済み' : '未確認'}`}>
                      <input
                        type="checkbox"
                        aria-label={`${jumper.name}の設定を確認`}
                        checked={jumper.confirmed}
                        disabled={saving}
                        onChange={() => toggleConfirmation(jumper)}
                      />
                      <span aria-hidden="true">{jumper.confirmed ? '\u2705' : '\u25a1'}</span>
                    </label>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : !message.text && <Message>読み込み中...</Message>}
      <Message type={message.type}>{saving ? '保存中...' : message.text}</Message>
      <EquipmentForm
        recordId={record.id}
        csrfToken={csrfToken}
        dirty={equipmentDirty}
        setDirty={setEquipmentDirty}
        setAuthenticated={setAuthenticated}
        setLoginError={setLoginError}
      />
    </dialog>
  );
}

const EQUIPMENT_SECTIONS = [
  {
    key: 'boards', title: '基板番号',
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
      { key: 'testItems', label: '使用試験項目(5T3RD381)' },
    ],
  },
  {
    key: 'software', title: 'インストールソフト・PLDバージョン',
    columns: [
      { key: 'name', label: 'ソフト', fixed: true },
      { key: 'sdFormat', label: 'SD 形式', fixed: true },
      { key: 'version', label: 'バージョン' },
      { key: 'checksum', label: 'チェックサム' },
    ],
  },
];

function EquipmentForm({ recordId, csrfToken, dirty, setDirty, setAuthenticated, setLoginError }) {
  const [equipment, setEquipment] = useState(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState({ text: '', type: '' });

  useEffect(() => {
    let active = true;
    apiRequest(`/api/records/${recordId}/equipment`, csrfToken).then((result) => {
      if (active) setEquipment(result);
    }).catch((error) => {
      if (!active) return;
      setMessage({ text: error.message, type: 'error' });
      if (error.status === 401) {
        setLoginError(error.message);
        setAuthenticated(false);
      }
    });
    return () => { active = false; };
  }, [recordId, csrfToken, setAuthenticated, setLoginError]);

  function changeField(group, rowIndex, field, value) {
    setEquipment((current) => ({
      ...current,
      [group]: current[group].map((row, index) => index === rowIndex ? { ...row, [field]: value } : row),
    }));
    setDirty(true);
    setMessage({ text: '', type: '' });
  }

  async function saveEquipment(event) {
    event.preventDefault();
    setSaving(true);
    setMessage({ text: '', type: '' });
    try {
      const result = await apiRequest(`/api/records/${recordId}/equipment`, csrfToken, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(equipment),
      });
      setEquipment(result);
      setDirty(false);
      setMessage({ text: '機器情報を保存しました。', type: 'success' });
    } catch (error) {
      setMessage({ text: error.message, type: 'error' });
      if (error.status === 401) {
        setLoginError(error.message);
        setAuthenticated(false);
      }
    } finally {
      setSaving(false);
    }
  }

  if (!equipment) {
    return <Message type={message.type}>{message.text || '機器情報を読み込み中...'}</Message>;
  }

  return (
    <form className="equipment-form" onSubmit={saveEquipment} aria-busy={saving}>
      <fieldset disabled={saving}>
        {EQUIPMENT_SECTIONS.map((group) => (
          <section key={group.key} aria-labelledby={`equipment-${group.key}-heading`}>
            <h3 id={`equipment-${group.key}-heading`} className="jumper-heading">{group.title}</h3>
            <div className="equipment-table-wrap">
              <table className={`equipment-table equipment-table--${group.key}`} aria-label={group.title}>
                <thead><tr>{group.columns.map((column) => <th key={column.key} scope="col">{column.label}</th>)}</tr></thead>
                <tbody>
                  {equipment[group.key].map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {group.columns.map((column) => (
                        <td key={column.key}>
                          {column.fixed ? row[column.key] : (
                            <input
                              type="text"
                              aria-label={`${group.key === 'instruments' ? `使用計測器 ${rowIndex + 1}行目` : row.name} ${column.label}`}
                              value={row[column.key]}
                              maxLength={100}
                              onChange={(event) => changeField(group.key, rowIndex, column.key, event.target.value)}
                            />
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}
        <div className="equipment-save-row">
          <button type="submit" className="primary-button" disabled={!dirty || saving}>
            {saving ? '保存中...' : '機器情報を保存'}
          </button>
          {dirty && <span className="status-text warning">未保存</span>}
        </div>
      </fieldset>
      <Message type={message.type}>{message.text}</Message>
    </form>
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
function SearchField({ label, name, value, onChange, placeholder, maxLength }) {
  return (
    <label className="field">
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
