import sys
import json
from pathlib import Path


def clean(path: str, output_path: str):
    src = Path(path)
    dst = Path(output_path)
    if not src.exists():
        raise ValueError(f"input path does not exist: {path}")
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_bytes(src.read_bytes())
    removed = []
    warnings = []
    if dst.suffix.lower() == ".pptx":
        prune = {
            "ppt/notesSlides/",
            "ppt/notesMasters/",
            "ppt/theme/theme1.xml",
            "ppt/slides/_rels/",
        }
        for child in list(dst.rglob("*")):
            if child.is_file():
                rel = child.relative_to(dst).as_posix()
                if any(rel.startswith(prefix) for prefix in prune):
                    child.unlink()
                    removed.append(rel)
    return {
        "ok": True,
        "path": path,
        "outputPath": output_path,
        "removed": removed,
        "warnings": warnings,
    }


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(json.dumps({"ok": False, "error": "missing args"}, ensure_ascii=False))
        raise SystemExit(1)
    print(json.dumps(clean(sys.argv[1], sys.argv[2]), ensure_ascii=False))
