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

    $passwordHash = & $python -c "from getpass import getpass; from werkzeug.security import generate_password_hash; print(generate_password_hash(getpass()))"
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($passwordHash)) {
        throw "Failed to generate the password hash. Check that requirements.txt is installed."
    }

    $env:LEDGER_SECRET_KEY = $secretKey.Trim()
    $env:LEDGER_USERNAME = $Username
    $env:LEDGER_PASSWORD_HASH = $passwordHash.Trim()
    $env:LEDGER_COOKIE_SECURE = "0"

    & $python -m backend.app
    if ($LASTEXITCODE -ne 0) {
        throw "Server exited with code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}