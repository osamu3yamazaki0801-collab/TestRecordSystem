import React, { useEffect, useState } from "react";

export default function PasswordChange() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);
  const [csrfToken, setCsrfToken] = useState("");

  useEffect(() => {
    const token = document.querySelector("meta[name='csrf-token']")?.getAttribute("content");
    if (token) {
      setCsrfToken(token);
    }
  }, []);

  const handleChangePassword = async (e) => {
    e.preventDefault();
    setError("");
    setSuccess(false);

    if (!currentPassword || !newPassword || !confirmPassword) {
      setError("すべてのフィールドを入力してください。");
      return;
    }

    if (newPassword !== confirmPassword) {
      setError("新しいパスワードと確認用パスワードが一致しません。");
      return;
    }

    if (newPassword.length < 8) {
      setError("新しいパスワードは8文字以上である必要があります。");
      return;
    }

    setLoading(true);
    try {
      const response = await fetch("/api/account/password", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          ...(csrfToken && { "X-CSRF-Token": csrfToken }),
        },
        body: JSON.stringify({
          currentPassword,
          newPassword,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        setError(data.error || "パスワード変更に失敗しました。");
      } else {
        setSuccess(true);
        setCurrentPassword("");
        setNewPassword("");
        setConfirmPassword("");
        setTimeout(() => setSuccess(false), 3000);
      }
    } catch (err) {
      setError("通信エラーが発生しました。");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="form-container">
      <h2>パスワード変更</h2>
      <form onSubmit={handleChangePassword}>
        <div className="form-group">
          <label htmlFor="currentPassword">現在のパスワード:</label>
          <div className="password-input-control">
            <input
              id="currentPassword"
              type={showCurrentPassword ? "text" : "password"}
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder="現在のパスワードを入力"
              disabled={loading}
            />
            <button
              type="button"
              className="password-toggle-button"
              onClick={() => setShowCurrentPassword(!showCurrentPassword)}
              aria-pressed={showCurrentPassword}
              disabled={loading}
            >
              {showCurrentPassword ? "隠す" : "表示"}
            </button>
          </div>
        </div>

        <div className="form-group">
          <label htmlFor="newPassword">新しいパスワード (8文字以上):</label>
          <div className="password-input-control">
            <input
              id="newPassword"
              type={showNewPassword ? "text" : "password"}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="新しいパスワードを入力"
              minLength="8"
              disabled={loading}
            />
            <button
              type="button"
              className="password-toggle-button"
              onClick={() => setShowNewPassword(!showNewPassword)}
              aria-pressed={showNewPassword}
              disabled={loading}
            >
              {showNewPassword ? "隠す" : "表示"}
            </button>
          </div>
        </div>

        <div className="form-group">
          <label htmlFor="confirmPassword">パスワード確認:</label>
          <div className="password-input-control">
            <input
              id="confirmPassword"
              type={showConfirmPassword ? "text" : "password"}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="パスワードを再度入力"
              minLength="8"
              disabled={loading}
            />
            <button
              type="button"
              className="password-toggle-button"
              onClick={() => setShowConfirmPassword(!showConfirmPassword)}
              aria-pressed={showConfirmPassword}
              disabled={loading}
            >
              {showConfirmPassword ? "隠す" : "表示"}
            </button>
          </div>
        </div>

        {error && <div className="error-message">{error}</div>}
        {success && (
          <div className="success-message">
            パスワードが正常に変更されました。
          </div>
        )}

        <button type="submit" disabled={loading} className="submit-button">
          {loading ? "変更中..." : "パスワードを変更"}
        </button>
      </form>
    </div>
  );
}
