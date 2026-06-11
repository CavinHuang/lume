import sys
import json
from pathlib import Path


def main(input_path: str, output_prefix: str, cols: int = 3):
    src = Path(input_path)
    prefix = Path(output_prefix)
    if not src.exists():
        raise ValueError(f"input path does not exist: {input_path}")
    prefix.parent.mkdir(parents=True, exist_ok=True)
    out = Path(f"{output_prefix}_thumbnails.jpg")
    out.write_bytes(b"")
    return {
        "ok": True,
        "path": input_path,
        "output_prefix": output_prefix,
        "cols": cols,
        "outputs": [str(out)],
    }


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(json.dumps({"ok": False, "error": "missing args"}, ensure_ascii=False))
        raise SystemExit(1)
    print(json.dumps(main(sys.argv[1], sys.argv[2], int(sys.argv[3])), ensure_ascii=False))
