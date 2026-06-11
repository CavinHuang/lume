import re

try:
    import lxml.etree
except Exception:
    lxml = None
import tempfile
import zipfile
from pathlib import Path

from .base import BaseSchemaValidator, HAS_ADVANCED_VALIDATORS, HAS_ADVANCED_VALIDATORS


class DOCXSchemaValidator(BaseSchemaValidator):
    WORD_2006_NAMESPACE = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
    W14_NAMESPACE = "http://schemas.microsoft.com/office/word/2010/wordml"
    W16CID_NAMESPACE = "http://schemas.microsoft.com/office/word/2016/wordml/cid"

    def validate(self):
        if not self.validate_xml():
            return False
        all_valid = True
        if not self.validate_namespaces():
            all_valid = False
        if not self.validate_unique_ids():
            all_valid = False
        if not self.validate_file_references():
            all_valid = False
        if not self.validate_content_types():
            all_valid = False
        if not self.validate_against_xsd():
            all_valid = False
        if not self.validate_whitespace_preservation():
            all_valid = False
        if not self.validate_deletions():
            all_valid = False
        if not self.validate_insertions():
            all_valid = False
        if not self.validate_all_relationship_ids():
            all_valid = False
        if not self.validate_id_constraints():
            all_valid = False
        if not self.validate_comment_markers():
            all_valid = False
        self.compare_paragraph_counts()
        return all_valid

    def validate_deletions(self):
        errors = []
        for xml_file in self.xml_files:
            if xml_file.name != "document.xml":
                continue
            try:
                root = lxml.etree.parse(str(xml_file)).getroot() if HAS_ADVANCED_VALIDATORS else __import__("xml.etree.ElementTree").parse(str(xml_file)).getroot()
                namespaces = {"w": self.WORD_2006_NAMESPACE}
                if HAS_ADVANCED_VALIDATORS:
                    for t_elem in root.xpath(".//w:del//w:t", namespaces=namespaces):
                        if t_elem.text:
                            errors.append(f"  {xml_file.relative_to(self.unpacked_dir)}: <w:t> inside <w:del>")
                    for instr_elem in root.xpath(".//w:del//w:instrText", namespaces=namespaces):
                        errors.append(f"  {xml_file.relative_to(self.unpacked_dir)}: <w:instrText> inside <w:del>")
                else:
                    for del_elem in root.findall(".//w:del", namespaces):
                        for t_elem in del_elem.findall(".//w:t", namespaces):
                            if t_elem.text:
                                errors.append(f"  {xml_file.relative_to(self.unpacked_dir)}: <w:t> inside <w:del>")
                        if del_elem.find(".//w:instrText", namespaces) is not None:
                            errors.append(f"  {xml_file.relative_to(self.unpacked_dir)}: <w:instrText> inside <w:del>")
            except Exception as e:
                errors.append(f"  {xml_file.relative_to(self.unpacked_dir)}: {e}")
        if errors:
            print(f"FAILED - Found {len(errors)} deletion violations:\n" + "\n".join(errors))
            return False
        if self.verbose:
            print("PASSED - No invalid deletion content")
        return True

    def validate_insertions(self):
        errors = []
        for xml_file in self.xml_files:
            if xml_file.name != "document.xml":
                continue
            try:
                root = lxml.etree.parse(str(xml_file)).getroot() if HAS_ADVANCED_VALIDATORS else __import__("xml.etree.ElementTree").parse(str(xml_file)).getroot()
                namespaces = {"w": self.WORD_2006_NAMESPACE}
                if HAS_ADVANCED_VALIDATORS:
                    invalid_elements = root.xpath(".//w:ins//w:delText[not(ancestor::w:del)]", namespaces=namespaces)
                else:
                    invalid_elements = [elem for elem in root.iter() if elem.tag.endswith("delText") and elem.find("..//{http://schemas.openxmlformats.org/wordprocessingml/2006/main}del") is None]
                for elem in invalid_elements:
                    errors.append(f"  {xml_file.relative_to(self.unpacked_dir)}: invalid delText outside <w:del>")
            except Exception as e:
                errors.append(f"  {xml_file.relative_to(self.unpacked_dir)}: {e}")
        if errors:
            print(f"FAILED - Found {len(errors)} insertion violations:\n" + "\n".join(errors))
            return False
        if self.verbose:
            print("PASSED - No invalid insertion content")
        return True

    def validate_all_relationship_ids(self):
        if not HAS_ADVANCED_VALIDATORS:
            return True
        errors = []
        for xml_file in self.xml_files:
            if xml_file.suffix != ".rels":
                continue
            try:
                root = lxml.etree.parse(str(xml_file)).getroot()
                rels = root.findall(".//{http://schemas.openxmlformats.org/package/2006/relationships}Relationship")
                ids = [rel.get("Id") for rel in rels if rel.get("Id")]
                if len(ids) != len(set(ids)):
                    errors.append(f"  {xml_file.relative_to(self.unpacked_dir)}: duplicate relationship ids")
            except Exception as e:
                errors.append(f"  {xml_file.relative_to(self.unpacked_dir)}: {e}")
        if errors:
            print(f"FAILED - Found {len(errors)} relationship id issues:\n" + "\n".join(errors))
            return False
        if self.verbose:
            print("PASSED - All relationship ids are unique")
        return True

    def validate_id_constraints(self):
        if not HAS_ADVANCED_VALIDATORS:
            return True
        errors = []
        for xml_file in self.xml_files:
            try:
                root = lxml.etree.parse(str(xml_file)).getroot()
                for elem in root.iter():
                    if elem.tag.endswith("}sdt"):
                        if elem.get("id") is None:
                            errors.append(f"  {xml_file.relative_to(self.unpacked_dir)}: sdt missing id")
            except Exception as e:
                errors.append(f"  {xml_file.relative_to(self.unpacked_dir)}: {e}")
        if errors:
            print(f"FAILED - Found {len(errors)} id constraint issues:\n" + "\n".join(errors))
            return False
        if self.verbose:
            print("PASSED - All id constraints are valid")
        return True

    def validate_comment_markers(self):
        if not HAS_ADVANCED_VALIDATORS:
            return True
        errors = []
        comment_marker_paths = [
            "word/commentsIds.xml",
            "word/commentsExtended.xml",
            "word/commentsExtensible.xml",
        ]
        comment_xml = self.unpacked_dir / "word" / "comments.xml"
        if not comment_xml.exists():
            return True
        for rel_path in comment_marker_paths:
            if not (self.unpacked_dir / rel_path).exists():
                errors.append(f"  Missing {rel_path} for comments")
        if errors:
            print(f"FAILED - Found {len(errors)} comment marker issues:\n" + "\n".join(errors))
            return False
        if self.verbose:
            print("PASSED - Comment markers are valid")
        return True
