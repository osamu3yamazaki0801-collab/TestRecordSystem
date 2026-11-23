param(
    [string]$Username = "toshiba"
)

$ErrorActionPreference = "Stop"
$python = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"

if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
    throw "Virtual environment not found. Run 'py -m venv .venv' and install requirements.txt first."
}

Push-Location $PSScriptRoot
try {
    $secretKey = & $python -c "import secrets; print(secrets.token_urlsafe(48))"
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($secretKey)) {
        throw "Failed to generate the secret key."
    }

    $databasePath = if ($env:LEDGER_DATABASE_PATH) {
        $env:LEDGER_DATABASE_PATH
    } else {
        Join-Path $PSScriptRoot "instance\trial-ledger.sqlite3"
    }

    $env:LEDGER_SECRET_KEY = $secretKey.Trim()
    $env:LEDGER_COOKIE_SECURE = "0"

    $hasUsers = "0"
    if (Test-Path -LiteralPath $databasePath -PathType Leaf) {
        $hasUsers = & $python -c "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); t=c.execute('SELECT 1 FROM sqlite_master WHERE type=? AND name=?', ('table','users')).fetchone(); print('1' if t and c.execute('SELECT 1 FROM users LIMIT 1').fetchone() else '0'); c.close()" $databasePath
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to check the user database."
        }
    }

    if ($hasUsers.Trim() -ne "1") {
        $passwordHash = & $python -c "from getpass import getpass; from werkzeug.security import generate_password_hash; print(generate_password_hash(getpass('Initial administrator password: ')))"
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($passwordHash)) {
            throw "Failed to generate the initial administrator password hash. Check that requirements.txt is installed."
        }
        $env:LEDGER_USERNAME = $Username
        $env:LEDGER_PASSWORD_HASH = $passwordHash.Trim()
    } else {
        Remove-Item Env:LEDGER_USERNAME, Env:LEDGER_PASSWORD_HASH -ErrorAction SilentlyContinue
    }

    & $python -m backend.app
    if ($LASTEXITCODE -ne 0) {
        throw "Server exited with code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}