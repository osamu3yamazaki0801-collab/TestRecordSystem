import hmac
import json
import math
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

from flask import Flask, abort, g, jsonify, request, send_file, send_from_directory, session
from werkzeug.exceptions import RequestEntityTooLarge
from werkzeug.security import check_password_hash, generate_password_hash
from waitress import serve
from backend.trial_results import parse_trial_results_file
from backend.graph_mail import send_workflow_advancement_email


# ファイル単体と1回の登録で送信できるファイル合計の上限は、それぞれ100MB。
# multipart/form-data の付加情報として、リクエスト全体には2MBの余裕を設ける。
MAX_FILE_SIZE = 100 * 1024 * 1024
MAX_TOTAL_FILE_SIZE = 100 * 1024 * 1024
MAX_REQUEST_SIZE = MAX_TOTAL_FILE_SIZE + 2 * 1024 * 1024
DEFAULT_INSTRUMENT_ROWS = 5
MAX_INSTRUMENT_ROWS = 50
MAX_INSTRUMENT_CHOICES = 50
MAX_MANAGER_CHOICES = 100
MAX_JUMPERS = 50
MAX_MANUAL_TESTS = 50
MAX_MANUAL_TEST_ITEMS = 200
MAX_SOFTWARE_SECTIONS = 20
MAX_SOFTWARE_ROWS = 50
DEFAULT_BOARD_DEFAULTS = [
    {"name": name, "serialNumber": ""}
    for name in (
        "PWS132-A", "PWM89-G0", "PWM85-A3", "INF265-B0",
        "MDM91-D0", "INF271-B0", "INF267-A1",
    )
]
DEFAULT_JUMPERS = [
    {"name": "W1", "setting": "1-2"},
    {"name": "W2", "setting": "1-2"},
]
DEFAULT_INSTRUMENT_CHOICES = [
    {"name": "自動試験器", "managementNo": "鉄シブ#1"},
    {"name": "デジタルマルチメーター", "managementNo": "AA123456"},
]
DEFAULT_APPEARANCE_BOARD_GROUPS = [
    {"name": "PWS132", "boards": ["PWS132"]},
    {"name": "PWM89", "boards": ["PWM85", "INF265", "MDM57", "INF271"]},
    {"name": "INF267", "boards": ["INF267"]},
]
DEFAULT_APPEARANCE_ITEMS = [
    {
        "key": "boardRevision", "name": "基板レビジョン", "rows": 2,
        "values": {
            "PWS132": "A", "PWM85": "A4", "INF265": "B0",
            "MDM57": "A2", "INF271": "D0", "INF267": "B0",
        },
    },
    {
        "key": "frontPanel", "name": "フロントパネルの銘板", "rows": 2,
        "values": {"PWS132": "PWS", "PWM85": "PWM-1", "INF267": "INF-1"},
    },
    {
        "key": "boardFit", "name": "組合せ基板の勘合", "rows": 1,
        "values": {"INF265": "", "MDM57": "", "INF271": ""},
    },
    {
        "key": "screws", "name": "ネジの締付けの確認", "rows": 1,
        "values": {"PWS132": "", "PWM85": "", "INF265": "", "MDM57": "", "INF271": ""},
    },
    {"key": "sdCard", "name": "SDカード実装", "rows": 1, "values": {"PWM85": ""}},
    {"key": "dustCap", "name": "MDM57防塵キャップ実装確認", "rows": 1, "values": {"MDM57": ""}},
]
DEFAULT_APPEARANCE_INSPECTION = {
    "boardGroups": DEFAULT_APPEARANCE_BOARD_GROUPS,
    "items": DEFAULT_APPEARANCE_ITEMS,
}
DEFAULT_MANUAL_TESTS = []
DEFAULT_SOFTWARE_SECTIONS = [
    {
        "key": "software-install",
        "title": "インストールソフト",
        "rows": [{"name": "テストプロ", "sdFormat": "TEST0306"}],
    },
    {
        "key": "pld-version",
        "title": "PLDバージョン",
        "rows": [
            {"name": "PWM85 基板 FPGA", "sdFormat": "XPLD0885"},
            {"name": "INF267 基板 FPGA", "sdFormat": "XPLD0856"},
        ],
    },
]
BACKBOARD_INSERTION_KEY_CONNECTORS = [
    {"name": "P31", "displayName": "P31", "positions": ["E", "F", "G", "M"]},
    {"name": "P32", "displayName": "P32", "positions": ["E", "F", "H", "L"]},
    {"name": "P34", "displayName": "P34", "positions": ["E", "F", "L", "M"]},
    {"name": "P33", "displayName": "PS3", "positions": ["E", "H", "K", "L"]},
]
BOARD_INSERTION_KEY_POSITIONS = ("E", "F", "G", "H", "I", "K", "L", "M")
INSERTION_KEY_CONNECTORS = BACKBOARD_INSERTION_KEY_CONNECTORS + [
    {
        "name": f"board:{connector['displayName']}",
        "displayName": board_name,
        "side": "board",
        "positions": [
            position for position in BOARD_INSERTION_KEY_POSITIONS
            if position not in connector["positions"]
        ],
    }
    for connector, board_name in zip(
        BACKBOARD_INSERTION_KEY_CONNECTORS, ("INF265", "PWM85", "INF267", "PWS132")
    )
]
PROJECT_ROOT = Path(__file__).resolve().parent.parent


def appearance_check_settings(items):
    return {
        f"{item['key']}:{board}": json.dumps([item["name"], value], ensure_ascii=False)
        for item in items for board, value in item["values"].items()
    }


def validate_appearance_inspection(appearance):
    def valid_name(value):
        return isinstance(value, str) and 0 < len(value) <= 100 and value == value.strip()

    if not isinstance(appearance, dict) or appearance.keys() != {"boardGroups", "items"}:
        raise ValueError("appearanceInspectionにはboardGroupsとitemsを設定してください。")
    groups = appearance["boardGroups"]
    if not isinstance(groups, list) or not 1 <= len(groups) <= 50:
        raise ValueError("appearanceInspection.boardGroupsは1～50件の配列にしてください。")
    group_names = set()
    board_names = set()
    for group in groups:
        if (
            not isinstance(group, dict)
            or group.keys() != {"name", "boards"}
            or not valid_name(group["name"])
            or group["name"] in group_names
            or not isinstance(group["boards"], list)
            or not 1 <= len(group["boards"]) <= 50
        ):
            raise ValueError("appearanceInspection.boardGroupsには一意なnameとboards配列を設定してください。")
        group_names.add(group["name"])
        for board in group["boards"]:
            if not valid_name(board) or board in board_names:
                raise ValueError("appearanceInspectionの基板名は重複しない100文字以内の文字列にしてください。")
            board_names.add(board)
    if len(board_names) > 50:
        raise ValueError("appearanceInspectionの基板列は合計50件以内にしてください。")
    items = appearance["items"]
    if not isinstance(items, list) or len(items) > 50:
        raise ValueError("appearanceInspection.itemsは50件以内の配列にしてください。")
    item_keys = set()
    for item in items:
        if (
            not isinstance(item, dict)
            or item.keys() != {"key", "name", "rows", "values"}
            or not isinstance(item["key"], str)
            or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{0,49}", item["key"])
            or item["key"] in item_keys
            or not valid_name(item["name"])
            or type(item["rows"]) is not int
            or item["rows"] not in (1, 2)
            or not isinstance(item["values"], dict)
            or not item["values"].keys() <= board_names
            or any(not isinstance(value, str) or len(value) > 100 for value in item["values"].values())
        ):
            raise ValueError(
                "appearanceInspection.itemsには一意なkey（英字で始まる半角英数字・_-の50文字以内）、"
                "name（100文字以内）、rows（1または2）、values（設定済み基板名と100文字以内の文字列）を設定してください。"
            )
        item_keys.add(item["key"])


def validate_manual_tests(tests):
    def numeric_limit(value):
        if isinstance(value, bool):
            return None
        if isinstance(value, (int, float)):
            return float(value)
        if isinstance(value, str) and re.fullmatch(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)", value):
            return float(value)
        return None

    if not isinstance(tests, list) or len(tests) > MAX_MANUAL_TESTS:
        raise ValueError(
            f"manualTestsは{MAX_MANUAL_TESTS}件以内の配列にしてください。"
        )
    test_keys = set()
    item_keys = set()
    item_count = 0
    allowed_keys = {"key", "number", "name", "area", "items"}
    item_allowed_keys = {
        "key", "name", "lowerLimit", "upperLimit", "unit", "benchLock",
    }
    for test in tests:
        if (
            not isinstance(test, dict)
            or set(test) != allowed_keys
            or not isinstance(test["key"], str)
            or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{0,49}", test["key"])
            or test["key"] in test_keys
            or not isinstance(test["number"], str)
            or not 0 < len(test["number"]) <= 20
            or not isinstance(test["name"], str)
            or not 0 < len(test["name"]) <= 100
            or test["name"] != test["name"].strip()
            or not isinstance(test["area"], str)
            or not 0 < len(test["area"]) <= 100
            or test["area"] != test["area"].strip()
            or not isinstance(test["items"], list)
            or not test["items"]
        ):
            raise ValueError(
                "manualTestsには一意なkey、number、name、areaと測定項目itemsを設定してください。"
            )
        test_keys.add(test["key"])
        item_count += len(test["items"])
        if item_count > MAX_MANUAL_TEST_ITEMS:
            raise ValueError(
                f"manualTestsの測定項目は合計{MAX_MANUAL_TEST_ITEMS}件以内にしてください。"
            )
        for item in test["items"]:
            lower_limit = (
                numeric_limit(item.get("lowerLimit"))
                if isinstance(item, dict) else None
            )
            upper_limit = (
                numeric_limit(item.get("upperLimit"))
                if isinstance(item, dict) else None
            )
            if (
                not isinstance(item, dict)
                or set(item) != item_allowed_keys
                or not isinstance(item["key"], str)
                or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{0,49}", item["key"])
                or item["key"] in item_keys
                or not isinstance(item["name"], str)
                or len(item["name"]) > 100
                or item["name"] != item["name"].strip()
                or lower_limit is None
                or upper_limit is None
                or not math.isfinite(lower_limit)
                or not math.isfinite(upper_limit)
                or lower_limit > upper_limit
                or not isinstance(item["unit"], str)
                or len(item["unit"]) > 20
                or type(item["benchLock"]) is not bool
            ):
                raise ValueError(
                    "manualTests.itemsには一意なkey、name、lowerLimit、upperLimit、"
                    "unit、benchLockを設定してください。"
                )
            item_keys.add(item["key"])


