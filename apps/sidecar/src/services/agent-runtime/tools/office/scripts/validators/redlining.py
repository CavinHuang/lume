import subprocess
import tempfile
import zipfile
from pathlib import Path


class RedliningValidator:
    def __init__(self, unpacked_dir, original_docx, verbose=False, author="Claude"):
        self.unpacked_dir = Path(unpacked_dir)
        self.original_docx = Path(original_docx)
        self.verbose = verbose
        self.author = author
        self.namespaces = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}

    def repair(self) -> int:
        return 0

    def validate(self):
        modified_file = self.unpacked_dir / "word" / "document.xml"
        if not modified_file.exists():
            print(f"FAILED - Modified document.xml not found at {modified_file}")
            return False
        try:
            import xml.etree.ElementTree as ET

            root = ET.parse(modified_file).getroot()
            del_elements = root.findall(".//w:del", self.namespaces)
            ins_elements = root.findall(".//w:ins", self.namespaces)
            author_del = [elem for elem in del_elements if elem.get(f"{{{self.namespaces['w']}}}author") == self.author]
            author_ins = [elem for elem in ins_elements if elem.get(f"{{{self.namespaces['w']}}}author") == self.author]
            if not author_del and not author_ins:
                if self.verbose:
                    print(f"PASSED - No tracked changes by {self.author} found.")
                return True
        except Exception:
            pass
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            try:
                with zipfile.ZipFile(self.original_docx, "r") as zip_ref:
                    zip_ref.extractall(temp_path)
            except Exception as e:
                print(f"FAILED - Error unpacking original docx: {e}")
                return False
            original_file = temp_path / "word" / "document.xml"
            if not original_file.exists():
                print(f"FAILED - Original document.xml not found in {self.original_docx}")
                return False
            try:
                import xml.etree.ElementTree as ET

                modified_root = ET.parse(modified_file).getroot()
                original_root = ET.parse(original_file).getroot()
            except Exception as e:
                print(f"FAILED - Error parsing XML files: {e}")
                return False
            self._remove_author_tracked_changes(original_root)
            self._remove_author_tracked_changes(modified_root)
            modified_text = self._extract_text_content(modified_root)
            original_text = self._extract_text_content(original_root)
            if modified_text != original_text:
                print("FAILED - Document text doesn't match after removing tracked changes")
                return False
            if self.verbose:
                print(f"PASSED - All changes by {self.author} are properly tracked")
            return True

    def _remove_author_tracked_changes(self, root):
        ins_tag = f"{{{self.namespaces['w']}}}ins"
        del_tag = f"{{{self.namespaces['w']}}}del"
        author_attr = f"{{{self.namespaces['w']}}}author"
        for parent in root.iter():
            to_remove = [child for child in parent if child.tag == ins_tag and child.get(author_attr) == self.author]
            for elem in to_remove:
                parent.remove(elem)
        for parent in root.iter():
            to_process = [(child, list(parent).index(child)) for child in parent if child.tag == del_tag and child.get(author_attr) == self.author]
            for del_elem, del_index in reversed(to_process):
                self._replace_deletion_with_insertion(parent, del_elem, del_index)

    def _replace_deletion_with_insertion(self, parent, del_elem, index):
        ins = __import__("xml.etree.ElementTree").Element(f"{{{self.namespaces['w']}}}ins")
        ins.set(f"{{{self.namespaces['w']}}}author", self.author)
        ins.set(f"{{{self.namespaces['w']}}}date", "1970-01-01T00:00:00Z")
        for child in list(del_elem):
            ins.append(child)
        parent.insert(index, ins)
        parent.remove(del_elem)

    def _extract_text_content(self, root):
        texts = []
        for elem in root.iter():
            if elem.tag.endswith("}t") and elem.text:
                texts.append(elem.text)
        return "\n".join(texts)
