param(
    # ユーザーが未登録の場合に作成する初期管理者のユーザー名。
    [string]$Username = "toshiba"
)

# エラー発生時は処理を中断し、このフォルダー内の仮想環境を使用する。
$ErrorActionPreference = "Stop"
$python = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"

if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
    throw "Virtual environment not found. Run 'py -m venv .venv' and install requirements.txt first."
}

# 作業フォルダーをスクリプトの場所に変更し、終了時に元に戻す。
Push-Location $PSScriptRoot
try {
    # セッションの署名用キーを起動のたびに生成する。
    # .env は読み込まず、再起動すると既存のログインセッションは無効になる。
    $secretKey = & $python -c "import secrets; print(secrets.token_urlsafe(48))"
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($secretKey)) {
        throw "Failed to generate the secret key."
    }

    # 環境変数で指定されたDBを優先し、未指定なら既定のDBを使う。
    $databasePath = if ($env:LEDGER_DATABASE_PATH) {
        $env:LEDGER_DATABASE_PATH
    } else {
        Join-Path $PSScriptRoot "instance\trial-ledger.sqlite3"
    }

    # 子プロセスのアプリに設定を渡す。COOKIE_SECURE=0 はHTTPでの利用を許可する。
    $env:LEDGER_SECRET_KEY = $secretKey.Trim()
    $env:LEDGER_COOKIE_SECURE = "0"

    # DBにユーザーが存在するかを確認し、初期管理者の作成要否を判断する。
    $hasUsers = "0"
    if (Test-Path -LiteralPath $databasePath -PathType Leaf) {
        $hasUsers = & $python -c "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); t=c.execute('SELECT 1 FROM sqlite_master WHERE type=? AND name=?', ('table','users')).fetchone(); print('1' if t and c.execute('SELECT 1 FROM users LIMIT 1').fetchone() else '0'); c.close()" $databasePath
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to check the user database."
        }
    }

    if ($hasUsers.Trim() -ne "1") {
        # パスワードを画面に表示せず入力し、ハッシュ化してアプリに渡す。
        $passwordHash = & $python -c "from getpass import getpass; from werkzeug.security import generate_password_hash; print(generate_password_hash(getpass('Initial administrator password: ')))"
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($passwordHash)) {
            throw "Failed to generate the initial administrator password hash. Check that requirements.txt is installed."
        }
        $env:LEDGER_USERNAME = $Username
        $env:LEDGER_PASSWORD_HASH = $passwordHash.Trim()
    } else {
        # 既存ユーザーがいる場合は初期管理者用の環境変数を取り除く。
        Remove-Item Env:LEDGER_USERNAME, Env:LEDGER_PASSWORD_HASH -ErrorAction SilentlyContinue
    }

    # バックエンドを起動し、異常終了した場合はエラーを表示する。
    & $python -m backend.app
    if ($LASTEXITCODE -ne 0) {
        throw "Server exited with code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}