def validate_software_sections(sections):
    if not isinstance(sections, list) or len(sections) > MAX_SOFTWARE_SECTIONS:
        raise ValueError(
            f"softwareSectionsは{MAX_SOFTWARE_SECTIONS}件以内の配列にしてください。"
        )
    keys = set()
    software_rows = set()
    row_count = 0
    for section in sections:
        if (
            not isinstance(section, dict)
            or section.keys() != {"key", "title", "rows"}
            or not isinstance(section["key"], str)
            or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{0,49}", section["key"])
            or section["key"] in keys
            or not isinstance(section["title"], str)
            or not 0 < len(section["title"]) <= 100
            or section["title"] != section["title"].strip()
            or not isinstance(section["rows"], list)
        ):
            raise ValueError(
                "softwareSectionsには一意なkey、title、rowsを設定してください。"
            )
        keys.add(section["key"])
        row_count += len(section["rows"])
        if row_count > MAX_SOFTWARE_ROWS:
            raise ValueError(
                f"softwareSectionsの行は合計{MAX_SOFTWARE_ROWS}件以内にしてください。"
            )
        for row in section["rows"]:
            if (
                not isinstance(row, dict)
                or row.keys() != {"name", "sdFormat"}
                or not isinstance(row["name"], str)
                or not 0 < len(row["name"]) <= 100
                or row["name"] != row["name"].strip()
                or not isinstance(row["sdFormat"], str)
                or not 0 < len(row["sdFormat"]) <= 100
                or row["sdFormat"] != row["sdFormat"].strip()
            ):
                raise ValueError(
                    "softwareSections.rowsにはnameとsdFormatを100文字以内で設定してください。"
                )
            row_identity = (row["name"], row["sdFormat"])
            if row_identity in software_rows:
                raise ValueError(
                    "softwareSections.rowsのnameとsdFormatの組み合わせは重複できません。"
                )
            software_rows.add(row_identity)


def load_equipment_config(config_path):
    try:
        with Path(config_path).open(encoding="utf-8") as config_file:
            config = json.load(config_file)
    except FileNotFoundError:
        config = {}
    except json.JSONDecodeError as error:
        raise ValueError(f"計測器設定JSONを読み込めません: {config_path}") from error

    if not isinstance(config, dict):
        raise ValueError("機器設定JSONのルートはオブジェクトにしてください。")
    configured_managers = config.get("managerChoices", [])
    manager_choices = []
    if not isinstance(configured_managers, list) or len(configured_managers) > MAX_MANAGER_CHOICES:
        raise ValueError(
            f"計測器設定JSONのmanagerChoicesは{MAX_MANAGER_CHOICES}件以内の配列にしてください。"
        )
    manager_names = set()
    for manager in configured_managers:
        if isinstance(manager, str):
            manager_name = manager
        elif isinstance(manager, dict) and set(manager) in ({"name"}, {"name", "email"}):
            manager_name = manager["name"]
        else:
            raise ValueError(
                "managerChoicesには担当者名の文字列、またはnameを持つオブジェクトを指定してください。"
            )
        if (
            not isinstance(manager_name, str)
            or len(manager_name) > 30
            or manager_name != manager_name.strip()
            or not is_japanese_text(manager_name)
            or manager_name in manager_names
        ):
            raise ValueError(
                "managerChoicesには重複しない日本語の担当者名（30文字以内）を指定してください。"
            )
        manager_names.add(manager_name)
        manager_choices.append(manager_name)
    choices = config.get("instrumentChoices", DEFAULT_INSTRUMENT_CHOICES)
    if not isinstance(choices, list) or len(choices) > MAX_INSTRUMENT_CHOICES:
        raise ValueError(
            f"計測器設定JSONのinstrumentChoicesは{MAX_INSTRUMENT_CHOICES}件以内の配列にしてください。"
        )
    names = set()
    for choice in choices:
        if (
            not isinstance(choice, dict)
            or choice.keys() != {"name", "managementNo"}
            or not isinstance(choice["name"], str)
            or not choice["name"].strip()
            or len(choice["name"]) > 100
            or not isinstance(choice["managementNo"], str)
            or len(choice["managementNo"]) > 100
            or choice["name"] in names
        ):
            raise ValueError(
                "各instrumentChoices項目には一意なnameとmanagementNoを指定してください（各100文字以内）。"
            )
        names.add(choice["name"])
    boards = config.get("boards", DEFAULT_BOARD_DEFAULTS)
    if not isinstance(boards, list) or len(boards) > 50:
        raise ValueError("機器設定JSONのboardsは50件以内の配列にしてください。")
    board_names = set()
    for board in boards:
        if (
            not isinstance(board, dict)
            or board.keys() != {"name", "serialNumber"}
            or not isinstance(board["name"], str)
            or not board["name"].strip()
            or len(board["name"]) > 100
            or board["name"] in board_names
            or not isinstance(board["serialNumber"], str)
            or len(board["serialNumber"]) > 100
        ):
            raise ValueError(
                "各boards項目には一意なnameとserialNumberを設定してください（各100文字以内）。"
            )
        board_names.add(board["name"])
    jumpers = config.get("jumpers", DEFAULT_JUMPERS)
    if not isinstance(jumpers, list) or len(jumpers) > MAX_JUMPERS:
        raise ValueError(f"計測器設定JSONのjumpersは{MAX_JUMPERS}件以内の配列にしてください。")
    jumper_names = set()
    for jumper in jumpers:
        if (
            not isinstance(jumper, dict)
            or jumper.keys() != {"name", "setting"}
            or not isinstance(jumper["name"], str)
            or not jumper["name"].strip()
            or jumper["name"] != jumper["name"].strip()
            or len(jumper["name"]) > 100
            or jumper["name"] in jumper_names
            or not isinstance(jumper["setting"], str)
            or not jumper["setting"].strip()
            or jumper["setting"] != jumper["setting"].strip()
            or len(jumper["setting"]) > 100
        ):
            raise ValueError(
                f"jumpersには重複しないnameとsettingを指定してください（各100文字以内、最大{MAX_JUMPERS}件）。"
            )
        jumper_names.add(jumper["name"])
    appearance = config.get("appearanceInspection", DEFAULT_APPEARANCE_INSPECTION)
    validate_appearance_inspection(appearance)
    manual_tests = config.get("manualTests", DEFAULT_MANUAL_TESTS)
    validate_manual_tests(manual_tests)
    software_sections = config.get("softwareSections", DEFAULT_SOFTWARE_SECTIONS)
    validate_software_sections(software_sections)
    return {
        "managerChoices": manager_choices,
        "instrumentChoices": choices,
        "boards": boards,
        "jumpers": jumpers,
        "appearanceInspection": appearance,
        "manualTests": manual_tests,
        "softwareSections": software_sections,
    }


def empty_equipment(
    board_defaults=DEFAULT_BOARD_DEFAULTS,
    software_sections=DEFAULT_SOFTWARE_SECTIONS,
):
    return {
        "boards": [dict(board) for board in board_defaults],
        "instruments": [
            {"name": "", "managementNo": "", "testItems": ""}
            for _ in range(DEFAULT_INSTRUMENT_ROWS)
        ],
        "software": [
            {
                "name": row["name"],
                "sdFormat": row["sdFormat"],
                "version": "",
                "checksum": "",
            }
            for section in software_sections
            for row in section["rows"]
        ],
        "shippingSoftware": [{"name": "", "sdFormat": "", "version": "", "checksum": ""}],
        "shippingSoftwareSameAsTrial": False,
    }


def validate_equipment(
    data,
    board_defaults=DEFAULT_BOARD_DEFAULTS,
    software_sections=DEFAULT_SOFTWARE_SECTIONS,
):
    template = empty_equipment(board_defaults, software_sections)
    if not isinstance(data, dict) or data.keys() != template.keys():
        return "機器情報の形式が正しくありません。"
    fixed_fields = {
        "boards": {"name"}, "instruments": set(),
        "software": {"name", "sdFormat"}, "shippingSoftware": set(),
    }
    for group, expected_rows in template.items():
        if group == "shippingSoftwareSameAsTrial":
            if not isinstance(data[group], bool):
                return "「試験時と同じソフト」はチェック状態で指定してください。"
            continue
        rows = data[group]
        if group == "boards":
            if not isinstance(rows, list) or len(rows) != len(expected_rows):
                return "基板情報の行数が設定と一致しません。"
        elif group == "instruments":
            if not isinstance(rows, list) or not 1 <= len(rows) <= MAX_INSTRUMENT_ROWS:
                return "機器情報の行数が正しくありません。"
        elif not isinstance(rows, list) or len(rows) != len(expected_rows):
            return "機器情報の行数が正しくありません。"
        for index, row in enumerate(rows):
            expected = expected_rows[0] if group == "instruments" else expected_rows[index]
            if not isinstance(row, dict) or row.keys() != expected.keys():
                return "機器情報の項目が正しくありません。"
            if any(not isinstance(value, str) or len(value) > 100 for value in row.values()):
                return "各項目は100文字以内の文字列で入力してください。"
            if any(row[field] != expected[field] for field in fixed_fields[group]):
                return "基板名・ソフト名・SD形式は変更できません。"
    return None


