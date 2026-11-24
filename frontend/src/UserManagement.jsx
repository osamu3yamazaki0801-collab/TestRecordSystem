import { useCallback, useEffect, useState } from 'react';

export default function UserManagement({ active, csrfToken, request, setAuthenticated, setLoginError }) {
  const [users, setUsers] = useState([]);
  const [managerChoices, setManagerChoices] = useState([]);
  const [username, setUsername] = useState('');
  const [managerName, setManagerName] = useState('');
  const [password, setPassword] = useState('');
  const [resetPasswords, setResetPasswords] = useState({});
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showResetPasswords, setShowResetPasswords] = useState({});
  const [loading, setLoading] = useState(true);
  const [pendingUserId, setPendingUserId] = useState(null);
  const [message, setMessage] = useState({ text: '', type: '' });

  const loadUsers = useCallback(async () => {
    setLoading(true);
    try {
      const result = await request('/api/admin/users', csrfToken);
      setUsers(result.users);
      setManagerChoices(result.managerChoices);
      setMessage({ text: '', type: '' });
    } catch (error) {
      setMessage({ text: error.message, type: 'error' });
      if (error.status === 401) {
        setAuthenticated(false);
        setLoginError(error.message);
      }
    } finally {
      setLoading(false);
    }
  }, [csrfToken, request, setAuthenticated, setLoginError]);

  useEffect(() => {
    if (active) loadUsers();
  }, [active, loadUsers]);

  async function submitNewUser(event) {
    event.preventDefault();
    setPendingUserId('new');
    setMessage({ text: '', type: '' });
    try {
      await request('/api/admin/users', csrfToken, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, managerName, password }),
      });
      setUsername('');
      setManagerName('');
      setPassword('');
      await loadUsers();
      setMessage({ text: 'アカウントを作成しました。', type: 'success' });
    } catch (error) {
      setMessage({ text: error.message, type: 'error' });
      if (error.status === 401) {
        setAuthenticated(false);
        setLoginError(error.message);
      }
    } finally {
      setPendingUserId(null);
    }
  }

  async function updateUser(user, changes, successMessage) {
    setPendingUserId(user.id);
    setMessage({ text: '', type: '' });
    try {
      await request(`/api/admin/users/${user.id}`, csrfToken, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(changes),
      });
      setResetPasswords((current) => ({ ...current, [user.id]: '' }));
      await loadUsers();
      setMessage({ text: successMessage, type: 'success' });
    } catch (error) {
      setMessage({ text: error.message, type: 'error' });
      if (error.status === 401) {
        setAuthenticated(false);
        setLoginError(error.message);
      }
    } finally {
      setPendingUserId(null);
    }
  }

  return (
    <section className="page-section active user-management">
      <h2>担当者アカウント</h2>
      <p className="field-help">担当者候補にログインIDと初期パスワードを割り当てます。パスワードは本人に安全な方法で伝えてください。</p>
      <form className="form-panel user-create-form" onSubmit={submitNewUser}>
        <label className="field">
          <span>ログインID</span>
          <input
            type="text"
            autoComplete="off"
            minLength="3"
            maxLength="50"
            pattern="[A-Za-z0-9._-]+"
            required
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
        </label>
        <label className="field">
          <span>担当者</span>
          <select required value={managerName} onChange={(event) => setManagerName(event.target.value)}>
            <option value="" disabled>担当者を選択</option>
            {managerChoices.map((choice) => <option key={choice} value={choice}>{choice}</option>)}
          </select>
        </label>
        <label className="field">
          <span>初期パスワード（8文字以上）</span>
          <div className="password-input-control">
            <input
              type={showNewPassword ? "text" : "password"}
              autoComplete="new-password"
              minLength="8"
              maxLength="256"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <button
              type="button"
              className="password-toggle-button"
              onClick={() => setShowNewPassword(!showNewPassword)}
              aria-pressed={showNewPassword}
            >
              {showNewPassword ? "隠す" : "表示"}
            </button>
          </div>
        </label>
        <button type="submit" className="primary-button" disabled={pendingUserId === 'new' || !managerChoices.length}>
          {pendingUserId === 'new' ? '作成中...' : 'アカウントを作成'}
        </button>
      </form>

      <div className="panel-title-row">
        <h2>登録済みアカウント</h2>
        <button type="button" className="secondary-button" disabled={loading} onClick={loadUsers}>
          {loading ? '更新中...' : '一覧を更新'}
        </button>
      </div>
      {message.text && <p className={`status-text ${message.type}`} role="status">{message.text}</p>}
      {loading && !users.length ? (
        <p className="status-text" aria-live="polite">アカウントを読み込み中...</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>ログインID</th><th>担当者</th><th>権限・状態</th><th>パスワード再設定</th><th>操作</th></tr></thead>
            <tbody>
              {users.map((user) => {
                const resetPassword = resetPasswords[user.id] || '';
                return (
                  <tr key={user.id}>
                    <td>{user.username}</td>
                    <td>{user.managerName || '管理者'}</td>
                    <td>{user.role === 'admin' ? '管理者' : '担当者'}・{user.isActive ? '有効' : '無効'}</td>
                    <td>
                      <div className="password-input-control">
                        <input
                          type={showResetPasswords[user.id] ? "text" : "password"}
                          aria-label={`${user.username}の新しいパスワード`}
                          autoComplete="new-password"
                          minLength="8"
                          maxLength="256"
                          value={resetPassword}
                          onChange={(event) => setResetPasswords((current) => ({
                            ...current,
                            [user.id]: event.target.value,
                          }))}
                        />
                        <button
                          type="button"
                          className="password-toggle-button"
                          onClick={() => setShowResetPasswords((current) => ({
                            ...current,
                            [user.id]: !current[user.id],
                          }))}
                          aria-pressed={showResetPasswords[user.id] || false}
                        >
                          {showResetPasswords[user.id] ? "隠す" : "表示"}
                        </button>
                      </div>
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={pendingUserId === user.id || resetPassword.length < 8}
                        onClick={() => updateUser(user, { password: resetPassword }, 'パスワードを再設定しました。')}
                      >再設定</button>
                    </td>
                    <td>
                      {user.role === 'user' && (
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={pendingUserId === user.id}
                          onClick={() => updateUser(user, { isActive: !user.isActive }, user.isActive ? 'アカウントを無効にしました。' : 'アカウントを有効にしました。')}
                        >{user.isActive ? '無効にする' : '有効にする'}</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
