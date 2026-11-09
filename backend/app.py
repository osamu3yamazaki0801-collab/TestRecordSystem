import hmac
import json
import os
import re
import secrets
import sqlite3
import unicodedata
from contextlib import closing
from datetime import date, timedelta
from functools import wraps
from io import BytesIO
from pathlib import Path

from flask import Flask, abort, jsonify, request, send_file, send_from_directory, session
from werkzeug.exceptions import RequestEntityTooLarge
from werkzeug.security import check_password_hash
from waitress import serve


# ファイル単体と1回の登録で送信できるファイル合計の上限は、それぞれ100MB。
# multipart/form-data の付加情報として、リクエスト全体には2MBの余裕を設ける。
MAX_FILE_SIZE = 100 * 1024 * 1024
MAX_TOTAL_FILE_SIZE = 100 * 1024 * 1024
MAX_REQUEST_SIZE = MAX_TOTAL_FILE_SIZE + 2 * 1024 * 1024
PROJECT_ROOT = Path(__file__).resolve().parent.parent


def empty_equipment():
    return {
        "boards": [
            {"name": name, "serialNumber": ""}
            for name in (
                "PWS132-A", "PWM89-G0", "PWM85-A3", "INF265-B0",
                "MDM91-D0", "INF271-B0", "INF267-A1",
            )
        ],
        "instruments": [
            {"name": "", "managementNo": "", "testItems": ""}
            for _ in range(3)
        ],
        "software": [
            {"name": name, "sdFormat": sd_format, "version": "", "checksum": ""}
            for name, sd_format in (
                ("テストプロ", "TEST0306"),
                ("PWM85 基板 FPGA", "XPLD0885"),
                ("INF267 基板 FPGA", "XPLD0856"),
            )
        ],
    }


# 日本語テキスト判定。
# 文字ごとに Unicode のカテゴリと文字種を確認して、ひらがな・カタカナ・漢字を判定する。
def is_japanese_text(value):
    for character in value:
        if character.isspace():
            continue
        category = unicodedata.category(character)
        unicode_name = unicodedata.name(character, "")
        if category[0] not in {"L", "M"} or not any(
            script in unicode_name for script in ("CJK", "HIRAGANA", "KATAKANA")
        ):
            return False
    return bool(value.strip())