def normalize_equipment(
    data,
    board_defaults=DEFAULT_BOARD_DEFAULTS,
    software_sections=DEFAULT_SOFTWARE_SECTIONS,
):
    instruments = list(data["instruments"])
    last_filled_row = max(
        (index + 1 for index, row in enumerate(instruments) if any(row.values())),
        default=0,
    )
    row_count = max(DEFAULT_INSTRUMENT_ROWS, last_filled_row)
    normalized = {
        "boards": [
            {
                "serialNumber": (
                    data["boards"][index].get("serialNumber", default["serialNumber"])
                    if index < len(data["boards"]) else default["serialNumber"]
                ),
                "name": default["name"],
            }
            for index, default in enumerate(board_defaults)
        ],
        "instruments": instruments[:row_count],
        "shippingSoftwareSameAsTrial": data.get("shippingSoftwareSameAsTrial", False),
    }
    template = empty_equipment(board_defaults, software_sections)
    saved_software = {
        (row.get("name"), row.get("sdFormat")): row
        for row in data.get("software", [])
        if isinstance(row, dict)
    }
    normalized["software"] = [
        {
            **default,
            "version": saved_software.get(
                (default["name"], default["sdFormat"]), {}
            ).get("version", ""),
            "checksum": saved_software.get(
                (default["name"], default["sdFormat"]), {}
            ).get("checksum", ""),
        }
        for default in template["software"]
    ]
    saved_shipping = data["shippingSoftware"][0] if data.get("shippingSoftware") else {}
    normalized["shippingSoftware"] = [{
        field: saved_shipping.get(field, default)
        for field, default in template["shippingSoftware"][0].items()
    }]
    normalized["instruments"].extend(
        {"name": "", "managementNo": "", "testItems": ""}
        for _ in range(row_count - len(normalized["instruments"]))
    )
    return normalized


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
        EQUIPMENT_CONFIG_PATH=os.environ.get(
            "LEDGER_EQUIPMENT_CONFIG_PATH",
            str(PROJECT_ROOT / "equipment-config.json"),
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
    equipment_config = load_equipment_config(
        app.config["EQUIPMENT_CONFIG_PATH"]
    )
    app.config["INSTRUMENT_CHOICES"] = equipment_config["instrumentChoices"]
    app.config["MANAGER_CHOICES"] = equipment_config["managerChoices"]
    app.config["BOARD_DEFAULTS"] = equipment_config["boards"]
    app.config["JUMPERS"] = equipment_config["jumpers"]
    app.config["APPEARANCE_INSPECTION"] = equipment_config["appearanceInspection"]
    app.config["MANUAL_TESTS"] = equipment_config["manualTests"]
    app.config["SOFTWARE_SECTIONS"] = equipment_config["softwareSections"]
    appearance_settings = appearance_check_settings(equipment_config["appearanceInspection"]["items"])

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
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
                    manager_name TEXT COLLATE NOCASE UNIQUE,
                    password_hash TEXT NOT NULL,
                    role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
                    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                CREATE TABLE IF NOT EXISTS trial_number_reservations (
                    trial_no TEXT PRIMARY KEY,
                    reserved_by TEXT NOT NULL,
                    reserved_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                CREATE TABLE IF NOT EXISTS record_files (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    record_id INTEGER NOT NULL REFERENCES records(id) ON DELETE CASCADE,
                    file_name TEXT NOT NULL,
                    file_content_type TEXT NOT NULL,
                    file_data BLOB NOT NULL
                );
                CREATE TABLE IF NOT EXISTS power_board_reports (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    record_id INTEGER NOT NULL UNIQUE REFERENCES records(id) ON DELETE CASCADE,
                    file_name TEXT NOT NULL,
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
                    jumper_name TEXT NOT NULL,
                    setting TEXT NOT NULL,
                    confirmed INTEGER NOT NULL CHECK (confirmed IN (0, 1)),
                    PRIMARY KEY (record_id, jumper_name)
                );
                CREATE TABLE IF NOT EXISTS record_equipment (
                    record_id INTEGER PRIMARY KEY REFERENCES records(id) ON DELETE CASCADE,
                    payload TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS appearance_checks (
                    record_id INTEGER NOT NULL REFERENCES records(id) ON DELETE CASCADE,
                    check_key TEXT NOT NULL,
                    setting TEXT NOT NULL,
                    confirmed INTEGER NOT NULL CHECK (confirmed IN (0, 1)),
                    PRIMARY KEY (record_id, check_key)
                );
                CREATE TABLE IF NOT EXISTS insertion_key_checks (
                    record_id INTEGER NOT NULL REFERENCES records(id) ON DELETE CASCADE,
                    connector_name TEXT NOT NULL,
                    positions TEXT NOT NULL,
                    confirmed INTEGER NOT NULL CHECK (confirmed IN (0, 1)),
                    PRIMARY KEY (record_id, connector_name)
                );
                CREATE TABLE IF NOT EXISTS manual_test_results (
                    record_id INTEGER NOT NULL REFERENCES records(id) ON DELETE CASCADE,
                    item_key TEXT NOT NULL,
                    setting TEXT NOT NULL,
                    measured_value TEXT NOT NULL,
                    bench_lock INTEGER NOT NULL CHECK (bench_lock IN (0, 1)),
                    PRIMARY KEY (record_id, item_key)
                );
                CREATE TABLE IF NOT EXISTS manual_test_conditions (
                    record_id INTEGER PRIMARY KEY REFERENCES records(id) ON DELETE CASCADE,
                    temperature TEXT NOT NULL DEFAULT '',
                    humidity TEXT NOT NULL DEFAULT ''
                );
                CREATE TABLE IF NOT EXISTS record_workflows (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    record_id INTEGER NOT NULL REFERENCES records(id) ON DELETE CASCADE,
                    status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'completed')),
                    current_step INTEGER NOT NULL DEFAULT -1,
                    created_by TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                CREATE INDEX IF NOT EXISTS record_workflows_record_id_idx
                    ON record_workflows(record_id, id);
                CREATE TABLE IF NOT EXISTS workflow_steps (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    workflow_id INTEGER NOT NULL REFERENCES record_workflows(id) ON DELETE CASCADE,
                    step_order INTEGER NOT NULL,
                    stage_name TEXT NOT NULL,
                    assignee_name TEXT NOT NULL,
                    assignee_email TEXT NOT NULL,
                    assignee_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                    status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'completed')),
                    notified_at TEXT,
                    completed_at TEXT,
                    UNIQUE (workflow_id, step_order)
                );
                CREATE TABLE IF NOT EXISTS workflow_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    workflow_id INTEGER NOT NULL REFERENCES record_workflows(id) ON DELETE CASCADE,
                    action TEXT NOT NULL,
                    actor TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                """
            )
            workflow_step_columns = {
                row["name"] for row in connection.execute("PRAGMA table_info(workflow_steps)")
            }
            if "assignee_user_id" not in workflow_step_columns:
                connection.execute(
                    "ALTER TABLE workflow_steps ADD COLUMN assignee_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL"
                )
            appearance_columns = {
                row["name"] for row in connection.execute("PRAGMA table_info(appearance_checks)")
            }
            if "setting" not in appearance_columns:
                connection.execute(
                    "ALTER TABLE appearance_checks ADD COLUMN setting TEXT NOT NULL DEFAULT ''"
                )
                connection.executemany(
                    "UPDATE appearance_checks SET setting = ? WHERE check_key = ?",
                    [
                        (setting, key)
                        for key, setting in appearance_check_settings(DEFAULT_APPEARANCE_ITEMS).items()
                    ],
                )
            jumper_table = connection.execute(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'jumper_checks'"
            ).fetchone()
            jumper_columns = {
                row["name"] for row in connection.execute("PRAGMA table_info(jumper_checks)")
            }
            schema_sql = " ".join((jumper_table["sql"] or "").lower().split())
            has_fixed_jumper_check = "check (jumper_name in ('w1', 'w2'))" in schema_sql
            if "setting" not in jumper_columns or has_fixed_jumper_check:
                connection.execute("ALTER TABLE jumper_checks RENAME TO jumper_checks_legacy")
                connection.execute(
                    """
                    CREATE TABLE jumper_checks (
                        record_id INTEGER NOT NULL REFERENCES records(id) ON DELETE CASCADE,
                        jumper_name TEXT NOT NULL,
                        setting TEXT NOT NULL,
                        confirmed INTEGER NOT NULL CHECK (confirmed IN (0, 1)),
                        PRIMARY KEY (record_id, jumper_name)
                    )
                    """
                )
                if "setting" in jumper_columns:
                    connection.execute(
                        """
                        INSERT INTO jumper_checks (record_id, jumper_name, setting, confirmed)
                        SELECT record_id, jumper_name, setting, confirmed
                        FROM jumper_checks_legacy
                        """
                    )
                else:
                    connection.execute(
                        """
                        INSERT INTO jumper_checks (record_id, jumper_name, setting, confirmed)
                        SELECT record_id, jumper_name, '1-2', confirmed
                        FROM jumper_checks_legacy
                        """
                    )
                connection.execute("DROP TABLE jumper_checks_legacy")
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
            if not connection.execute("SELECT 1 FROM users LIMIT 1").fetchone():
                username = app.config["LEDGER_USERNAME"]
                password_hash = app.config["LEDGER_PASSWORD_HASH"]
                if not username or not password_hash:
                    raise RuntimeError(
                        "初回管理者のLEDGER_USERNAMEとLEDGER_PASSWORD_HASHを設定してください。"
                    )
                connection.execute(
                    """
                    INSERT INTO users (username, manager_name, password_hash, role)
                    VALUES (?, NULL, ?, 'admin')
                    """,
                    (username, password_hash),
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
    def current_user():
        user_id = session.get("user_id")
        legacy_username = session.get("username")
        with closing(connect_db()) as connection:
            if user_id:
                row = connection.execute(
                    "SELECT id, username, manager_name, role, is_active FROM users WHERE id = ?",
                    (user_id,),
                ).fetchone()
            else:
                row = None
                if legacy_username:
                    row = connection.execute(
                        "SELECT id, username, manager_name, role, is_active FROM users WHERE username = ? COLLATE NOCASE",
                        (legacy_username,),
                    ).fetchone()
        if not row or not row["is_active"]:
            session.clear()
            return None
        session["user_id"] = row["id"]
        session["username"] = row["username"]
        session["display_name"] = row["manager_name"] or row["username"]
        session["role"] = row["role"]
        return row

    def require_login(view):
        @wraps(view)
        def wrapped(*args, **kwargs):
            user = current_user()
            if not user:
                return jsonify(error="ログインしてください。"), 401
            g.user = user
            return view(*args, **kwargs)

        return wrapped

    def require_admin(view):
        @wraps(view)
        @require_login
        def wrapped(*args, **kwargs):
            if g.user["role"] != "admin":
                return jsonify(error="管理者権限が必要です。"), 403
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
                re.compile(r"[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF0-9A-Za-z\s_-]+"),
                "案件名は日本語、英数字、空白、アンダースコアまたはハイフンで30文字以内で入力してください。",
            ),
            "productNo": (
                30,
                re.compile(r"[A-Za-z0-9 ._-]+"),
                "製番は30文字以内で、半角英数字、空白、ピリオド、アンダースコアまたはハイフンを入力してください。",
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
            if not re.fullmatch(r"(?:\d{8}|\d{4}-\d{2}-\d{2})", registration_date):
                raise ValueError
            registration_date = registration_date.replace("-", "")
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
                ("登録日は実在する日付をyyyy-mm-dd形式で入力してください。", 400),
            )

        uploads = [upload for upload in uploads if upload and upload.filename]
        if len(uploads) > 1:
            return None, None, None, ("試験結果ファイルは1件だけ登録できます。", 400)

        files = []
        total_file_size = 0
        for upload in uploads:
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
        user = current_user()
        if "csrf_token" not in session:
            session["csrf_token"] = secrets.token_urlsafe(32)
        return jsonify(
            authenticated=user is not None,
            userId=user["id"] if user else None,
            username=session.get("username"),
            displayName=session.get("display_name"),
            role=session.get("role"),
            csrfToken=session["csrf_token"],
        )

    # ログイン API。
    # SQLiteに保存した個人アカウントの認証情報を照合する。
    @app.post("/api/login")
    @require_csrf
    def login():
        data = request.get_json(silent=True) or {}
        if not isinstance(data, dict):
            return jsonify(error="ログイン情報の形式が正しくありません。"), 400
        username = data.get("username", "")
        password = data.get("password", "")
        if not isinstance(username, str) or not isinstance(password, str):
            return jsonify(error="ユーザIDまたはパスワードが正しくありません。"), 401
        with closing(connect_db()) as connection:
            user = connection.execute(
                """
                SELECT id, username, manager_name, password_hash, role
                FROM users WHERE username = ? COLLATE NOCASE AND is_active = 1
                """,
                (username.strip(),),
            ).fetchone()
        if not user or not check_password_hash(user["password_hash"], password):
            return jsonify(error="ユーザIDまたはパスワードが正しくありません。"), 401

        session.clear()
        session.permanent = True
        session["user_id"] = user["id"]
        session["username"] = user["username"]
        session["display_name"] = user["manager_name"] or user["username"]
        session["role"] = user["role"]
        session["csrf_token"] = secrets.token_urlsafe(32)
        return jsonify(
            userId=user["id"],
            username=user["username"],
            displayName=session["display_name"],
            role=user["role"],
            csrfToken=session["csrf_token"],
        )

    # ログアウト API。
    @app.post("/api/logout")
    @require_login
    @require_csrf
    def logout():
        session.clear()
        return jsonify(success=True)

    @app.get("/api/workflow-users")
    @require_login
    def get_workflow_users():
        with closing(connect_db()) as connection:
            users = connection.execute(
                """
                SELECT id, manager_name
                FROM users
                WHERE role = 'user' AND is_active = 1 AND manager_name IS NOT NULL
                ORDER BY manager_name COLLATE NOCASE
                """
            ).fetchall()
        return jsonify(users=[
            {"id": user["id"], "name": user["manager_name"]}
            for user in users
        ])

    @app.get("/api/admin/users")
    @require_admin
    def get_admin_users():
        with closing(connect_db()) as connection:
            users = connection.execute(
                """
                SELECT id, username, manager_name, role, is_active, created_at
                FROM users ORDER BY role, username COLLATE NOCASE
                """
            ).fetchall()
            assigned_managers = {
                row["manager_name"].casefold()
                for row in connection.execute(
                    "SELECT manager_name FROM users WHERE manager_name IS NOT NULL"
                )
            }
        return jsonify(users=[
            {
                "id": user["id"],
                "username": user["username"],
                "managerName": user["manager_name"],
                "role": user["role"],
                "isActive": bool(user["is_active"]),
                "createdAt": user["created_at"],
            }
            for user in users
        ], managerChoices=[
            manager for manager in app.config["MANAGER_CHOICES"]
            if manager.casefold() not in assigned_managers
        ])

    @app.post("/api/admin/users")
    @require_admin
    @require_csrf
    def create_user():
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            return jsonify(error="アカウント情報の形式が正しくありません。"), 400
        username = data.get("username")
        manager_name = data.get("managerName")
        password = data.get("password")
        if (
            not isinstance(username, str)
            or not re.fullmatch(r"[A-Za-z0-9._-]{3,50}", username)
            or not isinstance(manager_name, str)
            or manager_name not in app.config["MANAGER_CHOICES"]
            or not isinstance(password, str)
            or not 8 <= len(password) <= 256
        ):
            return jsonify(
                error="ユーザーIDは半角英数字等3～50文字、担当者候補と8～256文字のパスワードを指定してください。"
            ), 400
        password_hash = generate_password_hash(password)
        with closing(connect_db()) as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                cursor = connection.execute(
                    """
                    INSERT INTO users (username, manager_name, password_hash, role)
                    VALUES (?, ?, ?, 'user')
                    """,
                    (username, manager_name, password_hash),
                )
            except sqlite3.IntegrityError:
                return jsonify(error="ユーザーIDまたは担当者には既にアカウントが登録されています。"), 409
            user_id = cursor.lastrowid
            connection.execute(
                """
                UPDATE workflow_steps SET assignee_user_id = ?
                WHERE assignee_name = ? AND assignee_user_id IS NULL
                """,
                (user_id, manager_name),
            )
        return jsonify(
            id=user_id,
            username=username,
            managerName=manager_name,
            role="user",
            isActive=True,
        ), 201

    @app.put("/api/admin/users/<int:user_id>")
    @require_admin
    @require_csrf
    def update_user(user_id):
        data = request.get_json(silent=True)
        if not isinstance(data, dict) or not data:
            return jsonify(error="変更するアカウント情報を指定してください。"), 400
        if set(data) - {"password", "isActive"}:
            return jsonify(error="変更できないアカウント項目が含まれています。"), 400
        password = data.get("password")
        is_active = data.get("isActive")
        
        with closing(connect_db()) as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            user = connection.execute(
                "SELECT id, role, is_active FROM users WHERE id = ?", (user_id,)
            ).fetchone()
            if not user:
                abort(404)
            
            # ロールに基づいたパスワード検証
            if "password" in data:
                min_length = 1 if user["role"] == "admin" else 8
                if not isinstance(password, str) or not min_length <= len(password) <= 256:
                    min_text = "1" if user["role"] == "admin" else "8"
                    return jsonify(error=f"パスワードは{min_text}～256文字で指定してください。"), 400
            
            if "isActive" in data and type(is_active) is not bool:
                return jsonify(error="有効状態は真偽値で指定してください。"), 400
            if "isActive" in data and not is_active:
                if user_id == g.user["id"]:
                    return jsonify(error="ログイン中の管理者は無効化できません。"), 400
                if user["role"] == "admin" and connection.execute(
                    "SELECT COUNT(*) FROM users WHERE role = 'admin' AND is_active = 1"
                ).fetchone()[0] <= 1:
                    return jsonify(error="有効な管理者を1人以上残してください。"), 400
            if "password" in data:
                connection.execute(
                    "UPDATE users SET password_hash = ? WHERE id = ?",
                    (generate_password_hash(password), user_id),
                )
            if "isActive" in data:
                connection.execute(
                    "UPDATE users SET is_active = ? WHERE id = ?",
                    (int(is_active), user_id),
                )
        return jsonify(success=True)

    @app.put("/api/account/password")
    @require_login
    @require_csrf
    def change_password():
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            return jsonify(error="リクエストの形式が正しくありません。"), 400
        
        current_password = data.get("currentPassword")
        new_password = data.get("newPassword")
        
        if not isinstance(current_password, str) or not isinstance(new_password, str):
            return jsonify(error="現在のパスワードと新しいパスワードを指定してください。"), 400
        
        with closing(connect_db()) as connection:
            user = connection.execute(
                "SELECT password_hash, role FROM users WHERE id = ?", (g.user["id"],)
            ).fetchone()
            if not user or not check_password_hash(user["password_hash"], current_password):
                return jsonify(error="現在のパスワードが正しくありません。"), 400
            
            # ロールに基づいたパスワード検証
            min_length = 1 if user["role"] == "admin" else 8
            if not min_length <= len(new_password) <= 256:
                min_text = "1" if user["role"] == "admin" else "8"
                return jsonify(error=f"新しいパスワードは{min_text}～256文字で指定してください。"), 400
            
            new_password_hash = generate_password_hash(new_password)
            connection.execute(
                "UPDATE users SET password_hash = ? WHERE id = ?",
                (new_password_hash, g.user["id"]),
            )
            connection.commit()
        
        return jsonify(success=True)

    # ダッシュボード表示に必要な件数と担当者別の月次集計を返す。
    @app.get("/api/dashboard")
    @require_login
    def dashboard():
        today = date.today()
        current_month = today.strftime("%Y%m")
        year = today.year
        year_start = f"{year}0101"
        next_year_start = f"{year + 1}0101"
        with closing(connect_db()) as connection:
            total_records = connection.execute(
                "SELECT COUNT(*) FROM records"
            ).fetchone()[0]
            month_records = connection.execute(
                "SELECT COUNT(*) FROM records WHERE substr(registration_date, 1, 6) = ?",
                (current_month,),
            ).fetchone()[0]
            monthly_rows = connection.execute(
                """
                SELECT substr(registration_date, 5, 2) AS month,
                       manager, COUNT(*) AS count
                FROM records
                WHERE registration_date >= ? AND registration_date < ?
                GROUP BY month, manager
                ORDER BY manager, month
                """,
                (year_start, next_year_start),
            ).fetchall()
        manager_counts = {}
        for row in monthly_rows:
            counts = manager_counts.setdefault(row["manager"], [0] * 12)
            counts[int(row["month"]) - 1] = row["count"]
        manager_stats = {
            "year": year,
            "managers": [
                {"name": manager, "counts": counts}
                for manager, counts in manager_counts.items()
            ],
        }
        return jsonify(
            totalRecords=total_records,
            monthRecords=month_records,
            currentMonth=today.strftime("%Y年%m月"),
            managerStats=manager_stats,
        )

    @app.post("/api/trial-numbers/next")
    @require_login
    @require_csrf
    def reserve_next_trial_number():
        prefix = f"{date.today():%y}0"
        payload = request.get_json(silent=True) or {}
        occupied_trial_numbers = payload.get("occupiedTrialNumbers", [])
        if (
            not isinstance(occupied_trial_numbers, list)
            or any(not isinstance(trial_no, str) for trial_no in occupied_trial_numbers)
        ):
            return jsonify(error="採番に使用する試験番号の形式が正しくありません。"), 400
        with closing(connect_db()) as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            used_numbers = connection.execute(
                """
                SELECT trial_no FROM records WHERE trial_no LIKE ?
                """,
                (f"{prefix}%",),
            ).fetchall()
            serials = [
                int(match.group(1))
                for trial_no in (
                    [row["trial_no"] for row in used_numbers] + occupied_trial_numbers
                )
                if (match := re.fullmatch(rf"{prefix}(\d{{5}})", trial_no))
            ]
            used_serials = set(serials)
            next_serial = 0
            while next_serial in used_serials:
                next_serial += 1
            if next_serial > 99999:
                return jsonify(error="今年の採番上限（99999）に達しました。"), 409
            trial_no = f"{prefix}{next_serial:05d}"
        return jsonify(trialNo=trial_no), 201

    def trial_number_exists(connection, trial_no, exclude_record_id=None):
        query = "SELECT 1 FROM records WHERE trial_no = ? COLLATE NOCASE"
        parameters = [trial_no]
        if exclude_record_id is not None:
            query += " AND id != ?"
            parameters.append(exclude_record_id)
        return connection.execute(query, parameters).fetchone() is not None

    # 記録の一覧取得と新規登録をまとめて扱う API。
    # GET は検索条件による一覧取得、POST は新規レコード登録。
    @app.route("/api/records", methods=["GET", "POST"])
    @require_csrf
    @require_login
    def records():
        if request.method == "GET":
            raw_filters = {
                "trial_no": request.args.get("trialNo", ""),
                "project_name": request.args.get("projectName", ""),
                "product_no": request.args.get("productNo", ""),
                "registration_date": request.args.get("date", ""),
                "manager": request.args.get("manager", ""),
            }
            max_filter_lengths = {
                "trial_no": 20,
                "project_name": 30,
                "product_no": 30,
                "registration_date": 10,
                "manager": 30,
            }
            if any(
                len(value) > max_filter_lengths[key]
                for key, value in raw_filters.items()
            ):
                return jsonify(error="検索条件が長すぎます。"), 400
            filters = {
                **raw_filters,
                "registration_date": raw_filters["registration_date"].replace("-", ""),
            }
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
                report_rows = connection.execute(
                    """
                    SELECT id, record_id, file_name
                    FROM power_board_reports
                    """
                ).fetchall()
            files_by_record = {}
            for file_row in file_rows:
                files_by_record.setdefault(file_row["record_id"], []).append(
                    {"id": file_row["id"], "fileName": file_row["file_name"]}
                )
            reports_by_record = {
                report_row["record_id"]: {
                    "id": report_row["id"],
                    "fileName": report_row["file_name"],
                }
                for report_row in report_rows
            }
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
                    "powerBoardReport": reports_by_record.get(row["id"]),
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
        values, registration_date, files, error = parse_record_submission(
            form,
            uploads,
        )
        if error:
            return jsonify(error=error[0]), error[1]
        try:
            for file_name, _content_type, file_data in files:
                if file_name.lower().endswith(".csv"):
                    parse_trial_results_file(file_name, file_data)
        except ValueError as error:
            return jsonify(error=str(error)), 400

        with closing(connect_db()) as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            if trial_number_exists(connection, values["trialNo"]):
                return jsonify(
                    error=f"試験番号「{values['trialNo']}」は既に登録されています。"
                ), 409
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
            file_metadata = []
            for file_name, content_type, file_data in files:
                file_cursor = connection.execute(
                    """
                    INSERT INTO record_files (
                        record_id, file_name, file_content_type, file_data
                    ) VALUES (?, ?, ?, ?)
                    """,
                    (record_id, file_name, content_type, file_data),
                )
                file_metadata.append({
                    "id": file_cursor.lastrowid,
                    "fileName": file_name,
                })
        return jsonify(id=record_id, files=file_metadata), 201

    @app.post("/api/records/batch")
    @require_csrf
    @require_login
    def create_records_batch():
        if request.is_json:
            submissions = request.get_json(silent=True)
            uploads_by_submission = []
        else:
            try:
                submissions = json.loads(request.form.get("submissions", ""))
            except (TypeError, ValueError):
                submissions = None
            uploads_by_submission = []
            if isinstance(submissions, list):
                uploads_by_submission = [
                    request.files.getlist(f"resultFiles-{index}")
                    for index in range(len(submissions))
                ]
        if not isinstance(submissions, list) or not submissions:
            return jsonify(error="登録する記録を1件以上指定してください。"), 400

        validated_submissions = []
        seen_trial_numbers = {}
        total_file_size = 0
        for index, submission in enumerate(submissions, start=1):
            if not isinstance(submission, dict):
                return jsonify(error=f"{index}件目の入力形式が正しくありません。"), 400
            uploads = uploads_by_submission[index - 1] if uploads_by_submission else []
            values, registration_date, files, error = parse_record_submission(
                submission,
                uploads,
            )
            if error:
                return jsonify(error=f"{index}件目: {error[0]}"), error[1]
            normalized_trial_no = values["trialNo"].casefold()
            if normalized_trial_no in seen_trial_numbers:
                return jsonify(
                    error=(
                        f"{index}件目: 試験番号「{values['trialNo']}」は"
                        f"{seen_trial_numbers[normalized_trial_no]}件目と重複しています。"
                    )
                ), 409
            seen_trial_numbers[normalized_trial_no] = index
            total_file_size += sum(len(file_data) for _, _, file_data in files)
            if total_file_size > MAX_TOTAL_FILE_SIZE:
                return jsonify(error="試験結果ファイルの合計は100 MB以下にしてください。"), 413
            try:
                for file_name, _content_type, file_data in files:
                    parse_trial_results_file(file_name, file_data)
            except ValueError as error:
                return jsonify(error=f"{index}件目: {error}"), 400
            validated_submissions.append((values, registration_date, files))

        with closing(connect_db()) as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            for index, (values, _registration_date, _files) in enumerate(
                validated_submissions, start=1
            ):
                if trial_number_exists(connection, values["trialNo"]):
                    return jsonify(
                        error=(
                            f"{index}件目: 試験番号「{values['trialNo']}」"
                            "は既に登録されています。"
                        )
                    ), 409
            created_records = []
            for values, registration_date, files in validated_submissions:
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
                file_metadata = []
                for file_name, content_type, file_data in files:
                    file_cursor = connection.execute(
                        """
                        INSERT INTO record_files (
                            record_id, file_name, file_content_type, file_data
                        ) VALUES (?, ?, ?, ?)
                        """,
                        (record_id, file_name, content_type, file_data),
                    )
                    file_metadata.append({
                        "id": file_cursor.lastrowid,
                        "fileName": file_name,
                    })
                created_records.append({
                    "id": record_id,
                    **values,
                    "registrationDate": registration_date,
                    "files": file_metadata,
                    "fileName": file_metadata[0]["fileName"] if file_metadata else None,
                })
        return jsonify(records=created_records), 201

    def load_appearance_checks(connection, record_id):
        saved = {
            row["check_key"]: row
            for row in connection.execute(
                "SELECT check_key, setting, confirmed FROM appearance_checks WHERE record_id = ?",
                (record_id,),
            )
        }
        return {
            key: bool(saved[key]["confirmed"])
            if key in saved and saved[key]["setting"] == setting else False
            for key, setting in appearance_settings.items()
        }

    @app.get("/api/records/<int:record_id>/appearance-checks")
    @require_login
    def get_appearance_checks(record_id):
        with closing(connect_db()) as connection:
            if not connection.execute(
                "SELECT id FROM records WHERE id = ?", (record_id,)
            ).fetchone():
                abort(404)
            checks = load_appearance_checks(connection, record_id)
        return jsonify(**app.config["APPEARANCE_INSPECTION"], checks=checks)

    def load_insertion_key_checks(connection, record_id):
        saved = {
            row["connector_name"]: row
            for row in connection.execute(
                "SELECT connector_name, positions, confirmed FROM insertion_key_checks WHERE record_id = ?",
                (record_id,),
            )
        }
        return [
            {
                **connector,
                "confirmed": bool(saved[connector["name"]]["confirmed"])
                if connector["name"] in saved
                and saved[connector["name"]]["positions"] == ",".join(connector["positions"])
                else False,
            }
            for connector in INSERTION_KEY_CONNECTORS
        ]

    def manual_test_judgement(value, item):
        if not value.strip():
            return ""
        try:
            number = float(value)
        except (TypeError, ValueError):
            return "NG"
        if not float("-inf") < number < float("inf"):
            return "NG"
        lower_limit = float(item["lowerLimit"])
        upper_limit = float(item["upperLimit"])
        return "PASS" if lower_limit <= number <= upper_limit else "NG"

    def load_manual_tests(connection, record_id):
        saved = {
            row["item_key"]: row
            for row in connection.execute(
                """
                SELECT item_key, setting, measured_value, bench_lock
                FROM manual_test_results WHERE record_id = ?
                """,
                (record_id,),
            )
        }
        loaded = []
        for test in app.config["MANUAL_TESTS"]:
            items = []
            for item in test["items"]:
                setting = json.dumps(
                    [item["name"], item["lowerLimit"], item["upperLimit"], item["unit"], item["benchLock"]],
                    ensure_ascii=False,
                )
                row = saved.get(item["key"])
                matches = row is not None and row["setting"] == setting
                measured_value = row["measured_value"] if matches else ""
                bench_lock = bool(row["bench_lock"]) if matches else False
                items.append({
                    **item,
                    "measuredValue": measured_value,
                    "judgement": manual_test_judgement(measured_value, item),
                    "benchLockChecked": bench_lock,
                })
            loaded.append({**test, "items": items})
        return loaded

    @app.get("/api/records/<int:record_id>/manual-tests")
    @require_login
    def get_manual_tests(record_id):
        with closing(connect_db()) as connection:
            if not connection.execute(
                "SELECT id FROM records WHERE id = ?", (record_id,)
            ).fetchone():
                abort(404)
            return jsonify(load_manual_tests(connection, record_id))

    @app.get("/api/records/<int:record_id>/manual-test-conditions")
    @require_login
    def get_manual_test_conditions(record_id):
        with closing(connect_db()) as connection:
            if not connection.execute(
                "SELECT id FROM records WHERE id = ?", (record_id,)
            ).fetchone():
                abort(404)
            row = connection.execute(
                """
                SELECT temperature, humidity
                FROM manual_test_conditions WHERE record_id = ?
                """,
                (record_id,),
            ).fetchone()
        return jsonify(
            temperature=row["temperature"] if row else "",
            humidity=row["humidity"] if row else "",
        )

    @app.get("/api/records/<int:record_id>/insertion-keys")
    @require_login
    def get_insertion_key_checks(record_id):
        with closing(connect_db()) as connection:
            if not connection.execute(
                "SELECT id FROM records WHERE id = ?", (record_id,)
            ).fetchone():
                abort(404)
            return jsonify(load_insertion_key_checks(connection, record_id))

    @app.get("/api/records/<int:record_id>/jumpers")
    @require_login
    def get_jumper_checks(record_id):
        with closing(connect_db()) as connection:
            if not connection.execute(
                "SELECT id FROM records WHERE id = ?", (record_id,)
            ).fetchone():
                abort(404)
            rows = connection.execute(
                "SELECT jumper_name, setting, confirmed FROM jumper_checks WHERE record_id = ?",
                (record_id,),
            ).fetchall()
        saved = {row["jumper_name"]: row for row in rows}
        return jsonify([
            {
                **jumper,
                "confirmed": bool(saved[jumper["name"]]["confirmed"])
                if jumper["name"] in saved
                and saved[jumper["name"]]["setting"] == jumper["setting"]
                else False,
            }
            for jumper in app.config["JUMPERS"]
        ])

    @app.put("/api/records/<int:record_id>/jumpers/<jumper_name>")
    @require_login
    @require_csrf
    def update_jumper_check(record_id, jumper_name):
        jumper = next(
            (item for item in app.config["JUMPERS"] if item["name"] == jumper_name),
            None,
        )
        if jumper is None:
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
                INSERT INTO jumper_checks (record_id, jumper_name, setting, confirmed)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(record_id, jumper_name)
                DO UPDATE SET setting = excluded.setting, confirmed = excluded.confirmed
                """,
                (record_id, jumper_name, jumper["setting"], int(data["confirmed"])),
            )
        return jsonify(**jumper, confirmed=data["confirmed"])

    @app.route("/api/records/<int:record_id>/equipment", methods=["GET", "PUT"])
    @require_login
    @require_csrf
    def record_equipment(record_id):
        data = None
        if request.method == "PUT":
            data = request.get_json(silent=True)
            error = validate_equipment(
                data, app.config["BOARD_DEFAULTS"], app.config["SOFTWARE_SECTIONS"],
            )
            if error:
                return jsonify(error=error), 400
            data = normalize_equipment(
                data, app.config["BOARD_DEFAULTS"], app.config["SOFTWARE_SECTIONS"],
            )

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
        data = json.loads(row["payload"]) if row else empty_equipment(
            app.config["BOARD_DEFAULTS"], app.config["SOFTWARE_SECTIONS"],
        )
        return jsonify(normalize_equipment(
            data, app.config["BOARD_DEFAULTS"], app.config["SOFTWARE_SECTIONS"],
        ))

    @app.get("/api/equipment-config")
    @require_login
    def get_equipment_config():
        return jsonify(
            instrumentChoices=app.config["INSTRUMENT_CHOICES"],
            managerChoices=app.config["MANAGER_CHOICES"],
            manualTests=app.config["MANUAL_TESTS"],
            softwareSections=app.config["SOFTWARE_SECTIONS"],
        )

    def latest_workflow(connection, record_id):
        return connection.execute(
            "SELECT * FROM record_workflows WHERE record_id = ? ORDER BY id DESC LIMIT 1",
            (record_id,),
        ).fetchone()

    @app.get("/api/records/<int:record_id>/workflow")
    @require_login
    def get_record_workflow(record_id):
        with closing(connect_db()) as connection:
            if not connection.execute("SELECT id FROM records WHERE id = ?", (record_id,)).fetchone():
                abort(404)
            workflow = latest_workflow(connection, record_id)
            if not workflow:
                return jsonify(workflow=None)
            steps = connection.execute(
                "SELECT * FROM workflow_steps WHERE workflow_id = ? ORDER BY step_order",
                (workflow["id"],),
            ).fetchall()
            events = connection.execute(
                "SELECT action, actor, created_at FROM workflow_events WHERE workflow_id = ? ORDER BY id",
                (workflow["id"],),
            ).fetchall()
        current_step = next(
            (step for step in steps if step["step_order"] == workflow["current_step"]),
            None,
        )
        can_advance = (
            workflow["status"] == "active"
            and current_step is not None
            and (
                current_step["assignee_user_id"] == g.user["id"]
                or g.user["role"] == "admin"
            )
        )
        return jsonify(
            workflow={
                "id": workflow["id"],
                "status": workflow["status"],
                "currentStep": workflow["current_step"],
                "createdAt": workflow["created_at"],
                "updatedAt": workflow["updated_at"],
                "canAdvance": can_advance,
                "isAdminOverride": can_advance and g.user["role"] == "admin"
                and current_step["assignee_user_id"] != g.user["id"],
                "steps": [
                    {
                        "stageName": step["stage_name"],
                        "assigneeName": step["assignee_name"],
                        "assigneeUserId": step["assignee_user_id"],
                        "status": step["status"],
                        "notifiedAt": step["notified_at"],
                        "completedAt": step["completed_at"],
                    }
                    for step in steps
                ],
                "events": [dict(event) for event in events],
            }
        )

    @app.put("/api/records/<int:record_id>/workflow")
    @require_login
    @require_csrf
    def save_record_workflow(record_id):
        data = request.get_json(silent=True)
        steps = data.get("steps") if isinstance(data, dict) else None
        if not isinstance(steps, list) or not 1 <= len(steps) <= 20:
            return jsonify(error="回覧段階は1～20件で指定してください。"), 400
        normalized_steps = []
        for index, step in enumerate(steps, start=1):
            if not isinstance(step, dict):
                return jsonify(error=f"{index}段階目の入力形式が正しくありません。"), 400
            stage_name = step.get("stageName")
            if (
                not isinstance(stage_name, str) or not stage_name.strip() or len(stage_name.strip()) > 50
                or type(step.get("assigneeUserId")) is not int
                or step["assigneeUserId"] <= 0
            ):
                return jsonify(
                    error=f"{index}段階目の段階名と有効な担当者を指定してください。"
                ), 400
            normalized_steps.append((stage_name.strip(), step["assigneeUserId"]))

        with closing(connect_db()) as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            if not connection.execute("SELECT id FROM records WHERE id = ?", (record_id,)).fetchone():
                abort(404)
            resolved_steps = []
            for index, (stage_name, assignee_user_id) in enumerate(normalized_steps, start=1):
                assignee = connection.execute(
                    """
                    SELECT id, manager_name FROM users
                    WHERE id = ? AND role = 'user' AND is_active = 1
                    """,
                    (assignee_user_id,),
                ).fetchone()
                if not assignee:
                    return jsonify(error=f"{index}段階目の担当者アカウントが見つからないか無効です。"), 400
                resolved_steps.append((stage_name, assignee["id"], assignee["manager_name"]))
            workflow = latest_workflow(connection, record_id)
            if workflow and workflow["status"] == "active":
                return jsonify(error="回覧中のフローは変更できません。"), 409
            if workflow and workflow["status"] == "draft":
                workflow_id = workflow["id"]
                connection.execute("DELETE FROM workflow_steps WHERE workflow_id = ?", (workflow_id,))
                connection.execute(
                    "UPDATE record_workflows SET current_step = -1, created_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                    (session["username"], workflow_id),
                )
                connection.execute("DELETE FROM workflow_events WHERE workflow_id = ?", (workflow_id,))
            else:
                cursor = connection.execute(
                    "INSERT INTO record_workflows (record_id, status, created_by) VALUES (?, 'draft', ?)",
                    (record_id, session["username"]),
                )
                workflow_id = cursor.lastrowid
            connection.executemany(
                """
                INSERT INTO workflow_steps (
                    workflow_id, step_order, stage_name, assignee_name, assignee_email,
                    assignee_user_id, status
                ) VALUES (?, ?, ?, ?, '', ?, 'pending')
                """,
                [
                    (workflow_id, index, stage_name, assignee_name, assignee_user_id)
                    for index, (stage_name, assignee_user_id, assignee_name) in enumerate(resolved_steps)
                ],
            )
            connection.execute(
                "INSERT INTO workflow_events (workflow_id, action, actor) VALUES (?, 'configured', ?)",
                (workflow_id, session["display_name"]),
            )
        return jsonify(success=True), 200

    @app.get("/api/workflow-inbox")
    @require_login
    def get_workflow_inbox():
        query = """
            SELECT records.id, records.trial_no, records.project_name,
                   records.manager, workflows.current_step, workflows.updated_at,
                   steps.stage_name, steps.assignee_user_id, steps.assignee_name
            FROM record_workflows AS workflows
            JOIN records ON records.id = workflows.record_id
            JOIN workflow_steps AS steps
              ON steps.workflow_id = workflows.id
             AND steps.step_order = workflows.current_step
            WHERE workflows.status = 'active' AND steps.status = 'active'
        """
        parameters = ()
        if g.user["role"] != "admin":
            query += " AND steps.assignee_user_id = ?"
            parameters = (g.user["id"],)
        query += " ORDER BY workflows.updated_at, records.trial_no"
        with closing(connect_db()) as connection:
            tasks = connection.execute(query, parameters).fetchall()
        return jsonify(tasks=[
            {
                "recordId": task["id"],
                "trialNo": task["trial_no"],
                "projectName": task["project_name"],
                "recordManager": task["manager"],
                "stageName": task["stage_name"],
                "assigneeUserId": task["assignee_user_id"],
                "assigneeName": task["assignee_name"],
                "updatedAt": task["updated_at"],
                "isAssignedToMe": task["assignee_user_id"] == g.user["id"],
            }
            for task in tasks
        ])

    @app.post("/api/records/<int:record_id>/workflow/start")
    @require_login
    @require_csrf
    def start_record_workflow(record_id):
        with closing(connect_db()) as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            record = connection.execute(
                "SELECT id FROM records WHERE id = ?", (record_id,)
            ).fetchone()
            if not record:
                abort(404)
            workflow = latest_workflow(connection, record_id)
            if not workflow or workflow["status"] != "draft":
                return jsonify(error="開始できる保存済みの回覧フローがありません。"), 409
            step = connection.execute(
                "SELECT * FROM workflow_steps WHERE workflow_id = ? AND step_order = 0",
                (workflow["id"],),
            ).fetchone()
            connection.execute(
                "UPDATE workflow_steps SET status = 'active' WHERE id = ?",
                (step["id"],),
            )
            connection.execute(
                "UPDATE record_workflows SET status = 'active', current_step = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                (workflow["id"],),
            )
            connection.execute(
                "INSERT INTO workflow_events (workflow_id, action, actor) VALUES (?, 'started', ?)",
                (workflow["id"], session["display_name"]),
            )
        return jsonify(success=True)

    @app.post("/api/records/<int:record_id>/workflow/advance")
    @require_login
    @require_csrf
    def advance_record_workflow(record_id):
        with closing(connect_db()) as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            if not connection.execute(
                "SELECT id FROM records WHERE id = ?", (record_id,)
            ).fetchone():
                abort(404)
            workflow = latest_workflow(connection, record_id)
            if not workflow or workflow["status"] != "active":
                return jsonify(error="進行中の回覧フローがありません。"), 409
            current = connection.execute(
                "SELECT * FROM workflow_steps WHERE workflow_id = ? AND step_order = ?",
                (workflow["id"], workflow["current_step"]),
            ).fetchone()
            if (
                current["assignee_user_id"] != g.user["id"]
                and g.user["role"] != "admin"
            ):
                return jsonify(error="現在の担当者または管理者だけが回覧を進められます。"), 403
            following = connection.execute(
                "SELECT * FROM workflow_steps WHERE workflow_id = ? AND step_order = ?",
                (workflow["id"], workflow["current_step"] + 1),
            ).fetchone()
            
            # メール送信用のデータを準備
            record = connection.execute(
                "SELECT trial_no, project_name FROM records WHERE id = ?", (record_id,)
            ).fetchone()
            current_manager = current["assignee_name"]
            stage_name = current["stage_name"]
            
            if following:
                connection.execute(
                    "UPDATE workflow_steps SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = ?",
                    (current["id"],),
                )
                connection.execute(
                    "UPDATE workflow_steps SET status = 'active' WHERE id = ?",
                    (following["id"],),
                )
                connection.execute(
                    "UPDATE record_workflows SET current_step = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                    (workflow["current_step"] + 1, workflow["id"]),
                )
                action = "forwarded"
                
                # メール送信: 次の担当者にメールを送信
                next_assignee = connection.execute(
                    "SELECT username, manager_name FROM users WHERE id = ?",
                    (following["assignee_user_id"],),
                ).fetchone()
                
                if next_assignee:
                    # equipment-config.json から次の担当者のメールアドレスを取得
                    with open(app.config["EQUIPMENT_CONFIG_PATH"], encoding="utf-8") as f:
                        config = json.load(f)
                    
                    next_email = None
                    for manager in config.get("managerChoices", []):
                        # manager は辞書または文字列（旧形式）の場合がある
                        manager_name = manager.get("name") if isinstance(manager, dict) else manager
                        if manager_name == next_assignee["manager_name"]:
                            next_email = manager.get("email") if isinstance(manager, dict) else None
                            break
                    
                    if next_email:
                        send_workflow_advancement_email(
                            recipient_email=next_email,
                            recipient_name=next_assignee["manager_name"],
                            record_id=record_id,
                            trial_no=record["trial_no"],
                            project_name=record["project_name"],
                            stage_name=following["stage_name"],
                            current_manager=current_manager,
                        )
            else:
                connection.execute(
                    "UPDATE workflow_steps SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = ?",
                    (current["id"],),
                )
                connection.execute(
                    "UPDATE record_workflows SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                    (workflow["id"],),
                )
                action = "completed"
            connection.execute(
                "INSERT INTO workflow_events (workflow_id, action, actor) VALUES (?, ?, ?)",
                (workflow["id"], action, session["display_name"]),
            )
        return jsonify(success=True)

    @app.put("/api/records/<int:record_id>/details")
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

        combined = request.path.endswith("/details")
        equipment = None
        jumper_checks = None
        appearance_checks = None
        insertion_key_checks = None
        manual_test_results = None
        manual_test_conditions = None
        if combined:
            try:
                for file_name, _content_type, file_data in files:
                    parse_trial_results_file(file_name, file_data)
            except ValueError as error:
                return jsonify(error=str(error)), 400
            try:
                equipment = json.loads(request.form.get("equipment", ""))
                jumper_checks = json.loads(request.form.get("jumperChecks", ""))
            except (ValueError, TypeError):
                return jsonify(error="機器情報・ジャンパ確認の形式が正しくありません。"), 400
            error = validate_equipment(
                equipment, app.config["BOARD_DEFAULTS"],
                app.config["SOFTWARE_SECTIONS"],
            )
            if error:
                return jsonify(error=error), 400
            equipment = normalize_equipment(
                equipment, app.config["BOARD_DEFAULTS"],
                app.config["SOFTWARE_SECTIONS"],
            )
            jumper_names = {jumper["name"] for jumper in app.config["JUMPERS"]}
            if (
                not isinstance(jumper_checks, dict)
                or set(jumper_checks) != jumper_names
                or any(not isinstance(value, bool) for value in jumper_checks.values())
            ):
                return jsonify(error="ジャンパ確認は設定済みジャンパの真偽値で指定してください。"), 400
            if "appearanceChecks" in request.form:
                try:
                    appearance_checks = json.loads(request.form["appearanceChecks"])
                except (ValueError, TypeError):
                    return jsonify(error="外観確認の形式が正しくありません。"), 400
                if (
                    not isinstance(appearance_checks, dict)
                    or appearance_checks.keys() != appearance_settings.keys()
                    or any(not isinstance(value, bool) for value in appearance_checks.values())
                ):
                    return jsonify(error="外観確認はすべての確認対象の真偽値で指定してください。"), 400
            if "insertionKeyChecks" in request.form:
                try:
                    insertion_key_checks = json.loads(request.form["insertionKeyChecks"])
                except (ValueError, TypeError):
                    return jsonify(error="誤挿入キー確認の形式が正しくありません。"), 400
                if (
                    not isinstance(insertion_key_checks, dict)
                    or set(insertion_key_checks) not in (
                        {connector["name"] for connector in INSERTION_KEY_CONNECTORS},
                        {connector["name"] for connector in BACKBOARD_INSERTION_KEY_CONNECTORS},
                    )
                    or any(not isinstance(value, bool) for value in insertion_key_checks.values())
                ):
                    return jsonify(error="誤挿入キー確認はすべてのコネクタの真偽値で指定してください。"), 400
            if "manualTestResults" in request.form:
                try:
                    manual_test_results = json.loads(request.form["manualTestResults"])
                except (ValueError, TypeError):
                    return jsonify(error="手動試験結果の形式が正しくありません。"), 400
                expected_item_keys = {
                    item["key"]
                    for test in app.config["MANUAL_TESTS"]
                    for item in test["items"]
                }
                if (
                    not isinstance(manual_test_results, dict)
                    or set(manual_test_results) != expected_item_keys
                    or any(
                        not isinstance(result, dict)
                        or set(result) != {"measuredValue", "benchLockChecked"}
                        or not isinstance(result["measuredValue"], str)
                        or len(result["measuredValue"]) > 100
                        or type(result["benchLockChecked"]) is not bool
                        for result in manual_test_results.values()
                    )
                ):
                    return jsonify(
                        error="手動試験結果は設定済み項目の測定値とペンキロック確認で指定してください。"
                    ), 400
            if "manualTestConditions" in request.form:
                try:
                    manual_test_conditions = json.loads(
                        request.form["manualTestConditions"]
                    )
                except (ValueError, TypeError):
                    return jsonify(error="温度・湿度の形式が正しくありません。"), 400
                if (
                    not isinstance(manual_test_conditions, dict)
                    or set(manual_test_conditions) != {"temperature", "humidity"}
                    or any(
                        not isinstance(value, str) or len(value) > 100
                        for value in manual_test_conditions.values()
                    )
                ):
                    return jsonify(
                        error="温度・湿度は100文字以内の文字列で指定してください。"
                    ), 400

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
            connection.execute("BEGIN IMMEDIATE")
            record = connection.execute(
                "SELECT id, trial_no FROM records WHERE id = ?",
                (record_id,),
            ).fetchone()
            if not record:
                abort(404)
            if (
                record["trial_no"].casefold() != values["trialNo"].casefold()
                and trial_number_exists(
                    connection,
                    values["trialNo"],
                    exclude_record_id=record_id,
                )
            ):
                return jsonify(
                    error=f"試験番号「{values['trialNo']}」は既に登録されています。"
                ), 409

            if remove_file_ids or files:
                existing_file_ids = {
                    row["id"]
                    for row in connection.execute(
                        "SELECT id FROM record_files WHERE record_id = ?",
                        (record_id,),
                    ).fetchall()
                }
                if remove_file_ids and not set(remove_file_ids).issubset(existing_file_ids):
                    return jsonify(error="削除対象の添付ファイルが見つかりません。"), 400
                remaining_file_count = len(existing_file_ids - set(remove_file_ids))
                if remaining_file_count + len(files) > 1:
                    return jsonify(error="試験結果ファイルは1件だけ登録できます。"), 400

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
            if combined:
                connection.execute(
                    """
                    INSERT INTO record_equipment (record_id, payload) VALUES (?, ?)
                    ON CONFLICT(record_id) DO UPDATE SET payload = excluded.payload
                    """,
                    (record_id, json.dumps(equipment)),
                )
                connection.executemany(
                    """
                    INSERT INTO jumper_checks (record_id, jumper_name, setting, confirmed)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(record_id, jumper_name)
                    DO UPDATE SET setting = excluded.setting, confirmed = excluded.confirmed
                    """,
                    [
                        (
                            record_id,
                            jumper["name"],
                            jumper["setting"],
                            int(jumper_checks[jumper["name"]]),
                        )
                        for jumper in app.config["JUMPERS"]
                    ],
                )
                if appearance_checks is not None:
                    connection.executemany(
                        """
                        INSERT INTO appearance_checks (record_id, check_key, setting, confirmed)
                        VALUES (?, ?, ?, ?)
                        ON CONFLICT(record_id, check_key)
                        DO UPDATE SET setting = excluded.setting, confirmed = excluded.confirmed
                        """,
                        [
                            (record_id, key, appearance_settings[key], int(confirmed))
                            for key, confirmed in appearance_checks.items()
                        ],
                    )
                appearance_checks = load_appearance_checks(connection, record_id)
                if insertion_key_checks is not None:
                    connection.executemany(
                        """
                        INSERT INTO insertion_key_checks (record_id, connector_name, positions, confirmed)
                        VALUES (?, ?, ?, ?)
                        ON CONFLICT(record_id, connector_name)
                        DO UPDATE SET positions = excluded.positions, confirmed = excluded.confirmed
                        """,
                        [
                            (
                                record_id, connector["name"], ",".join(connector["positions"]),
                                int(insertion_key_checks[connector["name"]]),
                            )
                            for connector in INSERTION_KEY_CONNECTORS
                            if connector["name"] in insertion_key_checks
                        ],
                    )
                insertion_keys = load_insertion_key_checks(connection, record_id)
                if manual_test_results is not None:
                    connection.executemany(
                        """
                        INSERT INTO manual_test_results (
                            record_id, item_key, setting, measured_value, bench_lock
                        ) VALUES (?, ?, ?, ?, ?)
                        ON CONFLICT(record_id, item_key)
                        DO UPDATE SET setting = excluded.setting,
                                      measured_value = excluded.measured_value,
                                      bench_lock = excluded.bench_lock
                        """,
                        [
                            (
                                record_id,
                                item["key"],
                                json.dumps(
                                    [
                                        item["name"], item["lowerLimit"],
                                        item["upperLimit"], item["unit"], item["benchLock"],
                                    ],
                                    ensure_ascii=False,
                                ),
                                manual_test_results[item["key"]]["measuredValue"],
                                int(manual_test_results[item["key"]]["benchLockChecked"]),
                            )
                            for test in app.config["MANUAL_TESTS"]
                            for item in test["items"]
                        ],
                    )
                manual_tests = load_manual_tests(connection, record_id)
                if manual_test_conditions is not None:
                    connection.execute(
                        """
                        INSERT INTO manual_test_conditions (
                            record_id, temperature, humidity
                        ) VALUES (?, ?, ?)
                        ON CONFLICT(record_id)
                        DO UPDATE SET temperature = excluded.temperature,
                                      humidity = excluded.humidity
                        """,
                        (
                            record_id,
                            manual_test_conditions["temperature"],
                            manual_test_conditions["humidity"],
                        ),
                    )
                saved_files = [
                    {"id": row["id"], "fileName": row["file_name"]}
                    for row in connection.execute(
                        "SELECT id, file_name FROM record_files WHERE record_id = ? ORDER BY id",
                        (record_id,),
                    ).fetchall()
                ]
                saved_report = connection.execute(
                    """
                    SELECT id, file_name FROM power_board_reports WHERE record_id = ?
                    """,
                    (record_id,),
                ).fetchone()
                updated_record = {
                    "id": record_id,
                    **values,
                    "registrationDate": registration_date,
                    "files": saved_files,
                    "fileName": saved_files[0]["fileName"] if saved_files else None,
                    "powerBoardReport": (
                        {"id": saved_report["id"], "fileName": saved_report["file_name"]}
                        if saved_report else None
                    ),
                }
        if combined:
            return jsonify(
                success=True, record=updated_record, equipment=equipment,
                jumperChecks=jumper_checks, appearanceChecks=appearance_checks,
                insertionKeys=insertion_keys, manualTests=manual_tests,
                manualTestConditions=manual_test_conditions or {
                    "temperature": "",
                    "humidity": "",
                },
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

    @app.post("/api/records/<int:record_id>/power-board-report")
    @require_login
    @require_csrf
    def upload_power_board_report(record_id):
        uploads = [
                upload for upload in request.files.getlist("reportFile")
                if upload and upload.filename
        ]
        if len(uploads) != 1:
                return jsonify(error="電源基板試験成績票のPDFファイルを1件選択してください。"), 400
        upload = uploads[0]
        if not upload.filename.lower().endswith(".pdf"):
                return jsonify(error="電源基板試験成績票にはPDFファイルを選択してください。"), 400
        content = upload.read(MAX_FILE_SIZE + 1)
        if len(content) > MAX_FILE_SIZE:
                return jsonify(error="添付ファイルは1件あたり100 MB以下にしてください。"), 413
        if not content.startswith(b"%PDF-"):
                return jsonify(error="選択したファイルは有効なPDFではありません。"), 400

        file_name = upload.filename.replace("\\", "/").rsplit("/", 1)[-1]
        file_name = "".join(char for char in file_name if char.isprintable()).strip()[:255]
        file_name = file_name or "power-board-report.pdf"
        with closing(connect_db()) as connection, connection:
                connection.execute("BEGIN IMMEDIATE")
                if not connection.execute(
                    "SELECT id FROM records WHERE id = ?", (record_id,)
                ).fetchone():
                    abort(404)
                if connection.execute(
                    "SELECT id FROM power_board_reports WHERE record_id = ?", (record_id,)
                ).fetchone():
                    return jsonify(error="電源基板試験成績票は1件だけ登録できます。"), 409
                cursor = connection.execute(
                    """
                    INSERT INTO power_board_reports (record_id, file_name, file_data)
                    VALUES (?, ?, ?)
                    """,
                    (record_id, file_name, content),
                )
                report = {"id": cursor.lastrowid, "fileName": file_name}
        return jsonify(report=report), 201

    @app.get("/api/records/<int:record_id>/power-board-report")
    @require_login
    def get_power_board_report(record_id):
        with closing(connect_db()) as connection:
                row = connection.execute(
                    """
                    SELECT file_name, file_data
                    FROM power_board_reports
                    WHERE record_id = ?
                    """,
                    (record_id,),
                ).fetchone()
        if not row:
                abort(404)
        response = send_file(
                BytesIO(row["file_data"]),
                as_attachment=False,
                download_name=row["file_name"],
                mimetype="application/pdf",
                max_age=0,
        )
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @app.delete("/api/records/<int:record_id>/power-board-report")
    @require_login
    @require_csrf
    def delete_power_board_report(record_id):
        with closing(connect_db()) as connection, connection:
                cursor = connection.execute(
                    "DELETE FROM power_board_reports WHERE record_id = ?",
                    (record_id,),
                )
                if cursor.rowcount == 0:
                    abort(404)
        return jsonify(report=None)

    @app.post("/api/records/<int:record_id>/files")
    @require_login
    @require_csrf
    def add_record_file(record_id):
        uploads = [
            upload for upload in request.files.getlist("resultFile")
            if upload and upload.filename
        ]
        if len(uploads) != 1:
            return jsonify(error="試験結果ファイルを1件選択してください。"), 400
        upload = uploads[0]
        content = upload.read(MAX_FILE_SIZE + 1)
        if len(content) > MAX_FILE_SIZE:
            return jsonify(error="添付ファイルは1件あたり100 MB以下にしてください。"), 413
        try:
            parsed_results = parse_trial_results_file(upload.filename, content)
        except ValueError as error:
            return jsonify(error=str(error)), 400

        project_name = parsed_results["metadata"]["品名"].strip()
        product_no = parsed_results["metadata"]["仕様書番号"].strip()
        if validate_text(
            project_name,
            30,
            re.compile(r"[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF0-9A-Za-z\s_-]+"),
            "案件名",
        ):
            return jsonify(error="CSVの品名が案件名の入力規則に一致しません。"), 400
        if validate_text(
            product_no,
            30,
            re.compile(r"[A-Za-z0-9 ._-]+"),
            "製番",
        ):
            return jsonify(error="CSVの仕様書番号が製番の入力規則に一致しません。"), 400

        file_name = upload.filename.replace("\\", "/").rsplit("/", 1)[-1]
        file_name = "".join(char for char in file_name if char.isprintable()).strip()[:255]
        file_name = file_name or "trial-result.csv"
        with closing(connect_db()) as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            if not connection.execute(
                "SELECT id FROM records WHERE id = ?", (record_id,)
            ).fetchone():
                abort(404)
            if connection.execute(
                "SELECT id FROM record_files WHERE record_id = ?", (record_id,)
            ).fetchone():
                return jsonify(error="試験結果ファイルは1件だけ登録できます。"), 409
            connection.execute(
                "UPDATE records SET project_name = ?, product_no = ? WHERE id = ?",
                (project_name, product_no, record_id),
            )
            cursor = connection.execute(
                """
                INSERT INTO record_files (
                    record_id, file_name, file_content_type, file_data
                ) VALUES (?, ?, ?, ?)
                """,
                (record_id, file_name, upload.mimetype or "application/octet-stream", content),
            )
            files = [{"id": cursor.lastrowid, "fileName": file_name}]
        return jsonify(
            files=files,
            projectName=project_name,
            productNo=product_no,
        ), 201

    @app.delete("/api/records/<int:record_id>/files/<int:file_id>")
    @require_login
    @require_csrf
    def delete_record_file(record_id, file_id):
        with closing(connect_db()) as connection, connection:
            cursor = connection.execute(
                "DELETE FROM record_files WHERE record_id = ? AND id = ?",
                (record_id, file_id),
            )
            if cursor.rowcount == 0:
                abort(404)
            files = [
                {"id": row["id"], "fileName": row["file_name"]}
                for row in connection.execute(
                    "SELECT id, file_name FROM record_files WHERE record_id = ? ORDER BY id",
                    (record_id,),
                ).fetchall()
            ]
        return jsonify(files=files)

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

    @app.get("/api/records/<int:record_id>/files/<int:file_id>/results")
    @require_login
    def get_trial_results(record_id, file_id):
        with closing(connect_db()) as connection:
            row = connection.execute(
                "SELECT file_name, file_data FROM record_files WHERE record_id = ? AND id = ?",
                (record_id, file_id),
            ).fetchone()
        if not row:
            abort(404)
        try:
            return jsonify(parse_trial_results_file(row["file_name"], row["file_data"]))
        except ValueError as error:
            return jsonify(error=str(error)), 400

    @app.post("/api/records/<int:record_id>/results-preview")
    @require_login
    @require_csrf
    def preview_trial_results(record_id):
        with closing(connect_db()) as connection:
            if not connection.execute("SELECT id FROM records WHERE id = ?", (record_id,)).fetchone():
                abort(404)
        upload = request.files.get("resultFile")
        if not upload or not upload.filename:
            return jsonify(error="試験結果CSVを選択してください。"), 400
        content = upload.read(MAX_FILE_SIZE + 1)
        if len(content) > MAX_FILE_SIZE:
            return jsonify(error="添付ファイルは1件あたり100 MB以下にしてください。"), 413
        try:
            return jsonify(parse_trial_results_file(upload.filename, content))
        except ValueError as error:
            return jsonify(error=str(error)), 400

    @app.post("/api/trial-results/preview")
    @require_login
    @require_csrf
    def preview_new_trial_results():
        upload = request.files.get("resultFile")
        if not upload or not upload.filename:
            return jsonify(error="試験結果CSVを選択してください。"), 400
        content = upload.read(MAX_FILE_SIZE + 1)
        if len(content) > MAX_FILE_SIZE:
            return jsonify(error="添付ファイルは1件あたり100 MB以下にしてください。"), 413
        try:
            return jsonify(parse_trial_results_file(upload.filename, content))
        except ValueError as error:
            return jsonify(error=str(error)), 400

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
    required = ("LEDGER_SECRET_KEY",)
    missing = [name for name in required if not os.environ.get(name)]
    if missing:
        raise SystemExit("必須の環境変数が設定されていません: " + ", ".join(missing))
    if len(os.environ["LEDGER_SECRET_KEY"]) < 32:
        raise SystemExit("LEDGER_SECRET_KEYは32文字以上のランダムな値を設定してください。")
    username = os.environ.get("LEDGER_USERNAME")
    password_hash = os.environ.get("LEDGER_PASSWORD_HASH")
    if bool(username) != bool(password_hash):
        raise SystemExit(
            "初回管理者を作成する場合はLEDGER_USERNAMEとLEDGER_PASSWORD_HASHの両方を設定してください。"
        )
    if password_hash:
        try:
            check_password_hash(password_hash, "startup-validation")
        except (TypeError, ValueError):
            raise SystemExit("LEDGER_PASSWORD_HASHが無効です。READMEの手順で生成してください。") from None
    app = create_app()
    host = os.environ.get("LEDGER_HOST", "127.0.0.1")
    port = int(os.environ.get("LEDGER_PORT", "8000"))
    serve(app, host=host, port=port)


if __name__ == "__main__":
    main()
