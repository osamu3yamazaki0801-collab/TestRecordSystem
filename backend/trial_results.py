import csv
import re
from io import StringIO


def parse_trial_results_file(filename, content):
    if not filename.lower().endswith(".csv"):
        raise ValueError("試験結果ファイルはCSV形式（.csv）を選択してください。")
    return parse_trial_results(content)


def parse_trial_results(content):
    text = None
    for encoding in ("utf-8-sig", "cp932"):
        try:
            text = content.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    if text is None:
        raise ValueError("CSVはUTF-8またはShift_JISで保存してください。")

    metadata = {}
    sections = []
    current = None
    stage = None
    try:
        reader = csv.reader(StringIO(text, newline=""), strict=True)
        for raw_row in reader:
            row = [cell.strip() for cell in raw_row]
            if not any(row):
                continue
            marker = re.fullmatch(r"試験結果\s*([12])", row[0])
            if marker:
                number = int(marker.group(1))
                if any(section["number"] == number for section in sections):
                    raise ValueError("試験結果の見出しが重複しています。")
                current = {"number": number, "title": f"試験結果 {number}", "temperatures": [], "rows": []}
                sections.append(current)
                stage = "temperatures"
                continue
            if current is None:
                if row[0] not in {"品名", "仕様書番号", "試験番号"} or len(row) != 2 or not row[1]:
                    raise ValueError(f"CSVの{reader.line_num}行目の基本情報が正しくありません。")
                if row[0] in metadata:
                    raise ValueError("CSVの基本情報が重複しています。")
                metadata[row[0]] = row[1]
                continue

            base = 5 if current["number"] == 1 else 4
            width = 4 if current["number"] == 1 else 2
            expected_columns = base + width * 3
            if stage == "temperatures":
                if len(row) != expected_columns:
                    raise ValueError(f"CSVの{reader.line_num}行目の温度見出しの列数が正しくありません。")
                for index in range(3):
                    offset = base + index * width
                    if not row[offset].startswith("温度") or not row[offset + 1]:
                        raise ValueError(f"CSVの{reader.line_num}行目の温度情報が正しくありません。")
                    current["temperatures"].append({"label": row[offset], "value": row[offset + 1]})
                stage = "header"
                continue
            if stage == "header":
                expected_header = (
                    ["No.", "試験名称", "下限値", "上限値", "単位"] + ["MIN", "判定", "MAX", "判定"] * 3
                    if current["number"] == 1 else
                    ["No.", "試験名称", "規定値", "単位"] + ["測定値", "判定"] * 3
                )
                if row != expected_header:
                    raise ValueError(f"CSVの{reader.line_num}行目の項目見出しが正しくありません。")
                stage = "rows"
                continue
            if len(row) != expected_columns or not row[0] or not row[1]:
                raise ValueError(f"CSVの{reader.line_num}行目の試験結果の列数または項目が正しくありません。")
            result = {"no": row[0], "name": row[1], "unit": row[base - 1], "measurements": []}
            if current["number"] == 1:
                result.update(lowerLimit=row[2], upperLimit=row[3])
            else:
                result["specifiedValue"] = row[2]
            judgements = []
            for index in range(3):
                offset = base + index * width
                if current["number"] == 1:
                    result["measurements"].append({
                        "min": row[offset], "minJudgement": row[offset + 1],
                        "max": row[offset + 2], "maxJudgement": row[offset + 3],
                    })
                    judgements.extend([row[offset + 1].upper(), row[offset + 3].upper()])
                else:
                    result["measurements"].append({"value": row[offset], "judgement": row[offset + 1]})
                    judgements.append(row[offset + 1].upper())
            if any(value in {"FAIL", "NG"} for value in judgements):
                result["judgement"] = "FAIL"
            elif all(value == "PASS" for value in judgements):
                result["judgement"] = "PASS"
            else:
                result["judgement"] = "UNJUDGED"
            current["rows"].append(result)
    except csv.Error as error:
        raise ValueError("CSVの引用符またはセルの長さが正しくありません。") from error

    if set(metadata) != {"品名", "仕様書番号", "試験番号"}:
        raise ValueError("CSVには品名・仕様書番号・試験番号が必要です。")
    if not sections or any(not section["rows"] for section in sections) or stage != "rows":
        raise ValueError("CSVには温度見出しと試験結果の明細が必要です。")
    for section in sections:
        section["summary"] = {
            status: sum(row["judgement"] == status for row in section["rows"])
            for status in ("PASS", "FAIL", "UNJUDGED")
        }
    return {"metadata": metadata, "sections": sections}