# Flask アプリ本体を生成する。
# ここで必要な設定値 (SECRET_KEY, DB パス, セッション設定など) をまとめて持つ。
def create_app(test_config=None):
    app = Flask(__name__, static_folder=None)
    app.config.from_mapping(
        SECRET_KEY=os.environ.get("LEDGER_SECRET_KEY"),
        LEDGER_USERNAME=os.environ.get("LEDGER_USERNAME"),
        LEDGER_PASSWORD_HASH=os.environ.get("LEDGER_PASSWORD_HASH"),
        FRONTEND_DIST_PATH=os.environ.get(
            "LEDGER_FRONTEND_DIST_PATH",
            str(PROJECT_ROOT / "frontend" / "dist"),
        ),
        DATABASE_PATH=os.environ.get(
            "LEDGER_DATABASE_PATH",
            str(PROJECT_ROOT / "instance" / "trial-ledger.sqlite3"),
        ),
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        SESSION_COOKIE_SECURE=os.environ.get("LEDGER_COOKIE_SECURE", "1").lower()
        not in {"0", "false", "no"},
        PERMANENT_SESSION_LIFETIME=timedelta(hours=8),
        MAX_CONTENT_LENGTH=MAX_REQUEST_SIZE,
    )
    if test_config:
        app.config.update(test_config)

    # SQLite への接続を共通化する。
    # DB ファイルが存在しないときはフォルダを自動作成する。
    def connect_db():
        database_path = Path(app.config["DATABASE_PATH"])
        database_path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(database_path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 10000")
        return connection

    # アプリ起動時にテーブルがなければ作成する。
    # WAL モードを使うことで並列アクセス時の整合性を保ちやすくしている。
    def initialize_database():
        with closing(connect_db()) as connection, connection:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS records (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    trial_no TEXT NOT NULL,
                    project_name TEXT NOT NULL,
                    product_no TEXT NOT NULL,
                    registration_date TEXT NOT NULL,
                    manager TEXT NOT NULL,
                    file_name TEXT,
                    file_content_type TEXT,
                    file_data BLOB,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                CREATE TABLE IF NOT EXISTS record_files (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    record_id INTEGER NOT NULL REFERENCES records(id) ON DELETE CASCADE,
                    file_name TEXT NOT NULL,
                    file_content_type TEXT NOT NULL,
                    file_data BLOB NOT NULL
                );
                CREATE INDEX IF NOT EXISTS record_files_record_id_idx
                    ON record_files(record_id);
                CREATE INDEX IF NOT EXISTS records_trial_no_idx ON records(trial_no);
                CREATE INDEX IF NOT EXISTS records_product_no_idx ON records(product_no);
                CREATE INDEX IF NOT EXISTS records_registration_date_idx ON records(registration_date);
                CREATE INDEX IF NOT EXISTS records_manager_idx ON records(manager);
                CREATE TABLE IF NOT EXISTS jumper_checks (
                    record_id INTEGER NOT NULL REFERENCES records(id) ON DELETE CASCADE,
                    jumper_name TEXT NOT NULL CHECK (jumper_name IN ('W1', 'W2')),
                    confirmed INTEGER NOT NULL CHECK (confirmed IN (0, 1)),
                    PRIMARY KEY (record_id, jumper_name)
                );
                CREATE TABLE IF NOT EXISTS record_equipment (
                    record_id INTEGER PRIMARY KEY REFERENCES records(id) ON DELETE CASCADE,
                    payload TEXT NOT NULL
                );
                """
            )
            # 既存DBの単一添付ファイルを新しい複数ファイル用テーブルへ移す。
            connection.execute(
                """
                INSERT INTO record_files (
                    record_id, file_name, file_content_type, file_data
                )
                SELECT id, COALESCE(file_name, 'trial-result'),
                       COALESCE(file_content_type, 'application/octet-stream'),
                       file_data
                FROM records
                WHERE file_data IS NOT NULL
                """
            )
            connection.execute(
                """
                UPDATE records
                SET file_name = NULL, file_content_type = NULL, file_data = NULL
                WHERE file_data IS NOT NULL
                """
            )

    # POST / PUT / DELETE のような更新系 API では CSRF トークンを必須とする。
    def require_csrf(view):
        @wraps(view)
        def wrapped(*args, **kwargs):
            if request.method == "GET":
                return view(*args, **kwargs)
            token = request.headers.get("X-CSRF-Token", "")
            expected = session.get("csrf_token", "")
            if not expected or not hmac.compare_digest(token, expected):
                return jsonify(error="画面を再読み込みしてから、もう一度お試しください。"), 400
            return view(*args, **kwargs)

        return wrapped

    # ログイン必須の API に付けるデコレータ。
    def require_login(view):
        @wraps(view)
        def wrapped(*args, **kwargs):
            if not session.get("username"):
                return jsonify(error="ログインしてください。"), 401
            return view(*args, **kwargs)

        return wrapped

    # フォーム入力値を共通ルールで検証するヘルパー。
    def validate_text(value, max_length, pattern, message):
        if not isinstance(value, str):
            return message
        text = value.strip()
        if not text or len(text) > max_length:
            return message
        if not (pattern(text) if callable(pattern) else pattern.fullmatch(text)):
            return message
        return None

    def parse_record_submission(form, uploads):
        fields = {
            "trialNo": (
                20,
                re.compile(r"[A-Za-z0-9-]+"),
                "試験番号は半角英数字またはハイフンで20文字以内で入力してください。",
            ),
            "projectName": (
                30,
                re.compile(r"[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF0-9A-Za-z\s-]+"),
                "案件名は日本語または英数字で30文字以内で入力してください。",
            ),
            "productNo": (
                30,
                re.compile(r"[A-Za-z0-9 -]+"),
                "製番は30文字以内で、スペースを含む半角英数字を入力してください。",
            ),
            "manager": (
                30,
                is_japanese_text,
                "担当者は日本語で入力してください。",
            ),
        }
        values = {}
        for field, (max_length, pattern, message) in fields.items():
            value = form.get(field, "")
            if field in {"projectName", "productNo"} and not value.strip():
                values[field] = ""
                continue
            error = validate_text(value, max_length, pattern, message)
            if error:
                return None, None, None, (error, 400)
            values[field] = value.strip()

        registration_date = form.get("registrationDate", "").strip()
        try:
            if not re.fullmatch(r"\d{8}", registration_date):
                raise ValueError
            date(
                int(registration_date[:4]),
                int(registration_date[4:6]),
                int(registration_date[6:8]),
            )
        except ValueError:
            return (
                None,
                None,
                None,
                ("登録日は実在する日付をyyyymmdd形式で入力してください。", 400),
            )

        files = []
        total_file_size = 0
        for upload in uploads:
            if not upload or not upload.filename:
                continue
            file_data = upload.read(MAX_FILE_SIZE + 1)
            if len(file_data) > MAX_FILE_SIZE:
                return (
                    None,
                    None,
                    None,
                    ("添付ファイルは1件あたり100 MB以下にしてください。", 413),
                )
            total_file_size += len(file_data)
            if total_file_size > MAX_TOTAL_FILE_SIZE:
                return (
                    None,
                    None,
                    None,
                    ("添付ファイルの合計は100 MB以下にしてください。", 413),
                )
            file_name = upload.filename.replace("\\", "/").rsplit("/", 1)[-1]
            file_name = "".join(
                char for char in file_name if char.isprintable()
            ).strip()[:255]
            files.append(
                (
                    file_name or "trial-result",
                    upload.mimetype or "application/octet-stream",
                    file_data,
                )
            )

        return values, registration_date, files, None

    # 検索条件に使うワイルドカード検索用の正規表現を作成する。
    # 例: "T*001" -> "T.*001" に変換して部分一致検索を実現する。
    def matching_pattern(query):
        normalized = query.strip()
        return re.compile(
            "^" + ".*".join(re.escape(part) for part in normalized.split("*")),
            re.IGNORECASE,
        )

    # アップロード容量超過時にわかりやすいエラーを返す。
    @app.errorhandler(RequestEntityTooLarge)
    def request_too_large(_error):
        return jsonify(error="添付ファイルの合計が大きすぎます。1回の登録で100 MB以下にしてください。"), 413

    # React 画面を配信する。ビルド済みの index.html が存在する場合はそれを返す。
    @app.get("/")
    def index():
        frontend_dist = Path(app.config["FRONTEND_DIST_PATH"])
        if (frontend_dist / "index.html").is_file():
            return send_from_directory(frontend_dist, "index.html")
        return jsonify(
            error="React画面のビルドファイルがありません。npm run buildを実行してください。"
        ), 503

    @app.get("/<path:asset_path>")
    def frontend_asset(asset_path):
        return send_from_directory(app.config["FRONTEND_DIST_PATH"], asset_path)

    # 現在のログイン状態と CSRF トークンを返す。
    @app.get("/api/session")
    def get_session():
        if "csrf_token" not in session:
            session["csrf_token"] = secrets.token_urlsafe(32)
        return jsonify(
            authenticated=bool(session.get("username")),
            username=session.get("username"),
            csrfToken=session["csrf_token"],
        )

    # ログイン API。
    # 環境変数に設定されたユーザー名とパスワードハッシュを照合する。
    @app.post("/api/login")
    @require_csrf
    def login():
        data = request.get_json(silent=True) or {}
        if not isinstance(data, dict):
            return jsonify(error="ログイン情報の形式が正しくありません。"), 400
        username = data.get("username", "")
        password = data.get("password", "")
        configured_username = app.config.get("LEDGER_USERNAME") or ""
        password_hash = app.config.get("LEDGER_PASSWORD_HASH") or ""
        if (
            not isinstance(username, str)
            or not isinstance(password, str)
            or not configured_username
            or not password_hash
            or not hmac.compare_digest(username, configured_username)
            or not check_password_hash(password_hash, password)
        ):
            return jsonify(error="ユーザIDまたはパスワードが正しくありません。"), 401

        session.clear()
        session.permanent = True
        session["username"] = configured_username
        session["csrf_token"] = secrets.token_urlsafe(32)
        return jsonify(username=configured_username, csrfToken=session["csrf_token"])

    # ログアウト API。
    @app.post("/api/logout")
    @require_login
    @require_csrf
    def logout():
        session.clear()
        return jsonify(success=True)

    # ダッシュボード表示に必要な件数と最新記録を返す。
    @app.get("/api/dashboard")
    @require_login
    def dashboard():
        current_month = date.today().strftime("%Y%m")
        with closing(connect_db()) as connection:
            total_records = connection.execute(
                "SELECT COUNT(*) FROM records"
            ).fetchone()[0]
            month_records = connection.execute(
                "SELECT COUNT(*) FROM records WHERE substr(registration_date, 1, 6) = ?",
                (current_month,),
            ).fetchone()[0]
            row = connection.execute(
                """
                SELECT id, trial_no, project_name, product_no,
                       registration_date, manager,
                       (SELECT file_name FROM record_files
                        WHERE record_id = records.id ORDER BY id LIMIT 1) AS file_name
                FROM records
                ORDER BY id DESC
                LIMIT 1
                """
            ).fetchone()
        latest_record = (
            {
                "id": row["id"],
                "trialNo": row["trial_no"],
                "projectName": row["project_name"],
                "productNo": row["product_no"],
                "registrationDate": row["registration_date"],
                "manager": row["manager"],
                "fileName": row["file_name"],
            }
            if row
            else None
        )
        return jsonify(
            totalRecords=total_records,
            monthRecords=month_records,
            currentMonth=date.today().strftime("%Y年%m月"),
            latestRecord=latest_record,
        )

    # 記録の一覧取得と新規登録をまとめて扱う API。
    # GET は検索条件による一覧取得、POST は新規レコード登録。
    @app.route("/api/records", methods=["GET", "POST"])
    @require_csrf
    @require_login
    def records():
        if request.method == "GET":
            filters = {
                "trial_no": request.args.get("trialNo", ""),
                "product_no": request.args.get("productNo", ""),
                "registration_date": request.args.get("date", ""),
                "manager": request.args.get("manager", ""),
            }
            max_filter_lengths = {
                "trial_no": 20,
                "product_no": 30,
                "registration_date": 8,
                "manager": 30,
            }
            if any(
                len(value) > max_filter_lengths[key]
                for key, value in filters.items()
            ):
                return jsonify(error="検索条件が長すぎます。"), 400
            patterns = {
                key: matching_pattern(value)
                for key, value in filters.items()
                if value.strip()
            }
            with closing(connect_db()) as connection:
                rows = connection.execute(
                    """
                    SELECT id, trial_no, project_name, product_no,
                           registration_date, manager
                    FROM records
                    ORDER BY id DESC
                    """
                ).fetchall()
                file_rows = connection.execute(
                    """
                    SELECT id, record_id, file_name
                    FROM record_files
                    ORDER BY id
                    """
                ).fetchall()
            files_by_record = {}
            for file_row in file_rows:
                files_by_record.setdefault(file_row["record_id"], []).append(
                    {"id": file_row["id"], "fileName": file_row["file_name"]}
                )
            result = [
                {
                    "id": row["id"],
                    "trialNo": row["trial_no"],
                    "projectName": row["project_name"],
                    "productNo": row["product_no"],
                    "registrationDate": row["registration_date"],
                    "manager": row["manager"],
                    "files": files_by_record.get(row["id"], []),
                    "fileName": (
                        files_by_record[row["id"]][0]["fileName"]
                        if files_by_record.get(row["id"])
                        else None
                    ),
                }
                for row in rows
                if all(
                    pattern.match(row[key])
                    for key, pattern in patterns.items()
                )
            ]
            return jsonify(result)

        uploads = request.files.getlist("resultFiles") or request.files.getlist("resultFile")
        form = request.form.copy()
        form.setdefault("registrationDate", date.today().strftime("%Y%m%d"))
        values, registration_date, files, error = parse_record_submission(
            form,
            uploads,
        )
        if error:
            return jsonify(error=error[0]), error[1]

        with closing(connect_db()) as connection, connection:
            cursor = connection.execute(
                """
                INSERT INTO records (
                    trial_no, project_name, product_no, registration_date,
                    manager
                ) VALUES (?, ?, ?, ?, ?)
                """,
                (
                    values["trialNo"],
                    values["projectName"],
                    values["productNo"],
                    registration_date,
                    values["manager"],
                ),
            )
            record_id = cursor.lastrowid
            connection.executemany(
                """
                INSERT INTO record_files (
                    record_id, file_name, file_content_type, file_data
                ) VALUES (?, ?, ?, ?)
                """,
                [(record_id, file_name, content_type, file_data)
                 for file_name, content_type, file_data in files],
            )
        return jsonify(id=record_id), 201

    @app.get("/api/records/<int:record_id>/jumpers")
    @require_login
    def get_jumper_checks(record_id):
        with closing(connect_db()) as connection:
            if not connection.execute(
                "SELECT id FROM records WHERE id = ?", (record_id,)
            ).fetchone():
                abort(404)
            rows = connection.execute(
                "SELECT jumper_name, confirmed FROM jumper_checks WHERE record_id = ?",
                (record_id,),
            ).fetchall()
        confirmed = {row["jumper_name"]: bool(row["confirmed"]) for row in rows}
        return jsonify([
            {"name": name, "setting": "1-2", "confirmed": confirmed.get(name, False)}
            for name in ("W1", "W2")
        ])

    @app.put("/api/records/<int:record_id>/jumpers/<jumper_name>")
    @require_login
    @require_csrf
    def update_jumper_check(record_id, jumper_name):
        if jumper_name not in {"W1", "W2"}:
            abort(404)
        data = request.get_json(silent=True)
        if not isinstance(data, dict) or not isinstance(data.get("confirmed"), bool):
            return jsonify(error="確認結果はtrueまたはfalseで指定してください。"), 400
        with closing(connect_db()) as connection, connection:
            if not connection.execute(
                "SELECT id FROM records WHERE id = ?", (record_id,)
            ).fetchone():
                abort(404)
            connection.execute(
                """
                INSERT INTO jumper_checks (record_id, jumper_name, confirmed)
                VALUES (?, ?, ?)
                ON CONFLICT(record_id, jumper_name)
                DO UPDATE SET confirmed = excluded.confirmed
                """,
                (record_id, jumper_name, int(data["confirmed"])),
            )
        return jsonify(name=jumper_name, setting="1-2", confirmed=data["confirmed"])

    @app.route("/api/records/<int:record_id>/equipment", methods=["GET", "PUT"])
    @require_login
    @require_csrf
    def record_equipment(record_id):
        data = None
        if request.method == "PUT":
            data = request.get_json(silent=True)
            template = empty_equipment()
            if not isinstance(data, dict) or data.keys() != template.keys():
                return jsonify(error="機器情報の形式が正しくありません。"), 400
            fixed_fields = {"boards": {"name"}, "instruments": set(), "software": {"name", "sdFormat"}}
            for group, expected_rows in template.items():
                rows = data[group]
                if not isinstance(rows, list) or len(rows) != len(expected_rows):
                    return jsonify(error="機器情報の行数が正しくありません。"), 400
                for row, expected in zip(rows, expected_rows):
                    if not isinstance(row, dict) or row.keys() != expected.keys():
                        return jsonify(error="機器情報の項目が正しくありません。"), 400
                    if any(not isinstance(value, str) or len(value) > 100 for value in row.values()):
                        return jsonify(error="各項目は100文字以内の文字列で入力してください。"), 400
                    if any(row[field] != expected[field] for field in fixed_fields[group]):
                        return jsonify(error="基板名・ソフト名・SD形式は変更できません。"), 400

        with closing(connect_db()) as connection, connection:
            if not connection.execute(
                "SELECT id FROM records WHERE id = ?", (record_id,)
            ).fetchone():
                abort(404)
            if request.method == "PUT":
                connection.execute(
                    """
                    INSERT INTO record_equipment (record_id, payload) VALUES (?, ?)
                    ON CONFLICT(record_id) DO UPDATE SET payload = excluded.payload
                    """,
                    (record_id, json.dumps(data)),
                )
                return jsonify(data)
            row = connection.execute(
                "SELECT payload FROM record_equipment WHERE record_id = ?", (record_id,)
            ).fetchone()
        return jsonify(json.loads(row["payload"]) if row else empty_equipment())

    @app.put("/api/records/<int:record_id>")
    @require_login
    @require_csrf
    def update_record(record_id):
        uploads = request.files.getlist("resultFiles") or request.files.getlist("resultFile")
        values, registration_date, files, error = parse_record_submission(
            request.form,
            uploads,
        )
        if error:
            return jsonify(error=error[0]), error[1]

        raw_remove_ids = request.form.getlist("removeFileIds")
        try:
            remove_file_ids = [int(file_id) for file_id in raw_remove_ids]
        except ValueError:
            return jsonify(error="削除する添付ファイルの指定が正しくありません。"), 400
        if (
            any(file_id <= 0 for file_id in remove_file_ids)
            or len(set(remove_file_ids)) != len(remove_file_ids)
        ):
            return jsonify(error="削除する添付ファイルの指定が正しくありません。"), 400

        with closing(connect_db()) as connection, connection:
            record = connection.execute(
                "SELECT id FROM records WHERE id = ?",
                (record_id,),
            ).fetchone()
            if not record:
                abort(404)

            if remove_file_ids:
                existing_file_ids = {
                    row["id"]
                    for row in connection.execute(
                        "SELECT id FROM record_files WHERE record_id = ?",
                        (record_id,),
                    ).fetchall()
                }
                if not set(remove_file_ids).issubset(existing_file_ids):
                    return jsonify(error="削除対象の添付ファイルが見つかりません。"), 400

            connection.execute(
                """
                UPDATE records
                SET trial_no = ?, project_name = ?, product_no = ?,
                    registration_date = ?, manager = ?
                WHERE id = ?
                """,
                (
                    values["trialNo"],
                    values["projectName"],
                    values["productNo"],
                    registration_date,
                    values["manager"],
                    record_id,
                ),
            )
            connection.executemany(
                "DELETE FROM record_files WHERE record_id = ? AND id = ?",
                [(record_id, file_id) for file_id in remove_file_ids],
            )
            connection.executemany(
                """
                INSERT INTO record_files (
                    record_id, file_name, file_content_type, file_data
                ) VALUES (?, ?, ?, ?)
                """,
                [(record_id, file_name, content_type, file_data)
                 for file_name, content_type, file_data in files],
            )
        return jsonify(success=True)

    # 記録を削除する。添付ファイルは外部キーの CASCADE により同時に削除される。
    @app.delete("/api/records/<int:record_id>")
    @require_login
    @require_csrf
    def delete_record(record_id):
        with closing(connect_db()) as connection, connection:
            cursor = connection.execute(
                "DELETE FROM records WHERE id = ?",
                (record_id,),
            )
            if cursor.rowcount == 0:
                abort(404)
        return jsonify(success=True)

    # 登録済み添付ファイルのダウンロード処理。
    @app.get("/api/records/<int:record_id>/files/<int:file_id>")
    @require_login
    def download_file(record_id, file_id):
        with closing(connect_db()) as connection:
            row = connection.execute(
                """
                SELECT file_name, file_content_type, file_data
                FROM record_files
                WHERE record_id = ? AND id = ?
                """,
                (record_id, file_id),
            ).fetchone()
        if not row:
            abort(404)
        return send_file(
            BytesIO(row["file_data"]),
            as_attachment=True,
            download_name=row["file_name"] or "trial-result",
            mimetype=row["file_content_type"] or "application/octet-stream",
            max_age=0,
        )

    # 既存クライアント向けに、レコードの最初の添付ファイルを返す旧URLも残す。
    @app.get("/api/records/<int:record_id>/file")
    @require_login
    def download_first_file(record_id):
        with closing(connect_db()) as connection:
            row = connection.execute(
                """
                SELECT id FROM record_files
                WHERE record_id = ?
                ORDER BY id
                LIMIT 1
                """,
                (record_id,),
            ).fetchone()
        if not row:
            abort(404)
        return download_file(record_id, row["id"])

    # 予期しない例外発生時は、ユーザー向けに分かりやすいメッセージを返す。
    @app.errorhandler(500)
    def internal_error(_error):
        app.logger.error("Unhandled application error: %s", _error)
        return jsonify(error="サーバーで処理に失敗しました。時間をおいて再度お試しください。"), 500

    initialize_database()
    return app


# サーバー起動時の事前チェック。
# 必須の環境変数がない、またはパスワードハッシュが不正なら起動しない。
def main():
    required = ("LEDGER_SECRET_KEY", "LEDGER_USERNAME", "LEDGER_PASSWORD_HASH")
    missing = [name for name in required if not os.environ.get(name)]
    if missing:
        raise SystemExit("必須の環境変数が設定されていません: " + ", ".join(missing))
    if len(os.environ["LEDGER_SECRET_KEY"]) < 32:
        raise SystemExit("LEDGER_SECRET_KEYは32文字以上のランダムな値を設定してください。")
    try:
        check_password_hash(os.environ["LEDGER_PASSWORD_HASH"], "startup-validation")
    except (TypeError, ValueError):
        raise SystemExit("LEDGER_PASSWORD_HASHが無効です。READMEの手順で生成してください。") from None
    app = create_app()
    host = os.environ.get("LEDGER_HOST", "127.0.0.1")
    port = int(os.environ.get("LEDGER_PORT", "8000"))
    serve(app, host=host, port=port)


if __name__ == "__main__":
    main()
