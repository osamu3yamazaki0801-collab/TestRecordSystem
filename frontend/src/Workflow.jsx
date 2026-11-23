import { useEffect, useRef, useState } from 'react';

const INITIAL_STEPS = [
  { stageName: '担当', assigneeName: '', assigneeEmail: '' },
  { stageName: '調査', assigneeName: '', assigneeEmail: '' },
];

const STAGE_NAMES = ['担当', '調査', '承認'];

const STATUS_LABELS = {
  draft: '未開始',
  active: '回覧中',
  completed: '完了',
  pending: '未着手',
};

const EVENT_LABELS = {
  configured: 'フローを保存',
  started: '回覧を開始',
  forwarded: '次の担当者へ回覧',
  completed: '回覧を完了',
};

export default function Workflow({ record, managerChoices, managerEmails = {}, active, csrfToken, request, setAuthenticated, setLoginError }) {
  const [workflow, setWorkflow] = useState(null);
  const [steps, setSteps] = useState(INITIAL_STEPS.map((step, index) => ({ ...step, key: `initial-${index}` })));
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [stepsDirty, setStepsDirty] = useState(false);
  const [message, setMessage] = useState({ text: '', type: '' });
  const stepSequence = useRef(0);

  async function loadWorkflow() {
    const result = await request(`/api/records/${record.id}/workflow`, csrfToken);
    setWorkflow(result.workflow);
    setStepsDirty(false);
    if (result.workflow) {
      setSteps(result.workflow.steps.map((step, index) => ({ ...step, key: `saved-${index}` })));
    } else {
      setSteps(INITIAL_STEPS.map((step, index) => ({ ...step, key: `initial-${index}` })));
    }
  }

  useEffect(() => {
    if (!active) return undefined;
    let isMounted = true;
    request(`/api/records/${record.id}/workflow`, csrfToken).then((result) => {
      if (!isMounted) return;
      setWorkflow(result.workflow);
      setStepsDirty(false);
      if (result.workflow) {
        setSteps(result.workflow.steps.map((step, index) => ({ ...step, key: `saved-${index}` })));
      }
      setLoading(false);
    }).catch((error) => {
      if (!isMounted) return;
      setMessage({ text: error.message, type: 'error' });
      setLoading(false);
      if (error.status === 401) {
        setAuthenticated(false);
        setLoginError(error.message);
      }
    });
    return () => { isMounted = false; };
  }, [record.id, active, csrfToken, request, setAuthenticated, setLoginError]);

  useEffect(() => {
    if (!stepsDirty || workflow?.status === 'active') return undefined;
    const warnBeforeUnload = (event) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, [stepsDirty, workflow?.status]);

  async function submitAction(url, options = {}) {
    setPending(true);
    setMessage({ text: '', type: '' });
    try {
      await request(url, csrfToken, options);
      await loadWorkflow();
      setMessage({ text: '回覧情報を更新しました。', type: 'success' });
    } catch (error) {
      setMessage({ text: error.message, type: 'error' });
      if (error.status === 401) {
        setAuthenticated(false);
        setLoginError(error.message);
      }
    } finally {
      setPending(false);
    }
  }

  function saveWorkflow(event) {
    event.preventDefault();
    return submitAction(`/api/records/${record.id}/workflow`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        steps: steps.map(({ stageName, assigneeName, assigneeEmail }) => ({
          stageName,
          assigneeName,
          assigneeEmail,
        })),
      }),
    });
  }

  function updateStep(index, field, value) {
    setStepsDirty(true);
    setSteps((current) => current.map((step, stepIndex) => (
      stepIndex === index ? { ...step, [field]: value } : step
    )));
  }

  function selectAssignee(index, assigneeName) {
    setStepsDirty(true);
    setSteps((current) => current.map((step, stepIndex) => {
      if (stepIndex !== index) return step;
      const configuredEmail = managerEmails[assigneeName] || '';
      return {
        ...step,
        assigneeName,
        assigneeEmail: configuredEmail
          || (step.assigneeName === assigneeName ? step.assigneeEmail : ''),
      };
    }));
  }

  function moveStep(index, offset) {
    const target = index + offset;
    if (target < 0 || target >= steps.length) return;
    setStepsDirty(true);
    setSteps((current) => {
      const reordered = [...current];
      [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
      return reordered;
    });
  }

  function addStep() {
    if (steps.length >= 20) return;
    stepSequence.current += 1;
    setStepsDirty(true);
    setSteps((current) => [
      ...current,
      { key: `new-${stepSequence.current}`, stageName: '', assigneeName: '', assigneeEmail: '' },
    ]);
  }

  if (loading) return <p className="status-text" aria-live="polite">回覧情報を読み込み中...</p>;

  const editable = workflow?.status !== 'active';
  const currentStep = workflow?.steps[workflow.currentStep];
  const availableManagers = managerChoices || [];

  return (
    <section className="workflow-panel" aria-labelledby="workflow-title">
      <h2 id="workflow-title">回覧フロー</h2>
      <p className="field-help">段階・担当者・メールアドレスを設定して保存し、回覧を開始すると最初の担当者へメールを送信します。</p>
      {workflow && (
        <p className={`workflow-status workflow-status--${workflow.status}`}>
          状態：{STATUS_LABELS[workflow.status]}
          {currentStep && ` ／ 現在の担当：${currentStep.assigneeName}（${currentStep.stageName}）`}
        </p>
      )}
      <form onSubmit={saveWorkflow}>
        <ol className="workflow-steps">
          {steps.map((step, index) => (
            <li className="workflow-step" key={step.key}>
              <div className="workflow-step-heading">
                <strong>段階 {index + 1}</strong>
                {workflow?.status === 'active' && (
                  <span className={`workflow-step-status workflow-step-status--${step.status}`}>
                    {step.status === 'active' ? '対応中' : STATUS_LABELS[step.status]}
                  </span>
                )}
              </div>
              <div className="workflow-step-fields">
                <label className="field">
                  <span>段階名</span>
                  <select
                    required
                    value={step.stageName}
                    disabled={!editable || pending}
                    onChange={(event) => updateStep(index, 'stageName', event.target.value)}
                  >
                    <option value="" disabled>段階名を選択</option>
                    {step.stageName && !STAGE_NAMES.includes(step.stageName) && (
                      <option value={step.stageName}>{step.stageName}</option>
                    )}
                    {STAGE_NAMES.map((stageName) => <option key={stageName} value={stageName}>{stageName}</option>)}
                  </select>
                </label>
                <label className="field">
                  <span>担当者</span>
                  <select
                    required
                    value={step.assigneeName}
                    disabled={!editable || pending || !availableManagers.length}
                    onChange={(event) => selectAssignee(index, event.target.value)}
                  >
                    <option value="" disabled>
                      {availableManagers.length ? '担当者を選択' : '担当者候補がありません'}
                    </option>
                    {step.assigneeName && !availableManagers.includes(step.assigneeName) && (
                      <option value={step.assigneeName}>{step.assigneeName}</option>
                    )}
                    {availableManagers.map((manager) => <option key={manager} value={manager}>{manager}</option>)}
                  </select>
                </label>
                <label className="field">
                  <span>メールアドレス</span>
                  <input
                    type="email"
                    maxLength="254"
                    required
                    value={step.assigneeEmail}
                    disabled={!editable || pending}
                    onChange={(event) => updateStep(index, 'assigneeEmail', event.target.value)}
                    placeholder="name@example.com"
                  />
                  <small className="field-help">managerChoicesのemailから自動入力できます。未設定の場合はここで入力してください。</small>
                </label>
              </div>
              {editable && (
                <div className="workflow-step-actions">
                  <button type="button" className="secondary-button" disabled={pending || index === 0} onClick={() => moveStep(index, -1)}>上へ</button>
                  <button type="button" className="secondary-button" disabled={pending || index === steps.length - 1} onClick={() => moveStep(index, 1)}>下へ</button>
                  <button type="button" className="delete-button" disabled={pending || steps.length === 1} onClick={() => {
                    setStepsDirty(true);
                    setSteps((current) => current.filter((_, stepIndex) => stepIndex !== index));
                  }}>削除</button>
                </div>
              )}
            </li>
          ))}
        </ol>
        {editable && (
          <div className="button-row workflow-actions">
            <button type="button" className="secondary-button" disabled={pending || steps.length >= 20} onClick={addStep}>段階を追加</button>
            <button type="submit" className="primary-button" disabled={pending}>{pending ? '保存中...' : 'フローを保存'}</button>
            {workflow?.status === 'draft' && (
              <button
                type="button"
                className="primary-button"
                disabled={pending || stepsDirty}
                onClick={() => submitAction(`/api/records/${record.id}/workflow/start`, { method: 'POST' })}
              >{pending ? '処理中...' : '回覧を開始して担当者へ通知'}</button>
            )}
            {workflow?.status === 'completed' && (
              <button
                type="button"
                className="secondary-button"
                disabled={pending}
                onClick={() => {
                  setWorkflow(null);
                  setStepsDirty(true);
                  setSteps(INITIAL_STEPS.map((step, index) => ({ ...step, key: `new-${index}` })));
                }}
              >新しい回覧を作成</button>
            )}
          </div>
        )}
      </form>
      {workflow?.status === 'active' && (
        <div className="button-row workflow-actions">
          <button
            type="button"
            className="primary-button"
            disabled={pending}
            onClick={() => submitAction(`/api/records/${record.id}/workflow/advance`, { method: 'POST' })}
          >{pending ? '処理中...' : currentStep && workflow.currentStep < workflow.steps.length - 1 ? '完了して次の担当者へ通知' : '回覧を完了'}</button>
        </div>
      )}
      {workflow?.events?.length > 0 && (
        <section className="workflow-history" aria-labelledby="workflow-history-title">
          <h3 id="workflow-history-title">回覧履歴</h3>
          <ol>
            {workflow.events.map((event, index) => (
              <li key={`${event.created_at}-${index}`}>
                {EVENT_LABELS[event.action] || event.action}：{event.actor}（{event.created_at}）
              </li>
            ))}
          </ol>
        </section>
      )}
      {message.text && <p className={`status-text ${message.type}`} role="status">{message.text}</p>}
    </section>
  );
}
