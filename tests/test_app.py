import io
import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from datetime import date
from pathlib import Path
from unittest.mock import patch

from werkzeug.security import generate_password_hash

from backend.app import MAX_FILE_SIZE, MAX_REQUEST_SIZE, create_app
from backend.trial_results import parse_trial_results


SAMPLE_RESULTS_CSV = """品名,PEX32RZ_SAMPLE
仕様書番号,6G3RB652 Rev.4
試験番号,1234567890

試験結果 1
,,,,,温度 1(℃),-20,,,温度 2(℃),25,,,温度 3(℃),70,,
No.,試験名称,下限値,上限値,単位,MIN,判定,MAX,判定,MIN,判定,MAX,判定,MIN,判定,MAX,判定
B5-1-01,"CPU入力, AI00",-122,122,count,-0.01,PASS,0.01,PASS,-0.01,PASS,0.01,PASS,-0.01,PASS,0.01,PASS
B20-1,温湿度センサ,-,-,count,25,,25,,25,,25,,25,,25,

試験結果 2
,,,,温度 1(℃),-20,温度 2(℃),25,温度 3(℃),70
No.,試験名称,規定値,単位,測定値,判定,測定値,判定,測定値,判定
B3-1-01,デジタル入力,00000001,HEX,00000001,PASS,00000001,PASS,00000001,PASS
"""


class TrialResultsCsvTests(unittest.TestCase):
    def test_csv_parses_both_tables_without_changing_values(self):
        result = parse_trial_results(SAMPLE_RESULTS_CSV.encode("utf-8-sig"))
        self.assertEqual(result["metadata"]["品名"], "PEX32RZ_SAMPLE")
        self.assertEqual(result["metadata"]["仕様書番号"], "6G3RB652 Rev.4")
        self.assertEqual(result["metadata"]["試験番号"], "1234567890")
        analog, digital = result["sections"]
        self.assertEqual([item["value"] for item in analog["temperatures"]], ["-20", "25", "70"])
        self.assertEqual(analog["rows"][0]["name"], "CPU入力, AI00")
        self.assertEqual(analog["rows"][0]["measurements"][0]["min"], "-0.01")
        self.assertEqual(analog["summary"], {"PASS": 1, "FAIL": 0, "UNJUDGED": 1})
        self.assertEqual(analog["rows"][1]["lowerLimit"], "-")
        self.assertEqual(analog["rows"][1]["measurements"][0]["minJudgement"], "")
        self.assertEqual(digital["rows"][0]["specifiedValue"], "00000001")
        self.assertEqual(digital["rows"][0]["measurements"][0]["value"], "00000001")

    def test_csv_supports_shift_jis_and_fail_judgements(self):
        content = SAMPLE_RESULTS_CSV.replace("-0.01,PASS", "-0.01,FAIL", 1)
        result = parse_trial_results(content.encode("cp932"))
        self.assertEqual(result["sections"][0]["rows"][0]["judgement"], "FAIL")
        self.assertEqual(result["sections"][0]["summary"]["FAIL"], 1)

    def test_csv_ng_judgements_are_searchable_as_failures(self):
        content = SAMPLE_RESULTS_CSV.replace("-0.01,PASS", "-0.01,NG", 1)
        result = parse_trial_results(content.encode("utf-8"))
        row = result["sections"][0]["rows"][0]
        self.assertEqual(row["measurements"][0]["minJudgement"], "NG")
        self.assertEqual(row["judgement"], "FAIL")
        self.assertEqual(result["sections"][0]["summary"]["FAIL"], 1)

    def test_csv_rejects_invalid_structure(self):
        for text in (
            "品名,サンプル\n", "not csv", SAMPLE_RESULTS_CSV.replace("No.,試験名称", "No.,その他", 1),
            SAMPLE_RESULTS_CSV.replace("B3-1-01,デジタル入力,", "B3-1-01,"),
            SAMPLE_RESULTS_CSV + "試験結果 1\n",
            SAMPLE_RESULTS_CSV.replace('"CPU入力, AI00"', '"CPU入力, AI00'),
        ):
            with self.subTest(text=text[:40]):
                with self.assertRaises(ValueError):
                    parse_trial_results(text.encode("utf-8"))


class LedgerAppTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        equipment_config_path = Path(self.temp_dir.name) / "equipment-config.json"
        equipment_config_path.write_text(
            json.dumps({
                "jumpers": [
                    {"name": "W1", "setting": "1-2"},
                    {"name": "W2", "setting": "1-2"},
                ],
            }),
            encoding="utf-8",
        )
        self.app = create_app(
            {
                "TESTING": True,
                "SECRET_KEY": "test-secret-key",
                "LEDGER_USERNAME": "operator",
                "LEDGER_PASSWORD_HASH": generate_password_hash("correct horse battery"),
                "DATABASE_PATH": str(Path(self.temp_dir.name) / "ledger.sqlite3"),
                "EQUIPMENT_CONFIG_PATH": str(equipment_config_path),
                "SESSION_COOKIE_SECURE": False,
            }
        )
        self.client = self.app.test_client()
        response = self.client.get("/api/session")
        self.csrf_token = response.json["csrfToken"]

    def tearDown(self):
        self.temp_dir.cleanup()

    def login(self):
        response = self.client.post(
            "/api/login",
            json={"username": "operator", "password": "correct horse battery"},
            headers={"X-CSRF-Token": self.csrf_token},
        )
        self.assertEqual(response.status_code, 200)
        self.csrf_token = response.json["csrfToken"]

    def record_data(self, **overrides):
        data = {
            "trialNo": "T-001",
            "projectName": "試験案件",
            "productNo": "A 12345",
            "registrationDate": "20261025",
            "manager": "山田太郎",
        }
        data.update(overrides)
        return data

    def test_homepage_requires_react_build_instead_of_legacy_html(self):
        missing_build = Path(self.temp_dir.name) / "missing-dist"
        self.app.config["FRONTEND_DIST_PATH"] = str(missing_build)

        response = self.client.get("/")

        self.assertEqual(response.status_code, 503)
        self.assertIn("npm run build", response.json["error"])

    def test_homepage_serves_react_build_and_assets(self):
        frontend_dist = Path(self.temp_dir.name) / "dist"
        assets_dir = frontend_dist / "assets"
        assets_dir.mkdir(parents=True)
        (frontend_dist / "index.html").write_text(
            '<script type="module" src="/assets/app.js"></script>',
            encoding="utf-8",
        )
        (assets_dir / "app.js").write_text("React build", encoding="utf-8")
        self.app.config["FRONTEND_DIST_PATH"] = str(frontend_dist)

        page = self.client.get("/")

        self.assertEqual(page.status_code, 200)
        self.assertIn("/assets/app.js", page.get_data(as_text=True))
        page.close()
        asset = self.client.get("/assets/app.js")
        self.assertEqual(asset.status_code, 200)
        self.assertEqual(asset.get_data(as_text=True), "React build")
        asset.close()

    def test_records_require_login_and_login_requires_csrf(self):
        self.assertEqual(self.client.get("/api/records").status_code, 401)
        self.assertEqual(self.client.get("/api/dashboard").status_code, 401)
        response = self.client.post(
            "/api/login",
            json={"username": "operator", "password": "correct horse battery"},
        )
        self.assertEqual(response.status_code, 400)

    def test_register_and_search_shared_sqlite_records(self):
        self.login()
        response = self.client.post(
            "/api/records",
            data=self.record_data(),
            headers={"X-CSRF-Token": self.csrf_token},
        )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(len(self.client.get("/api/records").json), 1)
        self.assertEqual(
            len(self.client.get("/api/records?trialNo=T-*").json),
            1,
        )
        self.assertEqual(
            len(self.client.get("/api/records?trialNo=NO-MATCH").json),
            0,
        )
        second_client = self.app.test_client()
        second_csrf = second_client.get("/api/session").json["csrfToken"]
        login_response = second_client.post(
            "/api/login",
            json={"username": "operator", "password": "correct horse battery"},
            headers={"X-CSRF-Token": second_csrf},
        )
        self.assertEqual(login_response.status_code, 200)
        self.assertEqual(len(second_client.get("/api/records").json), 1)

    def test_batch_registration_creates_all_records(self):
        self.login()
        submissions = [
            self.record_data(trialNo="T-001", productNo="A 12345"),
            self.record_data(trialNo="T-002", productNo="B 67890"),
        ]

        response = self.client.post(
            "/api/records/batch",
            json=submissions,
            headers={"X-CSRF-Token": self.csrf_token},
        )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(
            [record["trialNo"] for record in response.json["records"]],
            ["T-001", "T-002"],
        )
        self.assertEqual(
            [record["trialNo"] for record in self.client.get("/api/records").json],
            ["T-002", "T-001"],
        )

    def test_batch_registration_saves_each_csv_with_its_record(self):
        self.login()
        submissions = [
            self.record_data(trialNo="T-001"),
            self.record_data(trialNo="T-002"),
        ]

        response = self.client.post(
            "/api/records/batch",
            data={
                "submissions": json.dumps(submissions),
                "resultFiles-0": (io.BytesIO(SAMPLE_RESULTS_CSV.encode("utf-8")), "first.csv"),
                "resultFiles-1": (io.BytesIO(SAMPLE_RESULTS_CSV.encode("utf-8")), "second.csv"),
            },
            headers={"X-CSRF-Token": self.csrf_token},
        )

        self.assertEqual(response.status_code, 201)
        records = response.json["records"]
        self.assertEqual([record["files"][0]["fileName"] for record in records], ["first.csv", "second.csv"])
        for record in records:
            file_id = record["files"][0]["id"]
            results = self.client.get(
                f"/api/records/{record['id']}/files/{file_id}/results"
            )
            self.assertEqual(results.status_code, 200)
            self.assertEqual(
                [section["title"] for section in results.json["sections"]],
                ["試験結果 1", "試験結果 2"],
            )

    def test_batch_registration_rejects_invalid_csv_without_creating_records(self):
        self.login()
        submissions = [
            self.record_data(trialNo="T-001"),
            self.record_data(trialNo="T-002"),
        ]

        response = self.client.post(
            "/api/records/batch",
            data={
                "submissions": json.dumps(submissions),
                "resultFiles-0": (io.BytesIO(SAMPLE_RESULTS_CSV.encode("utf-8")), "valid.csv"),
                "resultFiles-1": (io.BytesIO(b"not a trial results file"), "invalid.csv"),
            },
            headers={"X-CSRF-Token": self.csrf_token},
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("2件目", response.json["error"])
        self.assertEqual(self.client.get("/api/records").json, [])

    def test_batch_registration_rejects_all_records_if_one_is_invalid(self):
        self.login()
        submissions = [
            self.record_data(trialNo="T-001"),
            self.record_data(trialNo="invalid number"),
        ]

        response = self.client.post(
            "/api/records/batch",
            json=submissions,
            headers={"X-CSRF-Token": self.csrf_token},
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("2件目", response.json["error"])
        self.assertEqual(self.client.get("/api/records").json, [])

    def test_search_by_project_name(self):
        self.login()
        for trial_no, project_name in (
            ("T-001", "制御試験案件"),
            ("T-002", "制御確認案件"),
            ("T-003", "Project-Alpha"),
            ("T-004", ""),
        ):
            response = self.client.post(
                "/api/records",
                data=self.record_data(trialNo=trial_no, projectName=project_name),
                headers={"X-CSRF-Token": self.csrf_token},
            )
            self.assertEqual(response.status_code, 201)
        for filters, expected_trial_nos in (
            ({"projectName": "制御"}, ["T-002", "T-001"]),
            ({"projectName": "制御*試験"}, ["T-001"]),
            ({"projectName": "project-alpha"}, ["T-003"]),
            ({"projectName": "制御", "trialNo": "T-002"}, ["T-002"]),
            ({"projectName": "制御", "productNo": "NO-MATCH"}, []),
            ({"projectName": "不存在"}, []),
            ({"projectName": " "}, ["T-004", "T-003", "T-002", "T-001"]),
        ):
            with self.subTest(filters=filters):
                response = self.client.get("/api/records", query_string=filters)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(
                    [record["trialNo"] for record in response.json], expected_trial_nos,
                )
        self.assertEqual(
            self.client.get("/api/records", query_string={"projectName": "案" * 30}).status_code,
            200,
        )
        response = self.client.get("/api/records", query_string={"projectName": "案" * 31})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json["error"], "検索条件が長すぎます。")

    def test_minimal_registration_and_later_details_update(self):
        self.login()
        response = self.client.post(
            "/api/records",
            data={
                "trialNo": "T-MINIMAL",
                "registrationDate": date.today().strftime("%Y%m%d"),
                "manager": "山田太郎",
            },
            headers={"X-CSRF-Token": self.csrf_token},
        )
        self.assertEqual(response.status_code, 201)
        record_id = response.json["id"]
        record = self.client.get("/api/records").json[0]
        self.assertEqual(record["id"], record_id)
        self.assertEqual(record["trialNo"], "T-MINIMAL")
        self.assertEqual(record["manager"], "山田太郎")
        self.assertEqual(record["projectName"], "")
        self.assertEqual(record["productNo"], "")
        self.assertEqual(record["registrationDate"], date.today().strftime("%Y%m%d"))
        self.assertEqual(record["files"], [])
        response = self.client.put(
            f"/api/records/{record_id}",
            data=self.record_data(
                trialNo="T-MINIMAL", projectName="", productNo="",
                resultFiles=(io.BytesIO(b"test result"), "result.txt"),
            ),
            headers={"X-CSRF-Token": self.csrf_token},
        )
        self.assertEqual(response.status_code, 200)
        record = self.client.get("/api/records").json[0]
        self.assertEqual(record["files"][0]["fileName"], "result.txt")
        response = self.client.put(
            f"/api/records/{record_id}",
            data=self.record_data(trialNo="T-MINIMAL"),
            headers={"X-CSRF-Token": self.csrf_token},
        )
        self.assertEqual(response.status_code, 200)
        record = self.client.get("/api/records").json[0]
        self.assertEqual(record["projectName"], "試験案件")
        self.assertEqual(record["productNo"], "A 12345")
        self.assertEqual(record["files"][0]["fileName"], "result.txt")

    def test_minimal_registration_still_validates_input(self):
        self.login()
        for data in (
            {"trialNo": "", "manager": "山田太郎"},
            {"trialNo": "T-MINIMAL", "manager": "山田太郎"},
            {"trialNo": "試験番号", "manager": "山田太郎"},
            {"trialNo": "T-MINIMAL", "manager": ""},
            {"trialNo": "T-MINIMAL", "manager": "operator"},
            {"trialNo": "T-MINIMAL", "manager": "山田太郎", "projectName": "!"},
            {"trialNo": "T-MINIMAL", "manager": "山田太郎", "productNo": "製番"},
            {"trialNo": "T-MINIMAL", "manager": "山田太郎", "registrationDate": "20260230"},
        ):
            with self.subTest(data=data):
                response = self.client.post(
                    "/api/records", data=data,
                    headers={"X-CSRF-Token": self.csrf_token},
                )
                self.assertEqual(response.status_code, 400)
        self.assertEqual(self.client.get("/api/records").json, [])

    def test_jumper_checks_persist_and_are_independent(self):
        self.login()
        record_ids = [self.client.post(
            "/api/records", data=self.record_data(),
            headers={"X-CSRF-Token": self.csrf_token},
        ).json["id"] for _ in range(2)]
        url = f"/api/records/{record_ids[0]}/jumpers"
        initial = self.client.get(url).json
        self.assertEqual(initial, [
            {"name": "W1", "setting": "1-2", "confirmed": False},
            {"name": "W2", "setting": "1-2", "confirmed": False},
        ])
        saved = self.client.put(
            f"{url}/W1", json={"confirmed": True},
            headers={"X-CSRF-Token": self.csrf_token},
        )
        self.assertEqual(saved.status_code, 200)
        restarted = create_app(dict(self.app.config)).test_client()
        with restarted.session_transaction() as session:
            session["username"] = "operator"
        checks = restarted.get(url).json
        self.assertTrue(checks[0]["confirmed"])
        self.assertFalse(checks[1]["confirmed"])
        self.assertEqual(
            self.client.get(f"/api/records/{record_ids[1]}/jumpers").json, initial,
        )
        self.client.put(
            f"{url}/W1", json={"confirmed": False},
            headers={"X-CSRF-Token": self.csrf_token},
        )
        self.assertEqual(self.client.get(url).json, initial)
        self.client.delete(
            f"/api/records/{record_ids[0]}",
            headers={"X-CSRF-Token": self.csrf_token},
        )
        with closing(sqlite3.connect(self.app.config["DATABASE_PATH"])) as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM jumper_checks").fetchone()[0], 0)

    def test_jumper_config_controls_rows_and_setting_changes_reset_confirmation(self):
        self.login()
        record_id = self.client.post(
            "/api/records", data=self.record_data(),
            headers={"X-CSRF-Token": self.csrf_token},
        ).json["id"]
        config_path = Path(self.temp_dir.name) / "custom-jumpers.json"
        jumpers = [
            {"name": "JP-1", "setting": "2-3"},
            {"name": "BOOT", "setting": "OPEN"},
            {"name": "MODE", "setting": "LOW"},
        ]
        config_path.write_text(json.dumps({"jumpers": jumpers}), encoding="utf-8")
        configured_app = create_app({
            "TESTING": True,
            "SECRET_KEY": "test-secret-key",
            "LEDGER_USERNAME": "operator",
            "LEDGER_PASSWORD_HASH": generate_password_hash("correct horse battery"),
            "DATABASE_PATH": self.app.config["DATABASE_PATH"],
            "EQUIPMENT_CONFIG_PATH": str(config_path),
            "SESSION_COOKIE_SECURE": False,
        })
        configured_client = configured_app.test_client()
        with configured_client.session_transaction() as session:
            session["username"] = "operator"
        configured_csrf_token = configured_client.get("/api/session").json["csrfToken"]

        url = f"/api/records/{record_id}/jumpers"
        checks = configured_client.get(url).json
        self.assertEqual(
            checks,
            [{**jumper, "confirmed": False} for jumper in jumpers],
        )
        response = configured_client.put(
            f"{url}/JP-1", json={"confirmed": True},
            headers={"X-CSRF-Token": configured_csrf_token},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json, {**jumpers[0], "confirmed": True})
        equipment = configured_client.get(f"/api/records/{record_id}/equipment").json
        details_response = configured_client.put(
            f"/api/records/{record_id}/details",
            data=self.record_data(
                equipment=json.dumps(equipment),
                jumperChecks=json.dumps({
                    "JP-1": True,
                    "BOOT": False,
                    "MODE": False,
                }),
            ),
            headers={"X-CSRF-Token": configured_csrf_token},
        )
        self.assertEqual(details_response.status_code, 200, details_response.json)

        changed_jumpers = [dict(jumpers[0], setting="3-4")]
        config_path.write_text(json.dumps({"jumpers": changed_jumpers}), encoding="utf-8")
        changed_app = create_app({
            **dict(self.app.config),
            "EQUIPMENT_CONFIG_PATH": str(config_path),
        }).test_client()
        with changed_app.session_transaction() as session:
            session["username"] = "operator"
        self.assertEqual(
            changed_app.get(url).json,
            [{**changed_jumpers[0], "confirmed": False}],
        )

    def test_legacy_jumper_table_migrates_without_losing_confirmation(self):
        self.login()
        record_id = self.client.post(
            "/api/records", data=self.record_data(),
            headers={"X-CSRF-Token": self.csrf_token},
        ).json["id"]
        with closing(sqlite3.connect(self.app.config["DATABASE_PATH"])) as connection:
            connection.execute("DROP TABLE jumper_checks")
            connection.execute(
                """
                CREATE TABLE jumper_checks (
                    record_id INTEGER NOT NULL REFERENCES records(id) ON DELETE CASCADE,
                    jumper_name TEXT NOT NULL CHECK (jumper_name IN ('W1', 'W2')),
                    confirmed INTEGER NOT NULL CHECK (confirmed IN (0, 1)),
                    PRIMARY KEY (record_id, jumper_name)
                )
                """
            )
            connection.executemany(
                "INSERT INTO jumper_checks (record_id, jumper_name, confirmed) VALUES (?, ?, ?)",
                [(record_id, "W1", 1), (record_id, "W2", 0)],
            )
            connection.commit()

        migrated_client = create_app(dict(self.app.config)).test_client()
        with migrated_client.session_transaction() as session:
            session["username"] = "operator"
        self.assertEqual(
            migrated_client.get(f"/api/records/{record_id}/jumpers").json,
            [
                {"name": "W1", "setting": "1-2", "confirmed": True},
                {"name": "W2", "setting": "1-2", "confirmed": False},
            ],
        )
        with closing(sqlite3.connect(self.app.config["DATABASE_PATH"])) as connection:
            columns = {row[1] for row in connection.execute("PRAGMA table_info(jumper_checks)")}
            schema = connection.execute(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'jumper_checks'"
            ).fetchone()[0]
        self.assertIn("setting", columns)
        self.assertNotIn("W1', 'W2", schema)

    def test_empty_jumper_config_returns_no_rows_and_saves_empty_checks(self):
        self.login()
        record_id = self.client.post(
            "/api/records", data=self.record_data(),
            headers={"X-CSRF-Token": self.csrf_token},
        ).json["id"]
        config_path = Path(self.temp_dir.name) / "no-jumpers.json"
        config_path.write_text(json.dumps({"jumpers": []}), encoding="utf-8")
        configured_client = create_app({
            **dict(self.app.config),
            "EQUIPMENT_CONFIG_PATH": str(config_path),
        }).test_client()
        with configured_client.session_transaction() as session:
            session["username"] = "operator"
        configured_csrf_token = configured_client.get("/api/session").json["csrfToken"]
        self.assertEqual(configured_client.get(f"/api/records/{record_id}/jumpers").json, [])
        equipment = configured_client.get(f"/api/records/{record_id}/equipment").json
        response = configured_client.put(
            f"/api/records/{record_id}/details",
            data=self.record_data(
                equipment=json.dumps(equipment),
                jumperChecks=json.dumps({}),
            ),
            headers={"X-CSRF-Token": configured_csrf_token},
        )
        self.assertEqual(response.status_code, 200, response.json)

    def test_jumper_checks_require_login_csrf_and_valid_input(self):
        self.assertEqual(self.client.get("/api/records/1/jumpers").status_code, 401)
        self.assertEqual(self.client.put("/api/records/1/jumpers/W1", json={"confirmed": True}).status_code, 401)
        self.login()
        record_id = self.client.post(
            "/api/records", data=self.record_data(),
            headers={"X-CSRF-Token": self.csrf_token},
        ).json["id"]
        url = f"/api/records/{record_id}/jumpers"
        self.assertEqual(self.client.put(f"{url}/W1", json={"confirmed": True}).status_code, 400)
        for payload in ({}, {"confirmed": "true"}, {"confirmed": 1}, []):
            response = self.client.put(
                f"{url}/W1", json=payload,
                headers={"X-CSRF-Token": self.csrf_token},
            )
            self.assertEqual(response.status_code, 400)
        self.assertEqual(self.client.put(
            f"{url}/W3", json={"confirmed": True},
            headers={"X-CSRF-Token": self.csrf_token},
        ).status_code, 404)
        self.assertEqual(self.client.get("/api/records/99999/jumpers").status_code, 404)
        self.assertEqual(self.client.put(
            "/api/records/99999/jumpers/W1", json={"confirmed": True},
            headers={"X-CSRF-Token": self.csrf_token},
        ).status_code, 404)

    def test_equipment_defaults_and_persistence(self):
        self.login()
        record_ids = [self.client.post(
            "/api/records", data=self.record_data(),
            headers={"X-CSRF-Token": self.csrf_token},
        ).json["id"] for _ in range(2)]
        url = f"/api/records/{record_ids[0]}/equipment"
        equipment = self.client.get(url).json
        self.assertEqual(equipment["boards"], self.app.config["BOARD_DEFAULTS"])
        self.assertEqual(equipment["instruments"], [
            {"name": "", "managementNo": "", "testItems": ""} for _ in range(5)
        ])
        self.assertEqual(equipment["software"], [
            {"name": "テストプロ", "sdFormat": "TEST0306", "version": "", "checksum": ""},
            {"name": "PWM85 基板 FPGA", "sdFormat": "XPLD0885", "version": "", "checksum": ""},
            {"name": "INF267 基板 FPGA", "sdFormat": "XPLD0856", "version": "", "checksum": ""},
        ])
        equipment["boards"][0]["serialNumber"] = "251100020A"
        equipment["instruments"][0] = {"name": "オシロスコープ", "managementNo": "AA00432", "testItems": "B9, B10"}
        equipment["software"][0].update(version="9055", checksum="CB2FA46")
        self.assertEqual(equipment["shippingSoftware"], [
            {"name": "", "sdFormat": "", "version": "", "checksum": ""},
        ])
        self.assertIs(equipment["shippingSoftwareSameAsTrial"], False)
        equipment["shippingSoftwareSameAsTrial"] = True
        equipment["shippingSoftware"][0].update(
            name="出荷アプリ", sdFormat="SHIP001", version="SHIP-1", checksum="123ABC",
        )
        response = self.client.put(url, json=equipment, headers={"X-CSRF-Token": self.csrf_token})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json, equipment)
        restarted = create_app(dict(self.app.config)).test_client()
        with restarted.session_transaction() as session:
            session["username"] = "operator"
        self.assertEqual(restarted.get(url).json, equipment)
        self.assertIs(
            self.client.get(f"/api/records/{record_ids[1]}/equipment").json["shippingSoftwareSameAsTrial"],
            False,
        )
        self.assertEqual(
            self.client.get(f"/api/records/{record_ids[1]}/equipment").json["shippingSoftware"],
            [{"name": "", "sdFormat": "", "version": "", "checksum": ""}],
        )
        equipment["shippingSoftware"][0] = {
            "name": "", "sdFormat": "", "version": "", "checksum": "",
        }
        equipment["shippingSoftwareSameAsTrial"] = False
        self.assertEqual(self.client.get(f"/api/records/{record_ids[1]}/equipment").json["boards"][0]["serialNumber"], "")
        equipment["boards"][0]["serialNumber"] = ""
        self.assertEqual(self.client.put(url, json=equipment, headers={"X-CSRF-Token": self.csrf_token}).status_code, 200)
        self.assertEqual(self.client.get(url).json["boards"][0]["serialNumber"], "")
        self.assertEqual(self.client.get(url).json["shippingSoftware"], equipment["shippingSoftware"])
        self.assertIs(self.client.get(url).json["shippingSoftwareSameAsTrial"], False)
        self.client.delete(f"/api/records/{record_ids[0]}", headers={"X-CSRF-Token": self.csrf_token})
        with closing(sqlite3.connect(self.app.config["DATABASE_PATH"])) as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM record_equipment").fetchone()[0], 0)

    def test_equipment_pads_legacy_three_instrument_rows(self):
        self.login()
        record_id = self.client.post(
            "/api/records", data=self.record_data(),
            headers={"X-CSRF-Token": self.csrf_token},
        ).json["id"]
        url = f"/api/records/{record_id}/equipment"
        legacy = self.client.get(url).json
        del legacy["shippingSoftware"]
        del legacy["shippingSoftwareSameAsTrial"]
        legacy["software"][0]["version"] = "LEGACY"
        legacy["instruments"] = [
            {"name": "計測器", "managementNo": "管理番号", "testItems": "試験項目"}
            for _ in range(3)
        ]
        legacy["boards"] = [
            {"name": row["name"], "serialNumber": row["serialNumber"]}
            for row in legacy["boards"]
        ]
        with closing(sqlite3.connect(self.app.config["DATABASE_PATH"])) as connection:
            connection.execute(
                "INSERT INTO record_equipment (record_id, payload) VALUES (?, ?)",
                (record_id, json.dumps(legacy)),
            )
            connection.commit()

        expanded = self.client.get(url).json
        self.assertIs(expanded["shippingSoftwareSameAsTrial"], False)
        self.assertEqual(expanded["software"][0]["version"], "LEGACY")
        self.assertTrue(all(
            row["version"] == row["checksum"] == ""
            for row in expanded["shippingSoftware"]
        ))
        self.assertEqual(expanded["instruments"][:3], legacy["instruments"])
        self.assertEqual(expanded["boards"], legacy["boards"])
        self.assertEqual(expanded["instruments"][3:], [
            {"name": "", "managementNo": "", "testItems": ""} for _ in range(2)
        ])

        response = self.client.put(
            url, json={
                **legacy, "shippingSoftware": expanded["shippingSoftware"],
                "shippingSoftwareSameAsTrial": expanded["shippingSoftwareSameAsTrial"],
            },
            headers={"X-CSRF-Token": self.csrf_token},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json, expanded)

    def test_shipping_software_preserves_legacy_values_when_name_and_format_change(self):
        self.login()
        record_id = self.client.post(
            "/api/records", data=self.record_data(),
            headers={"X-CSRF-Token": self.csrf_token},
        ).json["id"]
        url = f"/api/records/{record_id}/equipment"
        legacy = self.client.get(url).json
        legacy["shippingSoftwareCopiedFromAcceptance"] = True
        legacy["softwareSameAsShipping"] = False
        legacy["shippingSoftware"] = [
            {
                "name": "アプリソフト", "sdFormat": "TEST0306",
                "configName": "出荷ソフト", "configSdFormat": "TEST0306",
                "version": "1.2", "checksum": "ABC",
            },
            {"name": "PWM85 基板 FPGA", "sdFormat": "XPLD0921", "version": "PLD1", "checksum": "DEF"},
            {"name": "INF267 基板 FPGA", "sdFormat": "XPLD0856", "version": "PLD2", "checksum": "123"},
        ]
        with closing(sqlite3.connect(self.app.config["DATABASE_PATH"])) as connection:
            connection.execute(
                "INSERT INTO record_equipment (record_id, payload) VALUES (?, ?)",
                (record_id, json.dumps(legacy)),
            )
            connection.commit()

        loaded = self.client.get(url).json
        self.assertEqual(set(loaded), {
            "boards", "instruments", "software", "shippingSoftware", "shippingSoftwareSameAsTrial",
        })
        self.assertEqual(loaded["shippingSoftware"], [{
            "name": "アプリソフト", "sdFormat": "TEST0306", "version": "1.2", "checksum": "ABC",
        }])
        loaded["shippingSoftware"][0].update(name="新しい出荷ソフト", sdFormat="NEW001")
        saved = self.client.put(url, json=loaded, headers={"X-CSRF-Token": self.csrf_token})
        self.assertEqual(saved.status_code, 200)
        self.assertEqual(self.client.get(url).json, loaded)
        self.assertEqual(loaded["shippingSoftware"][0]["version"], "1.2")
        self.assertEqual(loaded["shippingSoftware"][0]["checksum"], "ABC")

    def test_equipment_omits_removed_board_fields_from_stored_records(self):
        self.login()
        record_id = self.client.post(
            "/api/records", data=self.record_data(),
            headers={"X-CSRF-Token": self.csrf_token},
        ).json["id"]
        url = f"/api/records/{record_id}/equipment"
        equipment = self.client.get(url).json
        equipment["boards"][0]["serialNumber"] = "SERIAL-001"
        legacy = json.loads(json.dumps(equipment))
        for board in legacy["boards"]:
            board.update(revision="R1", nega="N1")
        with closing(sqlite3.connect(self.app.config["DATABASE_PATH"])) as connection:
            connection.execute(
                "INSERT INTO record_equipment (record_id, payload) VALUES (?, ?)",
                (record_id, json.dumps(legacy)),
            )
            connection.commit()

        loaded = self.client.get(url).json
        self.assertEqual(loaded, equipment)
        self.assertTrue(all(row.keys() == {"name", "serialNumber"} for row in loaded["boards"]))
        response = self.client.put(
            url, json=loaded, headers={"X-CSRF-Token": self.csrf_token},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.client.get(url).json, equipment)

    def test_instrument_choices_are_loaded_from_json(self):
        self.login()
        record_id = self.client.post(
            "/api/records", data=self.record_data(),
            headers={"X-CSRF-Token": self.csrf_token},
        ).json["id"]
        config_path = Path(self.temp_dir.name) / "equipment-config.json"
        choices = [{"name": "カスタム試験器", "managementNo": "CUSTOM-01"}]
        managers = ["カスタム担当者", "別の担当者"]
        boards = [
            {"name": f"CUSTOM-{index}", "serialNumber": "SERIAL"}
            for index in range(3)
        ]
        config_path.write_text(
            json.dumps({
                "managerChoices": managers,
                "instrumentChoices": choices,
                "boards": boards,
            }),
            encoding="utf-8",
        )
        configured_app = create_app({
            "TESTING": True,
            "SECRET_KEY": "test-secret-key",
            "LEDGER_USERNAME": "operator",
            "LEDGER_PASSWORD_HASH": generate_password_hash("correct horse battery"),
            "DATABASE_PATH": self.app.config["DATABASE_PATH"],
            "EQUIPMENT_CONFIG_PATH": str(config_path),
            "SESSION_COOKIE_SECURE": False,
        })
        configured_client = configured_app.test_client()
        with configured_client.session_transaction() as session:
            session["username"] = "operator"

        self.assertEqual(
            configured_client.get("/api/equipment-config").json,
            {
                "instrumentChoices": choices,
                "managerChoices": managers,
                "manualTests": [],
                "softwareSections": self.app.config["SOFTWARE_SECTIONS"],
            },
        )
        equipment = configured_client.get(f"/api/records/{record_id}/equipment").json
        self.assertEqual(len(equipment["instruments"]), 5)
        self.assertEqual(equipment["boards"], boards)

    def test_equipment_config_rejects_invalid_manager_choices(self):
        config_path = Path(self.temp_dir.name) / "invalid-manager-choices.json"
        for managers in (["担当者", "担当者"], ["operator"], ["名" * 31]):
            with self.subTest(managers=managers):
                config_path.write_text(
                    json.dumps({"managerChoices": managers}), encoding="utf-8",
                )
                with self.assertRaisesRegex(ValueError, "managerChoices"):
                    create_app({
                        "TESTING": True,
                        "EQUIPMENT_CONFIG_PATH": str(config_path),
                        "DATABASE_PATH": str(Path(self.temp_dir.name) / "invalid-managers.sqlite3"),
                    })

    def test_equipment_config_rejects_more_than_fifty_boards(self):
        config_path = Path(self.temp_dir.name) / "too-many-boards.json"
        boards = [
            {"name": f"BOARD-{index}", "serialNumber": ""}
            for index in range(51)
        ]
        config_path.write_text(json.dumps({"boards": boards}), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "boards"):
            create_app({
                "TESTING": True,
                "EQUIPMENT_CONFIG_PATH": str(config_path),
                "DATABASE_PATH": str(Path(self.temp_dir.name) / "too-many-boards.sqlite3"),
            })

    def test_equipment_config_rejects_invalid_jumpers(self):
        config_path = Path(self.temp_dir.name) / "invalid-jumpers.json"
        invalid_configs = (
            [{"name": "J1", "setting": "1-2"}, {"name": "J1", "setting": "2-3"}],
            [{"name": "J1", "setting": ""}],
            [{"name": "J1"}],
            [{"name": f"J{index}", "setting": "1-2"} for index in range(51)],
        )
        for jumpers in invalid_configs:
            with self.subTest(jumpers=jumpers):
                config_path.write_text(
                    json.dumps({"jumpers": jumpers}), encoding="utf-8",
                )
                with self.assertRaisesRegex(ValueError, "jumpers"):
                    create_app({
                        "TESTING": True,
                        "EQUIPMENT_CONFIG_PATH": str(config_path),
                        "DATABASE_PATH": str(Path(self.temp_dir.name) / "invalid-jumpers.sqlite3"),
                    })

    def test_equipment_config_rejects_invalid_choices(self):
        config_path = Path(self.temp_dir.name) / "invalid-equipment-config.json"
        config_path.write_text(json.dumps({"instrumentChoices": [{"name": "重複なし管理番号なし"}]}), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "instrumentChoices"):
            create_app({
                "TESTING": True,
                "EQUIPMENT_CONFIG_PATH": str(config_path),
                "DATABASE_PATH": str(Path(self.temp_dir.name) / "invalid.sqlite3"),
            })

    def test_software_sections_are_configurable_and_preserve_matching_values(self):
        self.login()
        record_id = self.client.post(
            "/api/records", data=self.record_data(),
            headers={"X-CSRF-Token": self.csrf_token},
        ).json["id"]
        software_sections = [{
            "key": "firmware",
            "title": "ファームウェア",
            "rows": [
                {"name": "制御ソフト", "sdFormat": "CTRL001"},
                {"name": "追加PLD", "sdFormat": "PLD002"},
            ],
        }]
        config_path = Path(self.temp_dir.name) / "software-sections.json"
        config_path.write_text(
            json.dumps({
                "jumpers": self.app.config["JUMPERS"],
                "softwareSections": software_sections,
                "shippingSoftwareSections": [{
                    "key": "legacy-shipping", "title": "旧設定",
                    "rows": [{"name": "旧ソフト", "sdFormat": "OLD001"}],
                }],
            }),
            encoding="utf-8",
        )
        configured_app = create_app({
            **self.app.config,
            "EQUIPMENT_CONFIG_PATH": str(config_path),
        })
        configured_client = configured_app.test_client()
        with configured_client.session_transaction() as session:
            session["username"] = "operator"

        url = f"/api/records/{record_id}/equipment"
        equipment = configured_client.get(url).json
        self.assertEqual(equipment["software"], [
            {
                "name": "制御ソフト", "sdFormat": "CTRL001",
                "version": "", "checksum": "",
            },
            {
                "name": "追加PLD", "sdFormat": "PLD002",
                "version": "", "checksum": "",
            },
        ])
        equipment["software"][0]["version"] = "1.2.3"
        equipment["software"][0]["checksum"] = "ABC123"
        self.assertEqual(equipment["shippingSoftware"], [{
            "name": "", "sdFormat": "", "version": "", "checksum": "",
        }])
        equipment["shippingSoftware"][0].update(
            name="出荷ソフト", sdFormat="USER001", version="2.0", checksum="DEF456",
        )
        csrf = configured_client.get("/api/session").json["csrfToken"]
        response = configured_client.put(
            url,
            json=equipment,
            headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            configured_client.get(url).json["software"][0]["version"],
            "1.2.3",
        )
        self.assertEqual(
            configured_client.get("/api/equipment-config").json["softwareSections"],
            software_sections,
        )
        self.assertNotIn("shippingSoftwareSections", configured_client.get("/api/equipment-config").json)
        self.assertEqual(configured_client.get(url).json, equipment)

    def test_manual_tests_are_configured_judged_and_saved(self):
        self.login()
        record_id = self.client.post(
            "/api/records", data=self.record_data(),
            headers={"X-CSRF-Token": self.csrf_token},
        ).json["id"]
        manual_tests = [{
            "key": "power",
            "number": "1",
            "name": "電源確認",
            "area": "PWS132",
            "items": [{
                "key": "voltage",
                "name": "P24A1",
                "lowerLimit": 23.52,
                "upperLimit": 24.48,
                "unit": "V",
                "benchLock": True,
            }],
        }]
        config_path = Path(self.temp_dir.name) / "manual-tests.json"
        config_path.write_text(json.dumps({
            "jumpers": self.app.config["JUMPERS"],
            "manualTests": manual_tests,
        }), encoding="utf-8")
        configured_app = create_app({
            **self.app.config,
            "EQUIPMENT_CONFIG_PATH": str(config_path),
        })
        configured_client = configured_app.test_client()
        with configured_client.session_transaction() as session:
            session["username"] = "operator"

        url = f"/api/records/{record_id}/manual-tests"
        initial = configured_client.get(url).json
        self.assertEqual(initial[0]["items"][0]["measuredValue"], "")
        self.assertEqual(initial[0]["items"][0]["judgement"], "")
        condition_url = f"/api/records/{record_id}/manual-test-conditions"
        self.assertEqual(
            configured_client.get(condition_url).json,
            {"temperature": "", "humidity": ""},
        )

        equipment = configured_client.get(f"/api/records/{record_id}/equipment").json
        appearance = configured_client.get(
            f"/api/records/{record_id}/appearance-checks"
        ).json
        insertion_keys = configured_client.get(
            f"/api/records/{record_id}/insertion-keys"
        ).json
        jumper_checks = {
            jumper["name"]: jumper["confirmed"]
            for jumper in configured_client.get(
                f"/api/records/{record_id}/jumpers"
            ).json
        }
        csrf = configured_client.get("/api/session").json["csrfToken"]
        response = configured_client.put(
            f"/api/records/{record_id}/details",
            data=self.record_data(
                equipment=json.dumps(equipment),
                jumperChecks=json.dumps(jumper_checks),
                appearanceChecks=json.dumps(appearance["checks"]),
                insertionKeyChecks=json.dumps({
            item["name"]: item["confirmed"] for item in insertion_keys
                }),
                manualTestResults=json.dumps({
            "voltage": {
                "measuredValue": "24.00",
                "benchLockChecked": True,
            },
                }),
                manualTestConditions=json.dumps({
            "temperature": "23.0",
            "humidity": "45",
                }),
            ),
            headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(response.status_code, 200)
        saved = configured_client.get(url).json[0]["items"][0]
        self.assertEqual(saved["measuredValue"], "24.00")
        self.assertEqual(saved["judgement"], "PASS")
        self.assertTrue(saved["benchLockChecked"])
        self.assertEqual(
            configured_client.get(condition_url).json,
            {"temperature": "23.0", "humidity": "45"},
        )

        manual_tests[0]["items"][0]["upperLimit"] = 23.90
        config_path.write_text(json.dumps({
            "jumpers": self.app.config["JUMPERS"],
            "manualTests": manual_tests,
        }), encoding="utf-8")
        restarted = create_app({
            **self.app.config,
            "EQUIPMENT_CONFIG_PATH": str(config_path),
        }).test_client()
        with restarted.session_transaction() as session:
            session["username"] = "operator"
        changed = restarted.get(url).json[0]["items"][0]
        self.assertEqual(changed["measuredValue"], "")
        self.assertEqual(changed["judgement"], "")
        self.assertFalse(changed["benchLockChecked"])

    def test_appearance_config_adds_rows_and_preserves_only_matching_checks(self):
        self.login()
        record_id = self.client.post(
            "/api/records", data=self.record_data(),
            headers={"X-CSRF-Token": self.csrf_token},
        ).json["id"]
        url = f"/api/records/{record_id}/appearance-checks"
        appearance = self.client.get(url).json
        checks = appearance.pop("checks")
        equipment = self.client.get(f"/api/records/{record_id}/equipment").json
        checks["boardRevision:PWS132"] = True
        checks["sdCard:PWM85"] = True
        data = self.record_data(
            equipment=json.dumps(equipment),
            jumperChecks=json.dumps({"W1": False, "W2": False}),
            appearanceChecks=json.dumps(checks),
        )
        self.assertEqual(self.client.put(
            f"/api/records/{record_id}/details", data=data,
            headers={"X-CSRF-Token": self.csrf_token},
        ).status_code, 200)

        appearance["boardGroups"].append({"name": "AUX", "boards": ["AUX"]})
        appearance["items"][0]["values"]["PWS132"] = "B"
        appearance["items"][4]["rows"] = 2
        appearance["items"] = appearance["items"][4:] + appearance["items"][:4]
        appearance["items"].extend([
            {"key": "seal", "name": "封印確認", "rows": 1, "values": {"AUX": "OK"}},
            {"key": "packing", "name": "梱包確認", "rows": 2, "values": {"AUX": ""}},
        ])
        config_path = Path(self.app.config["EQUIPMENT_CONFIG_PATH"])
        config_path.write_text(json.dumps({
            "jumpers": self.app.config["JUMPERS"], "appearanceInspection": appearance,
        }), encoding="utf-8")
        configured_app = create_app(dict(self.app.config))
        client = configured_app.test_client()
        with client.session_transaction() as session:
            session["username"] = "operator"
        loaded = client.get(url).json
        self.assertEqual(loaded["boardGroups"], appearance["boardGroups"])
        self.assertEqual(loaded["items"], appearance["items"])
        self.assertFalse(loaded["checks"]["boardRevision:PWS132"])
        self.assertTrue(loaded["checks"]["sdCard:PWM85"])
        self.assertFalse(loaded["checks"]["seal:AUX"])
        self.assertFalse(loaded["checks"]["packing:AUX"])
        loaded["checks"]["seal:AUX"] = True
        data["appearanceChecks"] = json.dumps(loaded["checks"])
        csrf = client.get("/api/session").json["csrfToken"]
        response = client.put(
            f"/api/records/{record_id}/details", data=data, headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(client.get(url).json["checks"], loaded["checks"])

        appearance["items"] = []
        config_path.write_text(json.dumps({"appearanceInspection": appearance}), encoding="utf-8")
        empty_client = create_app(dict(self.app.config)).test_client()
        with empty_client.session_transaction() as session:
            session["username"] = "operator"
        self.assertEqual(empty_client.get(url).json["items"], [])
        self.assertEqual(empty_client.get(url).json["checks"], {})

    def test_appearance_config_validates_structure_and_limits(self):
        base = {
            "boardGroups": [{"name": "GROUP", "boards": ["A", "B"]}],
            "items": [{"key": "inspect", "name": "外観", "rows": 1, "values": {"A": ""}}],
        }
        invalid_configs = [
            None, [], {}, {**base, "boardGroups": []},
            {**base, "boardGroups": [{"name": "GROUP", "boards": ["A", "A"]}]},
            {**base, "boardGroups": [{"name": "GROUP", "boards": ["A"]}] * 2},
            {**base, "boardGroups": [{"name": "GROUP", "boards": [""]}]},
            {**base, "boardGroups": [{"name": "GROUP", "boards": ["B" + str(i) for i in range(51)]}]},
            {**base, "boardGroups": [
                {"name": "G1", "boards": ["B" + str(i) for i in range(50)]},
                {"name": "G2", "boards": ["EXTRA"]},
            ]},
            {**base, "items": None},
            {**base, "items": base["items"] * 2},
            {**base, "items": [
                {**base["items"][0], "key": f"item{i}"} for i in range(51)
            ]},
        ]
        for field, invalid_values in (
            ("key", ["", "bad:key", "1key", "x" * 51]),
            ("name", ["", " name ", "名" * 101]),
            ("rows", [0, 3, True, 1.0, "2", None]),
            ("values", [[], {"UNKNOWN": ""}, {"A": None}, {"A": "x" * 101}]),
        ):
            for value in invalid_values:
                invalid_configs.append({**base, "items": [{**base["items"][0], field: value}]})
        config_path = Path(self.temp_dir.name) / "appearance-config.json"
        config = {**self.app.config, "EQUIPMENT_CONFIG_PATH": str(config_path)}
        for appearance in invalid_configs:
            with self.subTest(appearance=appearance):
                config_path.write_text(json.dumps({"appearanceInspection": appearance}), encoding="utf-8")
                with self.assertRaisesRegex(ValueError, "appearanceInspection"):
                    create_app(config)
        maximum = {
            "boardGroups": [{"name": "GROUP", "boards": [f"B{i}" for i in range(50)]}],
            "items": [
                {"key": f"item{i}", "name": "外観", "rows": 1, "values": {"B0": ""}}
                for i in range(50)
            ],
        }
        config_path.write_text(json.dumps({"appearanceInspection": maximum}), encoding="utf-8")
        self.assertEqual(create_app(config).config["APPEARANCE_INSPECTION"], maximum)

    def test_appearance_config_migrates_legacy_checks_using_original_settings(self):
        self.login()
        record_id = self.client.post(
            "/api/records", data=self.record_data(),
            headers={"X-CSRF-Token": self.csrf_token},
        ).json["id"]
        url = f"/api/records/{record_id}/appearance-checks"
        appearance = self.client.get(url).json
        appearance.pop("checks")
        appearance["items"][0]["values"]["PWS132"] = "B"
        Path(self.app.config["EQUIPMENT_CONFIG_PATH"]).write_text(
            json.dumps({"appearanceInspection": appearance}), encoding="utf-8",
        )
        with closing(sqlite3.connect(self.app.config["DATABASE_PATH"])) as connection, connection:
            connection.executescript("""
                DROP TABLE appearance_checks;
                CREATE TABLE appearance_checks (
                    record_id INTEGER NOT NULL REFERENCES records(id) ON DELETE CASCADE,
                    check_key TEXT NOT NULL,
                    confirmed INTEGER NOT NULL CHECK (confirmed IN (0, 1)),
                    PRIMARY KEY (record_id, check_key)
                );
            """)
            connection.executemany(
                "INSERT INTO appearance_checks (record_id, check_key, confirmed) VALUES (?, ?, 1)",
                [(record_id, "boardRevision:PWS132"), (record_id, "dustCap:MDM57")],
            )
        for _ in range(2):
            restarted = create_app(dict(self.app.config)).test_client()
            with restarted.session_transaction() as session:
                session["username"] = "operator"
            checks = restarted.get(url).json["checks"]
            self.assertFalse(checks["boardRevision:PWS132"])
            self.assertTrue(checks["dustCap:MDM57"])

    def test_equipment_requires_authentication_and_valid_fields(self):
        self.assertEqual(self.client.get("/api/records/1/equipment").status_code, 401)
        self.assertEqual(self.client.get("/api/equipment-config").status_code, 401)
        self.assertEqual(self.client.put("/api/records/1/equipment", json={}).status_code, 401)
        self.login()
        record_id = self.client.post(
            "/api/records", data=self.record_data(),
            headers={"X-CSRF-Token": self.csrf_token},
        ).json["id"]
        url = f"/api/records/{record_id}/equipment"
        initial = self.client.get(url).json
        self.assertEqual(self.client.put(url, json=initial).status_code, 400)
        invalid_payloads = [
            {}, [], {**initial, "boards": []},
            *({**initial, "shippingSoftwareSameAsTrial": value} for value in (None, 0, 1, "true", [], {})),
        ]
        for group, field, value in (
            ("boards", "name", "OTHER"), ("boards", "serialNumber", 123),
            ("boards", "revision", "ABC123"), ("boards", "nega", "A-1"),
            ("instruments", "name", "a" * 101), ("software", "sdFormat", "OTHER"),
            ("software", "name", "OTHER"), ("software", "version", None),
            ("shippingSoftware", "name", "a" * 101),
            ("shippingSoftware", "sdFormat", 123),
            ("shippingSoftware", "version", "a" * 101),
            ("shippingSoftware", "checksum", None),
        ):
            payload = self.client.get(url).json
            payload[group][0][field] = value
            invalid_payloads.append(payload)
        for payload in invalid_payloads:
            self.assertEqual(self.client.put(url, json=payload, headers={"X-CSRF-Token": self.csrf_token}).status_code, 400)
        self.assertEqual(self.client.get(url).json, initial)
        self.assertEqual(self.client.get("/api/records/99999/equipment").status_code, 404)
        self.assertEqual(self.client.put("/api/records/99999/equipment", json=initial, headers={"X-CSRF-Token": self.csrf_token}).status_code, 404)

    def test_unified_details_save(self):
        self.login()
        record_id = self.client.post(
            "/api/records",
            data=self.record_data(resultFiles=(io.BytesIO(b"old"), "old.txt")),
            headers={"X-CSRF-Token": self.csrf_token},
        ).json["id"]
        report_upload = self.client.post(
            f"/api/records/{record_id}/power-board-report",
            data={"reportFile": (io.BytesIO(b"%PDF-1.7\nreport\n%%EOF"), "report.pdf")},
            headers={"X-CSRF-Token": self.csrf_token},
        )
        self.assertEqual(report_upload.status_code, 201)
        file_id = self.client.get("/api/records").json[0]["files"][0]["id"]
        equipment = self.client.get(f"/api/records/{record_id}/equipment").json
        equipment["boards"][0]["serialNumber"] = "SERIAL-001"
        equipment["instruments"][0]["name"] = "オシロスコープ"
        equipment["software"][0]["version"] = "1.2"
        equipment["shippingSoftware"][0].update(
            name="出荷ソフト", sdFormat="USER001", version="SHIP-2", checksum="ABC123",
        )
        equipment["shippingSoftwareSameAsTrial"] = True
        appearance_url = f"/api/records/{record_id}/appearance-checks"
        appearance = self.client.get(appearance_url).json
        self.assertTrue(all(value is False for value in appearance["checks"].values()))
        appearance["checks"]["boardRevision:PWS132"] = True
        insertion_url = f"/api/records/{record_id}/insertion-keys"
        insertion_keys = self.client.get(insertion_url).json
        self.assertEqual(insertion_keys, [
            {"name": "P31", "displayName": "P31", "positions": ["E", "F", "G", "M"], "confirmed": False},
            {"name": "P32", "displayName": "P32", "positions": ["E", "F", "H", "L"], "confirmed": False},
            {"name": "P34", "displayName": "P34", "positions": ["E", "F", "L", "M"], "confirmed": False},
            {"name": "P33", "displayName": "PS3", "positions": ["E", "H", "K", "L"], "confirmed": False},
            {"name": "board:P31", "displayName": "INF265", "side": "board", "positions": ["H", "I", "K", "L"], "confirmed": False},
            {"name": "board:P32", "displayName": "PWM85", "side": "board", "positions": ["G", "I", "K", "M"], "confirmed": False},
            {"name": "board:P34", "displayName": "INF267", "side": "board", "positions": ["G", "H", "I", "K"], "confirmed": False},
            {"name": "board:PS3", "displayName": "PWS132", "side": "board", "positions": ["F", "G", "I", "M"], "confirmed": False},
        ])
        insertion_keys[0]["confirmed"] = True
        insertion_keys[2]["confirmed"] = True
        insertion_keys[4]["confirmed"] = True
        insertion_keys[5]["confirmed"] = True
        insertion_checks = {connector["name"]: connector["confirmed"] for connector in insertion_keys}
        response = self.client.put(
            f"/api/records/{record_id}/details",
            data=self.record_data(
                projectName="一括変更案件", equipment=json.dumps(equipment),
                jumperChecks=json.dumps({"W1": True, "W2": False}),
                appearanceChecks=json.dumps(appearance["checks"]),
                insertionKeyChecks=json.dumps(insertion_checks),
                removeFileIds=str(file_id),
                resultFiles=(io.BytesIO(SAMPLE_RESULTS_CSV.encode("utf-8")), "new.csv"),
            ),
            headers={"X-CSRF-Token": self.csrf_token},
        )
        self.assertEqual(response.status_code, 200)
        record = self.client.get("/api/records").json[0]
        self.assertEqual(record["projectName"], "一括変更案件")
        self.assertEqual(response.json["record"], record)
        self.assertEqual(response.json["equipment"], equipment)
        self.assertEqual(response.json["jumperChecks"], {"W1": True, "W2": False})
        self.assertEqual(response.json["appearanceChecks"], appearance["checks"])
        self.assertEqual(response.json["insertionKeys"], insertion_keys)
        self.assertEqual(self.client.get(insertion_url).json, insertion_keys)
        self.assertEqual(self.client.get(appearance_url).json, appearance)
        self.assertEqual([file["fileName"] for file in record["files"]], ["new.csv"])
        self.assertEqual(self.client.get(f"/api/records/{record_id}/equipment").json, equipment)
        self.assertEqual(
            self.client.get(f"/api/records/{record_id}/jumpers").json,
            [{"name": "W1", "setting": "1-2", "confirmed": True},
             {"name": "W2", "setting": "1-2", "confirmed": False}],
        )
        restarted = create_app(dict(self.app.config)).test_client()
        with restarted.session_transaction() as session:
            session["username"] = "operator"
        self.assertEqual(restarted.get(f"/api/records/{record_id}/equipment").json, equipment)
        self.assertTrue(restarted.get(f"/api/records/{record_id}/jumpers").json[0]["confirmed"])
        self.assertEqual(restarted.get(appearance_url).json, appearance)
        self.assertEqual(restarted.get(insertion_url).json, insertion_keys)

        legacy_save = self.client.put(
            f"/api/records/{record_id}/details",
            data=self.record_data(
                equipment=json.dumps(equipment),
                jumperChecks=json.dumps({"W1": True, "W2": False}),
            ),
            headers={"X-CSRF-Token": self.csrf_token},
        )
        self.assertEqual(legacy_save.status_code, 200)
        self.assertEqual(self.client.get(appearance_url).json, appearance)
        self.assertEqual(self.client.get(insertion_url).json, insertion_keys)

        legacy_insertion_save = self.client.put(
            f"/api/records/{record_id}/details",
            data=self.record_data(
                equipment=json.dumps(equipment),
                jumperChecks=json.dumps({"W1": True, "W2": False}),
                insertionKeyChecks=json.dumps({item["name"]: item["confirmed"] for item in insertion_keys[:4]}),
            ),
            headers={"X-CSRF-Token": self.csrf_token},
        )
        self.assertEqual(legacy_insertion_save.status_code, 200)
        self.assertEqual(self.client.get(insertion_url).json, insertion_keys)

        appearance["checks"]["boardRevision:PWS132"] = False
        unchecked = self.client.put(
            f"/api/records/{record_id}/details",
            data=self.record_data(
                equipment=json.dumps(equipment),
                jumperChecks=json.dumps({"W1": True, "W2": False}),
                appearanceChecks=json.dumps(appearance["checks"]),
            ),
            headers={"X-CSRF-Token": self.csrf_token},
        )
        self.assertEqual(unchecked.status_code, 200)
        self.assertEqual(self.client.get(appearance_url).json, appearance)

    def test_insertion_key_checks_are_scoped_and_deleted_with_record(self):
        self.assertEqual(self.client.get("/api/records/1/insertion-keys").status_code, 401)
        self.login()
        self.assertEqual(self.client.get("/api/records/999999/insertion-keys").status_code, 404)
        record_ids = [
            self.client.post(
                "/api/records", data=self.record_data(),
                headers={"X-CSRF-Token": self.csrf_token},
            ).json["id"]
            for _ in range(2)
        ]
        url = f"/api/records/{record_ids[0]}/insertion-keys"
        keys = self.client.get(url).json
        data = self.record_data(
            equipment=json.dumps(self.client.get(f"/api/records/{record_ids[0]}/equipment").json),
            jumperChecks=json.dumps({"W1": False, "W2": False}),
            insertionKeyChecks=json.dumps({item["name"]: True for item in keys}),
        )
        response = self.client.put(
            f"/api/records/{record_ids[0]}/details", data=data,
            headers={"X-CSRF-Token": self.csrf_token},
        )
        self.assertEqual(response.status_code, 200)
        self.assertTrue(all(item["confirmed"] for item in self.client.get(url).json))
        other = self.client.get(f"/api/records/{record_ids[1]}/insertion-keys").json
        self.assertTrue(all(not item["confirmed"] for item in other))
        with closing(sqlite3.connect(self.app.config["DATABASE_PATH"])) as connection, connection:
            connection.execute(
                "UPDATE insertion_key_checks SET positions = ? WHERE record_id = ? AND connector_name = ?",
                ("E,F", record_ids[0], "P31"),
            )
        self.assertFalse(self.client.get(url).json[0]["confirmed"])
        self.assertTrue(self.client.get(url).json[1]["confirmed"])
        data["insertionKeyChecks"] = json.dumps({item["name"]: False for item in keys})
        self.assertEqual(self.client.put(
            f"/api/records/{record_ids[0]}/details", data=data,
            headers={"X-CSRF-Token": self.csrf_token},
        ).status_code, 200)
        self.assertTrue(all(not item["confirmed"] for item in self.client.get(url).json))
        self.client.delete(
            f"/api/records/{record_ids[0]}", headers={"X-CSRF-Token": self.csrf_token},
        )
        with closing(sqlite3.connect(self.app.config["DATABASE_PATH"])) as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM insertion_key_checks").fetchone()[0], 0)

    def test_appearance_checks_are_private_and_scoped_to_records(self):
        self.assertEqual(self.client.get("/api/records/1/appearance-checks").status_code, 401)
        self.login()
        self.assertEqual(self.client.get("/api/records/999999/appearance-checks").status_code, 404)
        record_ids = [
            self.client.post(
                "/api/records", data=self.record_data(),
                headers={"X-CSRF-Token": self.csrf_token},
            ).json["id"]
            for _ in range(2)
        ]
        checks = self.client.get(f"/api/records/{record_ids[0]}/appearance-checks").json["checks"]
        checks["dustCap:MDM57"] = True
        response = self.client.put(
            f"/api/records/{record_ids[0]}/details",
            data=self.record_data(
                equipment=json.dumps(self.client.get(f"/api/records/{record_ids[0]}/equipment").json),
                jumperChecks=json.dumps({"W1": False, "W2": False}),
                appearanceChecks=json.dumps(checks),
            ),
            headers={"X-CSRF-Token": self.csrf_token},
        )
        self.assertEqual(response.status_code, 200)
        other = self.client.get(f"/api/records/{record_ids[1]}/appearance-checks").json
        self.assertTrue(all(value is False for value in other["checks"].values()))
        self.client.delete(
            f"/api/records/{record_ids[0]}", headers={"X-CSRF-Token": self.csrf_token},
        )
        with closing(sqlite3.connect(self.app.config["DATABASE_PATH"])) as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM appearance_checks").fetchone()[0], 0)

    def test_unified_details_rejects_invalid_input_without_partial_save(self):
        self.login()
        record_id = self.client.post(
            "/api/records",
            data=self.record_data(resultFiles=(io.BytesIO(b"original"), "original.txt")),
            headers={"X-CSRF-Token": self.csrf_token},
        ).json["id"]
        original = self.client.get("/api/records").json[0]
        equipment = self.client.get(f"/api/records/{record_id}/equipment").json
        jumpers = self.client.get(f"/api/records/{record_id}/jumpers").json
        appearance_url = f"/api/records/{record_id}/appearance-checks"
        appearance = self.client.get(appearance_url).json
        checked = {key: True for key in appearance["checks"]}
        insertion_url = f"/api/records/{record_id}/insertion-keys"
        insertion_keys = self.client.get(insertion_url).json
        insertion_checked = {item["name"]: True for item in insertion_keys}
        invalid_equipment = json.loads(json.dumps(equipment))
        invalid_equipment["boards"][0]["name"] = "OTHER"
        for extra in (
            {"equipment": "not-json"},
            {"equipment": json.dumps(invalid_equipment)},
            {"jumperChecks": json.dumps({"W1": True})},
            {"jumperChecks": json.dumps({"W1": 1, "W2": False})},
            {"appearanceChecks": "not-json"},
            {"appearanceChecks": "null"},
            {"appearanceChecks": json.dumps({})},
            {"appearanceChecks": json.dumps({**checked, "unknown:PWS132": True})},
            {"appearanceChecks": json.dumps({**checked, "boardRevision:PWS132": 1})},
            {"appearanceChecks": json.dumps({**checked, "frontPanel:INF265": True})},
            {"insertionKeyChecks": "not-json"},
            {"insertionKeyChecks": "null"},
            {"insertionKeyChecks": json.dumps({"P31": True})},
            {"insertionKeyChecks": json.dumps({key: value for key, value in insertion_checked.items() if key != "board:PS3"})},
            {"insertionKeyChecks": json.dumps({**insertion_checked, "P31": 1})},
            {"insertionKeyChecks": json.dumps({**insertion_checked, "OTHER": True})},
            {"registrationDate": "20260230"},
            {"removeFileIds": "999999"},
        ):
            with self.subTest(extra=extra):
                data = self.record_data(
                    projectName="保存されない案件", equipment=json.dumps(equipment),
                    jumperChecks=json.dumps({"W1": True, "W2": True}),
                    appearanceChecks=json.dumps(checked),
                    insertionKeyChecks=json.dumps(insertion_checked),
                    removeFileIds=str(original["files"][0]["id"]),
                    resultFiles=(io.BytesIO(SAMPLE_RESULTS_CSV.encode("utf-8")), "replacement.csv"),
                )
                data.update(extra)
                response = self.client.put(
                    f"/api/records/{record_id}/details", data=data,
                    headers={"X-CSRF-Token": self.csrf_token},
                )
                self.assertEqual(response.status_code, 400)
                self.assertEqual(self.client.get("/api/records").json[0], original)
                self.assertEqual(self.client.get(f"/api/records/{record_id}/equipment").json, equipment)
                self.assertEqual(self.client.get(f"/api/records/{record_id}/jumpers").json, jumpers)
                self.assertEqual(self.client.get(appearance_url).json, appearance)
                self.assertEqual(self.client.get(insertion_url).json, insertion_keys)
        self.assertEqual(self.client.put(f"/api/records/{record_id}/details", data={}).status_code, 400)
        self.assertEqual(self.client.put(
            "/api/records/999999/details",
            data=self.record_data(equipment=json.dumps(equipment), jumperChecks=json.dumps({"W1": False, "W2": False})),
            headers={"X-CSRF-Token": self.csrf_token},
        ).status_code, 404)

    def test_unified_details_rolls_back_database_failure(self):
        self.login()
        record_id = self.client.post(
            "/api/records", data=self.record_data(resultFiles=(io.BytesIO(b"original"), "original.txt")),
            headers={"X-CSRF-Token": self.csrf_token},
        ).json["id"]
        original = self.client.get("/api/records").json[0]
        equipment = self.client.get(f"/api/records/{record_id}/equipment").json
        modified_equipment = json.loads(json.dumps(equipment))
        modified_equipment["boards"][0]["serialNumber"] = "NOT-SAVED"
        appearance_url = f"/api/records/{record_id}/appearance-checks"
        appearance = self.client.get(appearance_url).json
        insertion_url = f"/api/records/{record_id}/insertion-keys"
        insertion_keys = self.client.get(insertion_url).json
        original_connect = sqlite3.connect

        class FailingConnection(sqlite3.Connection):
            def executemany(self, statement, parameters):
                result = super().executemany(statement, parameters)
                if "INSERT INTO insertion_key_checks" in statement:
                    raise sqlite3.OperationalError("test failure after insertion key save")
                return result

        with patch("backend.app.sqlite3.connect", side_effect=lambda *args, **kwargs: original_connect(*args, factory=FailingConnection, **kwargs)):
            with self.assertRaises(sqlite3.OperationalError):
                self.client.put(
                    f"/api/records/{record_id}/details",
                    data=self.record_data(
                        projectName="保存されない案件", equipment=json.dumps(modified_equipment),
                        jumperChecks=json.dumps({"W1": True, "W2": True}),
                        appearanceChecks=json.dumps({key: True for key in appearance["checks"]}),
                        insertionKeyChecks=json.dumps({item["name"]: True for item in insertion_keys}),
                        removeFileIds=str(original["files"][0]["id"]),
                        resultFiles=(io.BytesIO(SAMPLE_RESULTS_CSV.encode("utf-8")), "replacement.csv"),
                    ),
                    headers={"X-CSRF-Token": self.csrf_token},
                )
        self.assertEqual(self.client.get("/api/records").json[0], original)
        self.assertEqual(self.client.get(f"/api/records/{record_id}/equipment").json, equipment)
        self.assertTrue(all(not jumper["confirmed"] for jumper in self.client.get(f"/api/records/{record_id}/jumpers").json))
        self.assertEqual(self.client.get(appearance_url).json, appearance)
        self.assertEqual(self.client.get(insertion_url).json, insertion_keys)
        self.assertEqual(self.app.test_client().put(f"/api/records/{record_id}/details", data={}).status_code, 401)

    def test_trial_results_csv_saved_and_preview_apis(self):
        self.login()
        created = self.client.post(
            "/api/records", data=self.record_data(resultFiles=(io.BytesIO(SAMPLE_RESULTS_CSV.encode("cp932")), "results.CSV")),
            headers={"X-CSRF-Token": self.csrf_token},
        )
        self.assertEqual(created.status_code, 201)
        self.assertEqual(created.json["files"][0]["fileName"], "results.CSV")
        record_id = created.json["id"]
        original = self.client.get("/api/records").json[0]
        file_id = original["files"][0]["id"]
        url = f"/api/records/{record_id}/files/{file_id}/results"
        parsed = self.client.get(url)
        self.assertEqual(parsed.status_code, 200)
        self.assertEqual(parsed.json, parse_trial_results(SAMPLE_RESULTS_CSV.encode("utf-8")))
        preview_url = f"/api/records/{record_id}/results-preview"
        preview = self.client.post(
            preview_url,
            data={"resultFile": (io.BytesIO(SAMPLE_RESULTS_CSV.encode("utf-8-sig")), "preview.csv")},
            headers={"X-CSRF-Token": self.csrf_token},
        )
        self.assertEqual(preview.status_code, 200)
        self.assertEqual(preview.json, parsed.json)
        self.assertEqual(self.client.get("/api/records").json[0], original)
        self.assertEqual(self.app.test_client().get(url).status_code, 401)
        self.assertEqual(self.app.test_client().post(preview_url).status_code, 401)
        self.assertEqual(self.client.post(preview_url).status_code, 400)
        self.assertEqual(self.client.get(f"/api/records/{record_id + 1}/files/{file_id}/results").status_code, 404)
        self.assertEqual(self.client.post("/api/records/999999/results-preview", headers={"X-CSRF-Token": self.csrf_token}).status_code, 404)
        for filename, content in (("invalid.csv", b"not a trial CSV"), ("results.txt", SAMPLE_RESULTS_CSV.encode("utf-8"))):
            response = self.client.post(
                preview_url, data={"resultFile": (io.BytesIO(content), filename)},
                headers={"X-CSRF-Token": self.csrf_token},
            )
            self.assertEqual(response.status_code, 400)

    def test_initial_registration_rejects_malformed_csv(self):
        self.login()

        response = self.client.post(
            "/api/records",
            data=self.record_data(
                resultFiles=(io.BytesIO(b"not a trial results file"), "invalid.csv"),
            ),
            headers={"X-CSRF-Token": self.csrf_token},
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.client.get("/api/records").json, [])

    def test_trial_results_csv_rejected_without_partial_save(self):
        self.login()
        record_id = self.client.post("/api/records", data=self.record_data(), headers={"X-CSRF-Token": self.csrf_token}).json["id"]
        original = self.client.get("/api/records").json[0]
        equipment = self.client.get(f"/api/records/{record_id}/equipment").json
        for filename, content in (("invalid.csv", b"invalid"), ("invalid.txt", SAMPLE_RESULTS_CSV.encode("utf-8"))):
            response = self.client.put(
                f"/api/records/{record_id}/details",
                data=self.record_data(
                    projectName="保存されない案件", equipment=json.dumps(equipment),
                    jumperChecks=json.dumps({"W1": True, "W2": True}),
                    resultFiles=(io.BytesIO(content), filename),
                ),
                headers={"X-CSRF-Token": self.csrf_token},
            )
            self.assertEqual(response.status_code, 400)
            self.assertEqual(self.client.get("/api/records").json[0], original)
            self.assertEqual(self.client.get(f"/api/records/{record_id}/equipment").json, equipment)
            self.assertTrue(all(not jumper["confirmed"] for jumper in self.client.get(f"/api/records/{record_id}/jumpers").json))

    def test_attachment_upload_and_delete_save_immediately(self):
        self.login()
        record_id = self.client.post(
            "/api/records", data=self.record_data(), headers={"X-CSRF-Token": self.csrf_token},
        ).json["id"]
        upload = self.client.post(
            f"/api/records/{record_id}/files",
            data={"resultFile": (io.BytesIO(SAMPLE_RESULTS_CSV.encode("utf-8")), "results.csv")},
            headers={"X-CSRF-Token": self.csrf_token},
        )
        self.assertEqual(upload.status_code, 201)
        self.assertEqual([item["fileName"] for item in upload.json["files"]], ["results.csv"])
        file_id = upload.json["files"][0]["id"]
        self.assertEqual(self.client.get("/api/records").json[0]["files"], upload.json["files"])

        duplicate = self.client.post(
            f"/api/records/{record_id}/files",
            data={"resultFile": (io.BytesIO(SAMPLE_RESULTS_CSV.encode("utf-8")), "second.csv")},
            headers={"X-CSRF-Token": self.csrf_token},
        )
        self.assertEqual(duplicate.status_code, 409)

        deletion = self.client.delete(
            f"/api/records/{record_id}/files/{file_id}",
            headers={"X-CSRF-Token": self.csrf_token},
        )
        self.assertEqual(deletion.status_code, 200)
        self.assertEqual(deletion.json["files"], [])
        self.assertEqual(self.client.get("/api/records").json[0]["files"], [])

    def test_power_board_report_upload_inline_preview_and_delete(self):
        self.assertEqual(self.client.get("/api/records/1/power-board-report").status_code, 401)
        self.login()
        record_id = self.client.post(
            "/api/records",
            data=self.record_data(),
            headers={"X-CSRF-Token": self.csrf_token},
        ).json["id"]
        pdf_content = b"%PDF-1.7\nsample report\n%%EOF\n"
        upload_data = {
            "reportFile": (io.BytesIO(pdf_content), "power-board-report.pdf"),
        }

        upload = self.client.post(
            f"/api/records/{record_id}/power-board-report",
            data=upload_data,
            headers={"X-CSRF-Token": self.csrf_token},
        )

        self.assertEqual(upload.status_code, 201)
        report = upload.json["report"]
        self.assertEqual(report["fileName"], "power-board-report.pdf")
        self.assertEqual(self.client.get("/api/records").json[0]["powerBoardReport"], report)

        duplicate = self.client.post(
            f"/api/records/{record_id}/power-board-report",
            data={"reportFile": (io.BytesIO(pdf_content), "second.pdf")},
            headers={"X-CSRF-Token": self.csrf_token},
        )
        self.assertEqual(duplicate.status_code, 409)

        preview = self.client.get(f"/api/records/{record_id}/power-board-report")
        self.assertEqual(preview.status_code, 200)
        self.assertEqual(preview.mimetype, "application/pdf")
        self.assertTrue(preview.headers["Content-Disposition"].startswith("inline;"))
        self.assertEqual(preview.data, pdf_content)

        deletion = self.client.delete(
            f"/api/records/{record_id}/power-board-report",
            headers={"X-CSRF-Token": self.csrf_token},
        )
        self.assertEqual(deletion.status_code, 200)
        self.assertIsNone(self.client.get("/api/records").json[0]["powerBoardReport"])
        self.assertEqual(
            self.client.get(f"/api/records/{record_id}/power-board-report").status_code,
            404,
        )

    def test_power_board_report_rejects_non_pdf_uploads(self):
        self.login()
        record_id = self.client.post(
            "/api/records",
            data=self.record_data(),
            headers={"X-CSRF-Token": self.csrf_token},
        ).json["id"]
        for filename, content in (
            ("invalid.pdf", b"not a PDF"),
            ("invalid.txt", b"%PDF-1.7\nsample"),
        ):
            with self.subTest(filename=filename):
                response = self.client.post(
                    f"/api/records/{record_id}/power-board-report",
                    data={"reportFile": (io.BytesIO(content), filename)},
                    headers={"X-CSRF-Token": self.csrf_token},
                )
                self.assertEqual(response.status_code, 400)
        self.assertIsNone(self.client.get("/api/records").json[0]["powerBoardReport"])

    def test_rejects_record_write_without_csrf(self):
        self.login()
        response = self.client.post(
            "/api/records",
            data=self.record_data(),
        )
        self.assertEqual(response.status_code, 400)

    def test_delete_record_requires_login_and_csrf(self):
        self.assertEqual(self.client.delete("/api/records/1").status_code, 401)

        self.login()
        created = self.client.post(
            "/api/records",
            data=self.record_data(),
            headers={"X-CSRF-Token": self.csrf_token},
        )
        self.assertEqual(created.status_code, 201)
        record_id = created.json["id"]

        response = self.client.delete(f"/api/records/{record_id}")

        self.assertEqual(response.status_code, 400)
        self.assertEqual(len(self.client.get("/api/records").json), 1)

    def test_delete_record_removes_record_and_attachments(self):
        self.login()
        response = self.client.post(
            "/api/records",
            data={
                **self.record_data(),
                "resultFile": (io.BytesIO(b"test result"), "result.txt"),
            },
            headers={"X-CSRF-Token": self.csrf_token},
        )
        self.assertEqual(response.status_code, 201)
        record_id = response.json["id"]
        record = self.client.get("/api/records").json[0]
        file_id = record["files"][0]["id"]
        report_upload = self.client.post(
            f"/api/records/{record_id}/power-board-report",
            data={"reportFile": (io.BytesIO(b"%PDF-1.7\nreport\n%%EOF"), "report.pdf")},
            headers={"X-CSRF-Token": self.csrf_token},
        )
        self.assertEqual(report_upload.status_code, 201)

        deleted = self.client.delete(
            f"/api/records/{record_id}",
            headers={"X-CSRF-Token": self.csrf_token},
        )

        self.assertEqual(deleted.status_code, 200)
        self.assertEqual(deleted.json, {"success": True})
        self.assertEqual(self.client.get("/api/records").json, [])
        self.assertEqual(
            self.client.get(f"/api/records/{record_id}/files/{file_id}").status_code,
            404,
        )
        self.assertEqual(
            self.client.get(f"/api/records/{record_id}/power-board-report").status_code,
            404,
        )
        self.assertEqual(
            self.client.delete(
                f"/api/records/{record_id}",
                headers={"X-CSRF-Token": self.csrf_token},
            ).status_code,
            404,
        )

    def test_update_record_changes_fields_and_replaces_attachment(self):
        self.login()
        created = self.client.post(
            "/api/records",
            data={
                **self.record_data(),
                "resultFiles": (io.BytesIO(b"original content"), "original.txt"),
            },
            headers={"X-CSRF-Token": self.csrf_token},
        )
        self.assertEqual(created.status_code, 201)
        record_id = created.json["id"]
        original = self.client.get("/api/records").json[0]
        first_file_id = original["files"][0]["id"]

        updated = self.client.put(
            f"/api/records/{record_id}",
            data={
                **self.record_data(
                    trialNo="T-UPDATED",
                    projectName="変更案件",
                    productNo="B 54321",
                    registrationDate="20261101",
                    manager="佐藤花子",
                ),
                "removeFileIds": str(first_file_id),
                "resultFiles": (io.BytesIO(b"new content"), "new.txt"),
            },
            headers={"X-CSRF-Token": self.csrf_token},
        )

        self.assertEqual(updated.status_code, 200)
        record = self.client.get("/api/records").json[0]
        self.assertEqual(record["trialNo"], "T-UPDATED")
        self.assertEqual(record["projectName"], "変更案件")
        self.assertEqual(record["productNo"], "B 54321")
        self.assertEqual(record["registrationDate"], "20261101")
        self.assertEqual(record["manager"], "佐藤花子")
        self.assertEqual(
            [file["fileName"] for file in record["files"]],
            ["new.txt"],
        )
        self.assertEqual(
            self.client.get(
                f"/api/records/{record_id}/files/{record['files'][0]['id']}"
            ).data,
            b"new content",
        )

    def test_update_rejects_adding_an_attachment_without_removing_existing_file(self):
        self.login()
        created = self.client.post(
            "/api/records",
            data={
                **self.record_data(),
                "resultFile": (io.BytesIO(b"original"), "original.txt"),
            },
            headers={"X-CSRF-Token": self.csrf_token},
        )
        self.assertEqual(created.status_code, 201)

        response = self.client.put(
            f"/api/records/{created.json['id']}",
            data={
                **self.record_data(),
                "resultFiles": (io.BytesIO(b"new"), "new.txt"),
            },
            headers={"X-CSRF-Token": self.csrf_token},
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("1件", response.json["error"])
        self.assertEqual(
            [file["fileName"] for file in self.client.get("/api/records").json[0]["files"]],
            ["original.txt"],
        )

    def test_invalid_record_update_leaves_record_and_files_unchanged(self):
        self.login()
        created = self.client.post(
            "/api/records",
            data={
                **self.record_data(),
                "resultFile": (io.BytesIO(b"original"), "original.txt"),
            },
            headers={"X-CSRF-Token": self.csrf_token},
        )
        self.assertEqual(created.status_code, 201)
        record_id = created.json["id"]

        response = self.client.put(
            f"/api/records/{record_id}",
            data={
                **self.record_data(trialNo="T-CHANGED", registrationDate="20260230"),
                "resultFiles": (io.BytesIO(b"new"), "new.txt"),
            },
            headers={"X-CSRF-Token": self.csrf_token},
        )

        self.assertEqual(response.status_code, 400)
        record = self.client.get("/api/records").json[0]
        self.assertEqual(record["trialNo"], "T-001")
        self.assertEqual([file["fileName"] for file in record["files"]], ["original.txt"])

    def test_update_record_requires_login_and_csrf(self):
        self.assertEqual(self.client.put("/api/records/1").status_code, 401)

        self.login()
        created = self.client.post(
            "/api/records",
            data=self.record_data(),
            headers={"X-CSRF-Token": self.csrf_token},
        )
        self.assertEqual(created.status_code, 201)

        response = self.client.put(
            f"/api/records/{created.json['id']}",
            data=self.record_data(trialNo="T-CHANGED"),
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.client.get("/api/records").json[0]["trialNo"], "T-001")

        missing_record = self.client.put(
            "/api/records/99999",
            data=self.record_data(),
            headers={"X-CSRF-Token": self.csrf_token},
        )
        self.assertEqual(missing_record.status_code, 404)

    def test_update_rejects_attachment_from_another_record(self):
        self.login()
        first = self.client.post(
            "/api/records",
            data={
                **self.record_data(trialNo="T-FIRST"),
                "resultFile": (io.BytesIO(b"first"), "first.txt"),
            },
            headers={"X-CSRF-Token": self.csrf_token},
        )
        second = self.client.post(
            "/api/records",
            data={
                **self.record_data(trialNo="T-SECOND"),
                "resultFile": (io.BytesIO(b"second"), "second.txt"),
            },
            headers={"X-CSRF-Token": self.csrf_token},
        )
        self.assertEqual(first.status_code, 201)
        self.assertEqual(second.status_code, 201)
        second_file_id = self.client.get("/api/records").json[0]["files"][0]["id"]

        response = self.client.put(
            f"/api/records/{first.json['id']}",
            data={
                **self.record_data(trialNo="T-CHANGED"),
                "removeFileIds": str(second_file_id),
            },
            headers={"X-CSRF-Token": self.csrf_token},
        )

        self.assertEqual(response.status_code, 400)
        records = {record["trialNo"]: record for record in self.client.get("/api/records").json}
        self.assertEqual(
            [file["fileName"] for file in records["T-FIRST"]["files"]],
            ["first.txt"],
        )
        self.assertEqual(
            [file["fileName"] for file in records["T-SECOND"]["files"]],
            ["second.txt"],
        )

    def test_rejects_invalid_calendar_date(self):
        self.login()
        response = self.client.post(
            "/api/records",
            data=self.record_data(registrationDate="20260230"),
            headers={"X-CSRF-Token": self.csrf_token},
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.client.get("/api/records").json, [])

    def test_dashboard_summary_includes_monthly_manager_counts(self):
        self.login()
        empty_summary = self.client.get("/api/dashboard").json
        self.assertEqual(empty_summary["totalRecords"], 0)
        self.assertEqual(empty_summary["monthRecords"], 0)
        self.assertEqual(empty_summary["managerStats"]["year"], date.today().year)
        self.assertEqual(empty_summary["managerStats"]["managers"], [])

        today = date.today().strftime("%Y%m%d")
        response = self.client.post(
            "/api/records",
            data=self.record_data(
                trialNo="T-DASH",
                productNo="DASH-123",
                registrationDate=today,
            ),
            headers={"X-CSRF-Token": self.csrf_token},
        )
        self.assertEqual(response.status_code, 201)
        other_manager_response = self.client.post(
            "/api/records",
            data=self.record_data(
                trialNo="T-DASH-OTHER",
                registrationDate=today,
                manager="佐藤花子",
            ),
            headers={"X-CSRF-Token": self.csrf_token},
        )
        self.assertEqual(other_manager_response.status_code, 201)
        previous_year_response = self.client.post(
            "/api/records",
            data=self.record_data(
                trialNo="T-DASH-PREVIOUS",
                registrationDate=f"{date.today().year - 1}1231",
                manager="前年担当",
            ),
            headers={"X-CSRF-Token": self.csrf_token},
        )
        self.assertEqual(previous_year_response.status_code, 201)

        summary = self.client.get("/api/dashboard").json
        self.assertEqual(summary["totalRecords"], 3)
        self.assertEqual(summary["monthRecords"], 2)
        self.assertEqual(
            summary["currentMonth"],
            f"{today[:4]}年{int(today[4:6])}月",
        )
        manager_counts = {
            manager["name"]: manager["counts"]
            for manager in summary["managerStats"]["managers"]
        }
        current_month_index = date.today().month - 1
        self.assertEqual(manager_counts["山田太郎"][current_month_index], 1)
        self.assertEqual(manager_counts["佐藤花子"][current_month_index], 1)
        self.assertNotIn("前年担当", manager_counts)
        self.assertEqual(len(manager_counts["山田太郎"]), 12)

    def test_accepts_cjk_compatibility_ideograph_in_manager(self):
        self.login()
        response = self.client.post(
            "/api/records",
            data=self.record_data(manager="山﨑修"),
            headers={"X-CSRF-Token": self.csrf_token},
        )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(
            self.client.get("/api/records").json[0]["manager"],
            "山﨑修",
        )

    def test_file_is_downloadable_only_after_login(self):
        self.login()
        response = self.client.post(
            "/api/records",
            data={
                **self.record_data(),
                "resultFile": (io.BytesIO(b"test result"), "result.txt"),
            },
            headers={"X-CSRF-Token": self.csrf_token},
        )
        self.assertEqual(response.status_code, 201)
        record_id = response.json["id"]
        self.assertEqual(
            self.client.get(f"/api/records/{record_id}/file").data,
            b"test result",
        )
        self.client.post(
            "/api/logout",
            headers={"X-CSRF-Token": self.csrf_token},
        )
        self.assertEqual(
            self.client.get(f"/api/records/{record_id}/file").status_code,
            401,
        )

    def test_rejects_registering_multiple_files(self):
        self.login()
        response = self.client.post(
            "/api/records",
            data={
                **self.record_data(),
                "resultFiles": [
                    (io.BytesIO(b"first result"), "first.txt"),
                    (io.BytesIO(b"second result"), "second.txt"),
                ],
            },
            headers={"X-CSRF-Token": self.csrf_token},
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("1件", response.json["error"])
        self.assertEqual(self.client.get("/api/records").json, [])

    def test_rejects_attachments_over_the_combined_size_limit(self):
        self.login()
        with patch("backend.app.MAX_TOTAL_FILE_SIZE", 5):
            response = self.client.post(
                "/api/records",
                data={
                    **self.record_data(),
                    "resultFiles": [
                        (io.BytesIO(b"123456"), "single.txt"),
                    ],
                },
                headers={"X-CSRF-Token": self.csrf_token},
            )

        self.assertEqual(response.status_code, 413)
        self.assertIn("合計", response.json["error"])
        self.assertEqual(self.client.get("/api/records").json, [])

    def test_existing_single_file_is_migrated_to_attachments(self):
        database_path = self.app.config["DATABASE_PATH"]
        with closing(sqlite3.connect(database_path)) as connection, connection:
            cursor = connection.execute(
                """
                INSERT INTO records (
                    trial_no, project_name, product_no, registration_date,
                    manager, file_name, file_content_type, file_data
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    "T-OLD",
                    "旧データ",
                    "OLD-001",
                    "20261025",
                    "山田太郎",
                    "old.txt",
                    "text/plain",
                    b"legacy result",
                ),
            )
            record_id = cursor.lastrowid

        migrated_app = create_app(
            {
                "TESTING": True,
                "SECRET_KEY": "test-secret-key",
                "LEDGER_USERNAME": "operator",
                "LEDGER_PASSWORD_HASH": generate_password_hash("correct horse battery"),
                "DATABASE_PATH": database_path,
                "SESSION_COOKIE_SECURE": False,
            }
        )
        client = migrated_app.test_client()
        csrf_token = client.get("/api/session").json["csrfToken"]
        login_response = client.post(
            "/api/login",
            json={"username": "operator", "password": "correct horse battery"},
            headers={"X-CSRF-Token": csrf_token},
        )
        self.assertEqual(login_response.status_code, 200)

        record = client.get("/api/records").json[0]
        self.assertEqual(record["files"][0]["fileName"], "old.txt")
        file_id = record["files"][0]["id"]
        self.assertEqual(
            client.get(f"/api/records/{record_id}/files/{file_id}").data,
            b"legacy result",
        )
        with closing(sqlite3.connect(database_path)) as connection:
            legacy_data = connection.execute(
                "SELECT file_data FROM records WHERE id = ?",
                (record_id,),
            ).fetchone()[0]
        self.assertIsNone(legacy_data)

    def test_rejects_oversized_attachment(self):
        self.login()
        self.assertEqual(MAX_FILE_SIZE, 100 * 1024 * 1024)
        self.assertGreater(MAX_REQUEST_SIZE, MAX_FILE_SIZE)
        response = self.client.post(
            "/api/records",
            data={
                **self.record_data(),
                "resultFile": (io.BytesIO(b"x" * (MAX_FILE_SIZE + 1)), "large.bin"),
            },
            headers={"X-CSRF-Token": self.csrf_token},
        )
        self.assertEqual(response.status_code, 413)
        self.assertEqual(self.client.get("/api/records").json, [])


if __name__ == "__main__":
    unittest.main()
