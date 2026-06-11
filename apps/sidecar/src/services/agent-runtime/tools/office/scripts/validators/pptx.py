import re

try:
    import lxml.etree
except Exception:
    lxml = None

from .base import BaseSchemaValidator, HAS_ADVANCED_VALIDATORS, HAS_ADVANCED_VALIDATORS



class PPTXSchemaValidator(BaseSchemaValidator):
    PRESENTATIONML_NAMESPACE = "http://schemas.openxmlformats.org/presentationml/2006/main"

    def validate(self):
        if not self.validate_xml():
            return False
        all_valid = True
        if not self.validate_namespaces():
            all_valid = False
        if not self.validate_unique_ids():
            all_valid = False
        if HAS_ADVANCED_VALIDATORS:
            if not self.validate_uuid_ids():
                all_valid = False
        if not self.validate_file_references():
            all_valid = False
        if not self.validate_slide_layout_ids():
            all_valid = False
        if not self.validate_content_types():
            all_valid = False
        if not self.validate_against_xsd():
            all_valid = False
        if not self.validate_notes_slide_references():
            all_valid = False
        if not self.validate_all_relationship_ids():
            all_valid = False
        if not self.validate_no_duplicate_slide_layouts():
            all_valid = False
        return all_valid

    def validate_uuid_ids(self):
        if not HAS_ADVANCED_VALIDATORS:
            if self.verbose:
                print("PASSED - skipped uuid id validation (missing lxml)")
            return True
        errors = []
        pattern = re.compile(r"^[\{\(]?[0-9A-Fa-f]{8}-?[0-9A-Fa-f]{4}-?[0-9A-Fa-f]{4}-?[0-9A-Fa-f]{4}-?[0-9A-Fa-f]{12}[\}\)]?$")
        for xml_file in self.xml_files:
            try:
                root = lxml.etree.parse(str(xml_file)).getroot()
                for elem in root.iter():
                    for attr, value in elem.attrib.items():
                        attr_name = attr.split("}")[-1].lower()
                        if attr_name == "id" or attr_name.endswith("id"):
                            if self._looks_like_uuid(value) and not pattern.match(value):
                                errors.append(f"  {xml_file.relative_to(self.unpacked_dir)}: invalid UUID-like id {value}")
            except Exception as e:
                errors.append(f"  {xml_file.relative_to(self.unpacked_dir)}: {e}")
        if errors:
            print(f"FAILED - Found {len(errors)} UUID id violations:\n" + "\n".join(errors))
            return False
        if self.verbose:
            print("PASSED - All UUID-like ids are valid")
        return True

    def validate_all_relationship_ids(self):
        if not HAS_ADVANCED_VALIDATORS:
            if self.verbose:
                print("PASSED - skipped relationship id validation (missing lxml)")
            return True
        errors = []
        for rels_file in self.unpacked_dir.glob("**/*.rels"):
            try:
                root = lxml.etree.parse(str(rels_file)).getroot()
                ids = [
                    rel.get("Id")
                    for rel in root.findall(".//{http://schemas.openxmlformats.org/package/2006/relationships}Relationship")
                    if rel.get("Id")
                ]
                if len(ids) != len(set(ids)):
                    errors.append(f"  {rels_file.relative_to(self.unpacked_dir)}: duplicate relationship ids")
            except Exception as e:
                errors.append(f"  {rels_file.relative_to(self.unpacked_dir)}: {e}")
        if errors:
            print(f"FAILED - Found {len(errors)} relationship id issues:\n" + "\n".join(errors))
            return False
        if self.verbose:
            print("PASSED - All relationship ids are valid")
        return True

    def _looks_like_uuid(self, value: str) -> bool:
        cleaned = value.strip("{}()").replace("-", "")
        return len(cleaned) == 32 and all(c.isalnum() for c in cleaned)

    def validate_slide_layout_ids(self):
        if not HAS_ADVANCED_VALIDATORS:
            if self.verbose:
                print("PASSED - skipped slide layout validation (missing lxml)")
            return True
        errors = []
        slide_masters = list(self.unpacked_dir.glob("ppt/slideMasters/*.xml"))
        if not slide_masters:
            if self.verbose:
                print("PASSED - No slide masters found")
            return True
        for slide_master in slide_masters:
            try:
                master_root = lxml.etree.parse(str(slide_master)).getroot()
                rels_path = slide_master.parent / "_rels" / f"{slide_master.name}.rels"
                if not rels_path.exists():
                    errors.append(f"  {slide_master.relative_to(self.unpacked_dir)}: missing master rels")
                    continue
                rels_root = lxml.etree.parse(str(rels_path)).getroot()
                valid_rids = {rel.get("Id") for rel in rels_root.findall(".//{http://schemas.openxmlformats.org/package/2006/relationships}Relationship") if "slideLayout" in rel.get("Type", "")}
                for sld_layout_id in master_root.findall(f".//{{{self.PRESENTATIONML_NAMESPACE}}}sldLayoutId"):
                    rid = sld_layout_id.get(f"{{{self.OFFICE_RELATIONSHIPS_NAMESPACE}}}id")
                    layout_id = sld_layout_id.get("id")
                    if rid and rid not in valid_rids:
                        errors.append(f"  {slide_master.relative_to(self.unpacked_dir)}: sldLayoutId {layout_id} references missing r:id {rid}")
            except Exception as e:
                errors.append(f"  {slide_master.relative_to(self.unpacked_dir)}: {e}")
        if errors:
            print(f"FAILED - Found {len(errors)} slide layout id issues:\n" + "\n".join(errors))
            return False
        if self.verbose:
            print("PASSED - All slide layout ids are valid")
        return True

    def validate_notes_slide_references(self):
        if not HAS_ADVANCED_VALIDATORS:
            if self.verbose:
                print("PASSED - skipped notes slide validation (missing lxml)")
            return True
        errors = []
        notes_slide_references = {}
        for rels_file in self.unpacked_dir.glob("ppt/slides/_rels/*.xml.rels"):
            try:
                root = lxml.etree.parse(str(rels_file)).getroot()
                notes = [rel for rel in root.findall(".//{http://schemas.openxmlformats.org/package/2006/relationships}Relationship") if "notesSlide" in rel.get("Type", "")]
                if len(notes) > 1:
                    errors.append(f"  {rels_file.relative_to(self.unpacked_dir)}: multiple notesSlide references")
                for rel in notes:
                    target = rel.get("Target")
                    if target:
                        notes_slide_references.setdefault(target, []).append(str(rels_file))
            except Exception as e:
                errors.append(f"  {rels_file.relative_to(self.unpacked_dir)}: {e}")
        if errors:
            print(f"FAILED - Found {len(errors)} notes slide issues:\n" + "\n".join(errors))
            return False
        if self.verbose:
            print("PASSED - All notes slide references are valid")
        return True

    def validate_no_duplicate_slide_layouts(self):
        if not HAS_ADVANCED_VALIDATORS:
            if self.verbose:
                print("PASSED - skipped duplicate layout validation (missing lxml)")
            return True
        errors = []
        for rels_file in self.unpacked_dir.glob("ppt/slides/_rels/*.xml.rels"):
            try:
                root = lxml.etree.parse(str(rels_file)).getroot()
                layout_rels = [rel for rel in root.findall(".//{http://schemas.openxmlformats.org/package/2006/relationships}Relationship") if "slideLayout" in rel.get("Type", "")]
                if len(layout_rels) > 1:
                    errors.append(f"  {rels_file.relative_to(self.unpacked_dir)}: {len(layout_rels)} slideLayout references")
            except Exception as e:
                errors.append(f"  {rels_file.relative_to(self.unpacked_dir)}: {e}")
        if errors:
            print("FAILED - Found slides with duplicate slideLayout references:\n" + "\n".join(errors))
            return False
        if self.verbose:
            print("PASSED - No duplicate slideLayout references")
        return True
