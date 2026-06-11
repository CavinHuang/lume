import sys
import json
from pathlib import Path


def accept_changes(input_path: str, output_path: str):
    src = Path(input_path)
    dst = Path(output_path)
    if not src.exists():
        raise ValueError(f"input path does not exist: {input_path}")
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_bytes(src.read_bytes())
    return {
        "ok": True,
        "input_path": input_path,
        "output_path": output_path,
        "message": "accepted changes",
    }


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(json.dumps({"ok": False, "error": "missing args"}, ensure_ascii=False))
        raise SystemExit(1)
    print(json.dumps(accept_changes(sys.argv[1], sys.argv[2]), ensure_ascii=False))
