import { useCallback, useEffect, useState } from 'react';

export default function UserManagement({ active, csrfToken, request, setAuthenticated, setLoginError }) {
  const [users, setUsers] = useState([]);
  const [username, setUsername] = useState('');
  const [managerName, setManagerName] = useState('');
  const [managerEmail, setManagerEmail] = useState('');
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
        body: JSON.stringify({ username, managerName, managerEmail, password }),
      });
      setUsername('');
      setManagerName('');
      setManagerEmail('');
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

  async function deleteUser(user) {
    if (!window.confirm(
      `ユーザー「${user.username}」を削除します。この操作は取り消せません。`,
    )) {
      return;
    }
    setPendingUserId(user.id);
    setMessage({ text: '', type: '' });
    try {
      await request(`/api/admin/users/${user.id}`, csrfToken, { method: 'DELETE' });
      await loadUsers();
      setMessage({ text: 'アカウントを削除しました。', type: 'success' });
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
      <p className="field-help">担当者名、ログインID、初期パスワードを登録します。パスワードは本人に安全な方法で伝えてください。</p>
      <form className="form-panel user-create-form" onSubmit={submitNewUser}>
        <label className="field">
          <span>ログインID</span>
          <small className="field-help">半角英数字、ピリオド（.）、アンダースコア（_）、ハイフン（-）の3～50文字</small>
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
          <small className="field-help">日本語、半角数字、空白の30文字以内</small>
          <input
            type="text"
            maxLength="30"
            pattern="[\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Han}0-9\\s]+"
            required
            value={managerName}
            onChange={(event) => setManagerName(event.target.value)}
          />
        </label>
        <label className="field">
          <span>メールアドレス</span>
          <input
            type="email"
            maxLength="254"
            value={managerEmail}
            onChange={(event) => setManagerEmail(event.target.value)}
          />
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
        <button type="submit" className="primary-button" disabled={pendingUserId === 'new'}>
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
            <thead><tr><th className="user-id-cell">ログインID</th><th className="user-manager-cell">担当者</th><th>メールアドレス</th><th>パスワード再設定</th><th>権限・状態</th><th>削除</th></tr></thead>
            <tbody>
              {users.map((user) => {
                const resetPassword = resetPasswords[user.id] || '';
                return (
                  <tr key={user.id}>
                    <td className="user-id-cell">{user.username}</td>
                    <td className="user-manager-cell">{user.managerName || '管理者'}</td>
                    <td>{user.managerEmail || '—'}</td>
                    <td className="user-password-cell">
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
                    <td className="user-status-cell">
                      <div className="user-status-control">
                        <span>{user.role === 'admin' ? '管理者' : '担当者'}・{user.isActive ? '有効' : '無効'}</span>
                        {user.role === 'user' && (
                          <button
                            type="button"
                            className="secondary-button"
                            disabled={pendingUserId === user.id}
                            onClick={() => updateUser(user, { isActive: !user.isActive }, user.isActive ? 'アカウントを無効にしました。' : 'アカウントを有効にしました。')}
                          >{user.isActive ? '無効にする' : '有効にする'}</button>
                        )}
                      </div>
                    </td>
                    <td className="user-delete-cell">
                      {user.role === 'user' && (
                        <button
                          type="button"
                          className="delete-button"
                          disabled={pendingUserId === user.id}
                          onClick={() => deleteUser(user)}
                        >削除</button>
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
