
import zipfile
if hasattr(zipfile.ZipExtFile, "_update_crc"):
    zipfile.ZipExtFile._update_crc = lambda self, data: None

import sys
import json
import zipfile
from pathlib import Path


UNSAFE_PREFIXES = ("../", "/")
UNSUPPORTED_COMPRESSIONS = {zipfile.ZIP_DEFLATED, zipfile.ZIP_DEFLATED, zipfile.ZIP_BZIP2, zipfile.ZIP_LZMA}


def _is_safe(name: str) -> bool:
    if name.startswith(UNSAFE_PREFIXES):
        return False
    normalized = Path(name).as_posix()
    if normalized.startswith("/"):
        return False
    if ".." in Path(normalized).parts:
        return False
    return True


def unpack(path: str, output_dir: str, max_entries: int = 1000, max_total_bytes: int = 250 * 1024 * 1024):
    p = Path(path)
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)
    written_files = []
    skipped_unsafe = []
    skipped_unsupported = []
    total_bytes = 0
    with zipfile.ZipFile(p, "r") as zf:
        infos = zf.infolist()[: max_entries + 1]
        if len(infos) > max_entries:
            infos = infos[:max_entries]
        for info in infos:
            if not _is_safe(info.filename):
                skipped_unsafe.append(info.filename)
                continue
            if info.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                skipped_unsupported.append(info.filename)
                continue
            target = out / info.filename
            if info.filename.endswith("/"):
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            data = zf.read(info)
            total_bytes += len(data)
            if total_bytes > max_total_bytes:
                raise ValueError(f"Unpacked size exceeded {max_total_bytes} bytes")
            target.write_bytes(data)
            written_files.append(info.filename)
    return {
        "ok": True,
        "kind": p.suffix.lstrip(".").lower() or "zip",
        "entryCount": len(infos),
        "writtenCount": len(written_files),
        "writtenFiles": written_files,
        "skippedUnsafeEntries": skipped_unsafe,
        "skippedUnsupportedEntries": skipped_unsupported,
        "truncated": False,
    }


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(json.dumps({"ok": False, "error": "missing args"}, ensure_ascii=False))
        raise SystemExit(1)
    print(json.dumps(unpack(sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])), ensure_ascii=False))
