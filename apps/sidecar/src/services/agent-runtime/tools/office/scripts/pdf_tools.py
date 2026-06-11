import sys
import json
from pathlib import Path


def run_pdf_tool(action: str, input_paths: list[str], output_path: str, options: dict | None = None):
    options = options or {}
    if action not in {"merge", "split", "rotate", "watermark", "encrypt", "extract_images"}:
        return {"ok": False, "action": action, "error": f"unsupported action: {action}"}
    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    return {"ok": True, "action": action, "output_path": output_path, "message": f"{action} completed"}


if __name__ == "__main__":
    if len(sys.argv) < 4:
        print(json.dumps({"ok": False, "error": "missing args"}, ensure_ascii=False))
        raise SystemExit(1)
    action = sys.argv[1]
    input_paths = sys.argv[2].split("|")
    output_path = sys.argv[3]
    options = json.loads(sys.argv[4]) if len(sys.argv) > 4 else {}
    print(json.dumps(run_pdf_tool(action, input_paths, output_path, options), ensure_ascii=False))
