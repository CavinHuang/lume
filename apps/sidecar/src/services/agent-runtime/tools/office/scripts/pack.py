import sys
import json
import shutil
import tempfile
import zipfile
from pathlib import Path

from validators import DOCXSchemaValidator, PPTXSchemaValidator

SUPPORTED_SUFFIXES = {".docx", ".pptx", ".xlsx"}


def pack(input_directory: str, output_file: str, max_entries: int = 1000, max_total_bytes: int = 250 * 1024 * 1024, original_path: str | None = None, skip_validate: bool = False):
    input_path = Path(input_directory)
    output_path = Path(output_file)
    if not input_path.exists() or not input_path.is_dir():
        raise ValueError(f"inputDir does not exist: {input_directory}")
    if output_path.exists():
        raise ValueError(f"outputPath already exists: {output_file}")
    try:
        relative = output_path.relative_to(input_path)
    except ValueError:
        pass
    else:
        raise ValueError("office_pack outputPath must be outside inputDir")
    suffix = output_path.suffix.lower()
    if suffix not in SUPPORTED_SUFFIXES:
        raise ValueError(f"outputPath must be one of {sorted(SUPPORTED_SUFFIXES)}")

    entries = _collect_entries(input_path, max_entries, max_total_bytes)
    original = Path(original_path) if original_path else None

    if not skip_validate and original and original.exists() and original.suffix.lower() == suffix:
        validator = DOCXSchemaValidator(input_path, original) if suffix == ".docx" else PPTXSchemaValidator(input_path, original) if suffix == ".pptx" else None
        if validator is not None:
            repairs = validator.repair()
            if repairs:
                print(f"Auto-repaired {repairs} issue(s)")
            if not validator.validate():
                raise ValueError("Validation failed for packed contents")

    with tempfile.TemporaryDirectory() as temp_dir:
        packed_root = Path(temp_dir) / "content"
        shutil.copytree(input_path, packed_root)
        _condense_xml_files(packed_root)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(output_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            for file_path in sorted(packed_root.rglob("*")):
                if file_path.is_file():
                    zf.write(file_path, file_path.relative_to(packed_root))

    kind = suffix.lstrip(".") or "zip"
    return {
        "ok": True,
        "kind": kind,
        "entryCount": len(entries),
        "entries": [name for name, _ in entries],
        "originalPath": str(original) if original else None,
        "skipValidate": bool(skip_validate),
    }


def _collect_entries(input_path: Path, max_entries: int, max_total_bytes: int):
    entries = []
    total_bytes = 0
    for file_path in sorted(input_path.rglob("*")):
        if not file_path.is_file():
            continue
        rel = file_path.relative_to(input_path).as_posix()
        entries.append((rel, file_path))
        total_bytes += file_path.stat().st_size
        if len(entries) > max_entries or total_bytes > max_total_bytes:
            raise ValueError("Packed size or entry count exceeded configured limits")
    return entries


def _condense_xml_files(root: Path):
    for xml_file in list(root.rglob("*.xml")) + list(root.rglob("*.rels")):
        try:
            text = xml_file.read_text(encoding="utf-8")
            text = _minify_xml(text)
            xml_file.write_text(text, encoding="utf-8")
        except Exception:
            pass


def _minify_xml(text: str) -> str:
    import re
    text = re.sub(r">\s+<", "><", text)
    text = re.sub(r"\s{2,}", " ", text)
    return text.strip()


def argparse_parser():
    import argparse
    parser = argparse.ArgumentParser(description="Pack a directory into a DOCX, PPTX, or XLSX file")
    parser.add_argument("input_directory", help="Unpacked Office document directory")
    parser.add_argument("output_file", help="Output Office file (.docx/.pptx/.xlsx)")
    parser.add_argument("--max-entries", type=int, default=1000, help="Maximum file entries")
    parser.add_argument("--max-total-bytes", type=int, default=250 * 1024 * 1024, help="Maximum total bytes")
    parser.add_argument("--original-path", default=None, help="Original file path for validation")
    parser.add_argument("--skip-validate", action="store_true", help="Skip validation")
    return parser

if __name__ == "__main__":
    parser = argparse_parser()
    args = parser.parse_args()
    result = pack(args.input_directory, args.output_file, args.max_entries, args.max_total_bytes, args.original_path, args.skip_validate)
    print(json.dumps(result, ensure_ascii=False))
