import sys
import json
from pathlib import Path

COMMENTS_PATH = "word/comments.xml"
COMMENTS_EXT_PATH = "word/commentsExtended.xml"
COMMENTS_IDS_PATH = "word/commentsIds.xml"
COMMENTS_RELS_PATH = "word/_rels/comments.xml.rels"


def add_comment(unpacked_dir: str, comment_id: int, text: str, author: str = "Assistant", parent_id: int | None = None):
    root = Path(unpacked_dir)
    comments_path = root / COMMENTS_PATH
    if not comments_path.exists():
        raise ValueError(f"Missing {COMMENTS_PATH}")
    body = comments_path.read_text(encoding="utf-8")
    safe_text = text.replace("&", "&").replace("<", "<").replace(">", ">")
    safe_author = author.replace("&", "&").replace("<", "<").replace(">", ">")
    insert = (
        f'<w:comment w:id="{comment_id}" w:author="{safe_author}" w:date="2026-01-01T00:00:00Z" '
        f'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        f"<w:p><w:r><w:t>{safe_text}</w:t></w:r></w:p>"
        f"</w:comment>"
    )
    if "</w:comments>" in body:
        body = body.replace("</w:comments>", insert + "</w:comments>")
    else:
        body += insert
    comments_path.write_text(body, encoding="utf-8")
    rels_path = root / COMMENTS_RELS_PATH
    rels_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'
    )
    if rels_path.exists():
        rels_xml = rels_path.read_text(encoding="utf-8")
    if "comments.xml" not in rels_xml:
        rels_xml = rels_xml.replace("</Relationships>", '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/></Relationships>')
    rels_path.write_text(rels_xml, encoding="utf-8")
    return {"ok": True, "unpacked_dir": unpacked_dir, "comment_id": comment_id, "text": text, "author": author, "parent_id": parent_id, "added": True}


if __name__ == "__main__":
    if len(sys.argv) < 4:
        print(json.dumps({"ok": False, "error": "missing args"}, ensure_ascii=False))
        raise SystemExit(1)
    parent_id = int(sys.argv[5]) if len(sys.argv) > 5 and sys.argv[5] != "" else None
    print(json.dumps(add_comment(sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4], parent_id), ensure_ascii=False))
