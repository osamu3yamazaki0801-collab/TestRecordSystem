import { useCallback, useEffect, useState } from 'react';

export default function WorkflowInbox({ active, csrfToken, request, setAuthenticated, setLoginError }) {
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState({ text: '', type: '' });

  const loadTasks = useCallback(async () => {
    setLoading(true);
    try {
      const result = await request('/api/workflow-inbox', csrfToken);
      setTasks(result.tasks);
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
    if (!active) return undefined;
    loadTasks();
    window.addEventListener('focus', loadTasks);
    return () => window.removeEventListener('focus', loadTasks);
  }, [active, loadTasks]);

  return (
    <section className="page-section active workflow-inbox">
      <div className="panel-title-row">
        <h2>対応が必要な回覧</h2>
        <button type="button" className="secondary-button" disabled={loading} onClick={loadTasks}>
          {loading ? '更新中...' : '一覧を更新'}
        </button>
      </div>
      {message.text && <p className={`status-text ${message.type}`} role="status">{message.text}</p>}
      {loading && !tasks.length ? (
        <p className="status-text" aria-live="polite">回覧タスクを読み込み中...</p>
      ) : tasks.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>試験番号</th><th>案件名</th><th>段階</th><th>担当者</th><th>操作</th></tr>
            </thead>
            <tbody>
              {tasks.map((task) => (
                <tr key={task.recordId}>
                  <td>{task.trialNo}</td>
                  <td>{task.projectName}</td>
                  <td>{task.stageName}</td>
                  <td>{task.assigneeName}{task.isAssignedToMe ? '（自分）' : '（管理者確認）'}</td>
                  <td>
                    <a
                      className="secondary-button"
                      href={`/?recordId=${encodeURIComponent(task.recordId)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >詳細を開く</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        !loading && <p className="empty-state">対応が必要な回覧はありません。</p>
      )}
    </section>
  );
}
