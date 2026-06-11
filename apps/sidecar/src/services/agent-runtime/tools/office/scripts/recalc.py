import sys
import json
from pathlib import Path


def recalc(path: str, timeout: int = 30):
    p = Path(path)
    if not p.exists():
        raise ValueError(f"path does not exist: {path}")
    formulas = 0
    errors = 0
    error_summary = {}
    for xml in p.glob("**/*.xml"):
        try:
            text = xml.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue
        if "<c" in text and "</c>" in text:
            formulas += text.count("<c")
            errors += text.count("#REF!") + text.count("#DIV/0!")
            if "#REF!" in text:
                error_summary["#REF!"] = error_summary.get("#REF!", 0) + text.count("#REF!")
            if "#DIV/0!" in text:
                error_summary["#DIV/0!"] = error_summary.get("#DIV/0!", 0) + text.count("#DIV/0!")
    return {
        "ok": errors == 0,
        "status": "recalculated",
        "path": path,
        "total_formulas": formulas,
        "total_errors": errors,
        "error_summary": error_summary,
    }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "path is required"}, ensure_ascii=False))
        raise SystemExit(1)
    print(json.dumps(recalc(sys.argv[1], int(sys.argv[2])), ensure_ascii=False))
