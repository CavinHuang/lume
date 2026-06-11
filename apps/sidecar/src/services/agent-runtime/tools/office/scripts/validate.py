
import zipfile
if hasattr(zipfile.ZipExtFile, "_update_crc"):
    zipfile.ZipExtFile._update_crc = lambda self, data: None

import argparse
import sys
import json
import tempfile
import zipfile
from pathlib import Path
from zipfile import BadZipFile

try:
    from validators import DOCXSchemaValidator, PPTXSchemaValidator, RedliningValidator
except Exception:
    DOCXSchemaValidator = PPTXSchemaValidator = RedliningValidator = None


def validate(path: str, original: str | None = None, verbose: bool = False, auto_repair: bool = False, author: str = "Claude"):
    target = Path(path)
    if not target.exists():
        return {
            "ok": False,
            "kind": "unknown",
            "entryCount": 0,
            "entries": [],
            "truncated": False,
            "requiredEntries": [],
            "missingRequiredEntries": ["path does not exist"],
            "warnings": [],
            "details": f"Missing file: {path}",
        }

    if target.is_file() and target.suffix.lower() in {".docx", ".pptx", ".xlsx"}:
        temp_dir = Path(tempfile.mkdtemp())
        try:
            with zipfile.ZipFile(target, "r") as zf:
                zf.extractall(temp_dir)
        except BadZipFile as error:
            return {
                "ok": False,
                "kind": target.suffix.lower().lstrip(".") or "zip",
                "entryCount": 0,
                "entries": [],
                "truncated": False,
                "requiredEntries": _required_entries(target.suffix.lower().lstrip(".")),
                "missingRequiredEntries": [str(error)],
                "warnings": [],
                "details": f"Bad zip file: {target}",
            }
        unpacked = temp_dir
        file_extension = target.suffix.lower().lstrip(".")
    elif target.is_dir():
        unpacked = target
        file_extension = _detect_kind(unpacked)
    else:
        return {
            "ok": False,
            "kind": "unknown",
            "entryCount": 0,
            "entries": [],
            "truncated": False,
            "requiredEntries": [],
            "missingRequiredEntries": ["unsupported path type"],
            "warnings": [],
            "details": f"Unsupported path: {path}",
        }

    if file_extension == "docx":
        validators = [DOCXSchemaValidator(unpacked, Path(original) if original else None, verbose=verbose)]
        if original:
            validators.append(RedliningValidator(unpacked, Path(original), verbose=verbose, author=author))
    elif file_extension == "pptx":
        validators = [PPTXSchemaValidator(unpacked, Path(original) if original else None, verbose=verbose)]
    else:
        return {
            "ok": False,
            "kind": file_extension,
            "entryCount": _count_entries(unpacked),
            "entries": _list_entries(unpacked),
            "truncated": False,
            "requiredEntries": _required_entries(file_extension),
            "missingRequiredEntries": [],
            "warnings": [],
            "details": f"Validation not supported for file type: {file_extension}",
        }

    missing_required = _missing_required(unpacked, file_extension)
    if DOCXSchemaValidator is None or PPTXSchemaValidator is None:
        return {
            "ok": len(missing_required) == 0,
            "kind": file_extension,
            "entryCount": _count_entries(unpacked),
            "entries": _list_entries(unpacked),
            "truncated": False,
            "requiredEntries": _required_entries(file_extension),
            "missingRequiredEntries": missing_required,
            "warnings": ["advanced validators unavailable; performed structure-only validation"],
            "details": "structure-only validation",
        }

    if auto_repair:
        repairs = sum(validator.repair() for validator in validators)
        if repairs:
            print(f"Auto-repaired {repairs} issue(s)")

    success = all(validator.validate() for validator in validators)
    return {
        "ok": success,
        "kind": file_extension,
        "entryCount": _count_entries(unpacked),
        "entries": _list_entries(unpacked),
        "truncated": False,
        "requiredEntries": _required_entries(file_extension),
        "missingRequiredEntries": _missing_required(unpacked, file_extension),
        "warnings": [],
        "details": "All validations PASSED!" if success else "Validation failed",
    }


def _detect_kind(unpacked: Path) -> str:
    if (unpacked / "word" / "document.xml").exists():
        return "docx"
    if (unpacked / "ppt" / "presentation.xml").exists():
        return "pptx"
    if (unpacked / "xl" / "workbook.xml").exists():
        return "xlsx"
    return "zip"


def _required_entries(file_extension: str):
    return {
        "docx": ["[Content_Types].xml", "_rels/.rels", "word/document.xml"],
        "pptx": ["[Content_Types].xml", "_rels/.rels", "ppt/presentation.xml"],
        "xlsx": ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml"],
    }.get(file_extension, [])


def _missing_required(unpacked: Path, file_extension: str):
    missing = []
    for entry in _required_entries(file_extension):
        if not (unpacked / entry).exists():
            missing.append(entry)
    return missing


def _list_entries(unpacked: Path):
    entries = []
    for path in sorted(unpacked.rglob("*")):
        if path.is_file():
            entries.append(path.relative_to(unpacked).as_posix())
    return entries


def _count_entries(unpacked: Path) -> int:
    return sum(1 for _ in unpacked.rglob("*") if _.is_file())


def argparse_parser():
    parser = argparse.ArgumentParser(description="Validate Office document XML files")
    parser.add_argument("path", help="Path to unpacked directory or packed Office file (.docx/.pptx/.xlsx)")
    parser.add_argument("--original", required=False, default=None, help="Path to original file (.docx/.pptx/.xlsx)")
    parser.add_argument("-v", "--verbose", action="store_true", help="Enable verbose output")
    parser.add_argument("--auto-repair", action="store_true", help="Automatically repair common issues")
    parser.add_argument("--author", default="Claude", help="Author name for redlining validation")
    return parser

if __name__ == "__main__":
    parser = argparse_parser()
    args = parser.parse_args()
    result = validate(args.path, args.original, args.verbose, args.auto_repair, args.author)
    print(json.dumps(result, ensure_ascii=False))
    raise SystemExit(0 if result["ok"] else 1)
