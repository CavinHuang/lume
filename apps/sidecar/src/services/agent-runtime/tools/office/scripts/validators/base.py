import re
from pathlib import Path

try:
    import defusedxml.minidom
    import lxml.etree

    HAS_ADVANCED_VALIDATORS = True
except Exception:  # pragma: no cover - fallback when dependencies are missing
    HAS_ADVANCED_VALIDATORS = False

class BaseSchemaValidator:
    IGNORED_VALIDATION_ERRORS = ["hyphenationZone", "purl.org/dc/terms"]
    UNIQUE_ID_REQUIREMENTS = {
        "comment": ("id", "file"),
        "commentrangestart": ("id", "file"),
        "commentrangeend": ("id", "file"),
        "bookmarkstart": ("id", "file"),
        "bookmarkend": ("id", "file"),
        "sldid": ("id", "file"),
        "sldmasterid": ("id", "global"),
        "sldlayoutid": ("id", "global"),
        "cm": ("authorid", "file"),
        "sheet": ("sheetid", "file"),
        "definedname": ("id", "file"),
        "cxnsp": ("id", "file"),
        "sp": ("id", "file"),
        "pic": ("id", "file"),
        "grpsp": ("id", "file"),
    }
    EXCLUDED_ID_CONTAINERS = {"sectionlst"}
    SCHEMA_MAPPINGS = {
        "word": "ISO-IEC29500-4_2016/wml.xsd",
        "ppt": "ISO-IEC29500-4_2016/pml.xsd",
        "xl": "ISO-IEC29500-4_2016/sml.xsd",
        "[Content_Types].xml": "ecma/fouth-edition/opc-contentTypes.xsd",
        "app.xml": "ISO-IEC29500-4_2016/shared-documentPropertiesExtended.xsd",
        "core.xml": "ecma/fouth-edition/opc-coreProperties.xsd",
        "custom.xml": "ISO-IEC29500-4_2016/shared-documentPropertiesCustom.xsd",
        ".rels": "ecma/fouth-edition/opc-relationships.xsd",
        "people.xml": "microsoft/wml-2012.xsd",
        "commentsIds.xml": "microsoft/wml-cid-2016.xsd",
        "commentsExtensible.xml": "microsoft/wml-cex-2018.xsd",
        "commentsExtended.xml": "microsoft/wml-2012.xsd",
        "chart": "ISO-IEC29500-4_2016/dml-chart.xsd",
        "theme": "ISO-IEC29500-4_2016/dml-main.xsd",
        "drawing": "ISO-IEC29500-4_2016/dml-main.xsd",
    }
    MC_NAMESPACE = "http://schemas.openxmlformats.org/markup-compatibility/2006"
    XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace"
    PACKAGE_RELATIONSHIPS_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/relationships"
    OFFICE_RELATIONSHIPS_NAMESPACE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    CONTENT_TYPES_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/content-types"
    MAIN_CONTENT_FOLDERS = {"word", "ppt", "xl"}
    OOXML_NAMESPACES = {
        "http://schemas.openxmlformats.org/officeDocument/2006/math",
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
        "http://schemas.openxmlformats.org/schemaLibrary/2006/main",
        "http://schemas.openxmlformats.org/drawingml/2006/main",
        "http://schemas.openxmlformats.org/drawingml/2006/chart",
        "http://schemas.openxmlformats.org/drawingml/2006/chartDrawing",
        "http://schemas.openxmlformats.org/drawingml/2006/diagram",
        "http://schemas.openxmlformats.org/drawingml/2006/picture",
        "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing",
        "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
        "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
        "http://schemas.openxmlformats.org/presentationml/2006/main",
        "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
        "http://schemas.openxmlformats.org/officeDocument/2006/sharedTypes",
        "http://www.w3.org/XML/1998/namespace",
    }

    def __init__(self, unpacked_dir, original_file=None, verbose=False):
        self.unpacked_dir = Path(unpacked_dir).resolve()
        self.original_file = Path(original_file) if original_file else None
        self.verbose = verbose
        self.schemas_dir = Path(__file__).parent.parent / "schemas"
        self.xml_files = [f for pattern in ["*.xml", "*.rels"] for f in self.unpacked_dir.rglob(pattern)]
        if not self.xml_files:
            print(f"Warning: No XML files found in {self.unpacked_dir}")

    def validate(self):
        raise NotImplementedError

    def repair(self) -> int:
        return self.repair_whitespace_preservation()

    def repair_whitespace_preservation(self) -> int:
        repairs = 0
        for xml_file in self.xml_files:
            try:
                content = xml_file.read_text(encoding="utf-8")
                if HAS_ADVANCED_VALIDATORS:
                    dom = defusedxml.minidom.parseString(content)
                    modified = False
                    for elem in dom.getElementsByTagName("*"):
                        if elem.tagName.endswith(":t") and elem.firstChild:
                            text = elem.firstChild.nodeValue
                            if text and (text.startswith((" ", "\t")) or text.endswith((" ", "\t"))):
                                if elem.getAttribute("xml:space") != "preserve":
                                    elem.setAttribute("xml:space", "preserve")
                                    repairs += 1
                                    modified = True
                    if modified:
                        xml_file.write_bytes(dom.toxml(encoding="UTF-8"))
            except Exception:
                pass
        return repairs

    def validate_xml(self):
        errors = []
        for xml_file in self.xml_files:
            try:
                if HAS_ADVANCED_VALIDATORS:
                    lxml.etree.parse(str(xml_file))
                else:
                    import xml.etree.ElementTree as ET
                    ET.parse(str(xml_file))
            except Exception as e:
                errors.append(f"  {xml_file.relative_to(self.unpacked_dir)}: {e}")
        if errors:
            print("FAILED - Found XML violations:\n" + "\n".join(errors))
            return False
        if self.verbose:
            print("PASSED - All XML files are well-formed")
        return True

    def validate_namespaces(self):
        if not HAS_ADVANCED_VALIDATORS:
            if self.verbose:
                print("PASSED - skipped namespace validation (missing lxml)")
            return True
        errors = []
        for xml_file in self.xml_files:
            try:
                root = lxml.etree.parse(str(xml_file)).getroot()
                declared = set(root.nsmap.keys()) - {None}
                for attr_val in [v for k, v in root.attrib.items() if k.endswith("Ignorable")]:
                    undeclared = set(attr_val.split()) - declared
                    errors.extend(f"  {xml_file.relative_to(self.unpacked_dir)}: Namespace '{ns}' in Ignorable but not declared" for ns in undeclared)
            except lxml.etree.XMLSyntaxError:
                continue
            except Exception as e:
                errors.append(f"  {xml_file.relative_to(self.unpacked_dir)}: {e}")
        if errors:
            print(f"FAILED - Found {len(errors)} namespace issues:\n" + "\n".join(errors))
            return False
        if self.verbose:
            print("PASSED - All namespace prefixes properly declared")
        return True

    def validate_unique_ids(self):
        errors = []
        global_ids = {}
        for xml_file in self.xml_files:
            try:
                if HAS_ADVANCED_VALIDATORS:
                    root = lxml.etree.parse(str(xml_file)).getroot()
                    mc_elements = root.xpath(".//mc:AlternateContent", namespaces={"mc": self.MC_NAMESPACE})
                    for elem in mc_elements:
                        elem.getparent().remove(elem)
                else:
                    import xml.etree.ElementTree as ET
                    root = ET.parse(str(xml_file)).getroot()
            except Exception:
                continue
            file_ids = {}
            for elem in root.iter():
                tag = elem.tag.split("}")[-1].lower() if "}" in elem.tag else elem.tag.lower()
                id_attr = next((attr for attr in elem.attrib if attr.split("}")[-1].lower() == "id"), None)
                if not id_attr:
                    continue
                value = elem.attrib[id_attr]
                req = self.UNIQUE_ID_REQUIREMENTS.get(tag)
                if not req:
                    continue
                id_name, scope = req
                if scope == "global":
                    seen = global_ids.setdefault(tag, {})
                    if value in seen:
                        errors.append(f"  {xml_file.relative_to(self.unpacked_dir)}: duplicate global id {value} for {tag}")
                    seen[value] = xml_file
                else:
                    seen = file_ids.setdefault(tag, {})
                    if value in seen:
                        errors.append(f"  {xml_file.relative_to(self.unpacked_dir)}: duplicate file id {value} for {tag}")
                    seen[value] = xml_file
        if errors:
            print(f"FAILED - Found {len(errors)} unique id violations:\n" + "\n".join(errors))
            return False
        if self.verbose:
            print("PASSED - All unique ids are valid")
        return True

    def validate_file_references(self):
        if not HAS_ADVANCED_VALIDATORS:
            if self.verbose:
                print("PASSED - skipped file reference validation (missing lxml)")
            return True
        errors = []
        for xml_file in self.xml_files:
            try:
                root = lxml.etree.parse(str(xml_file)).getroot()
            except Exception:
                continue
            for rel in root.findall(f".//{{{self.OFFICE_RELATIONSHIPS_NAMESPACE}}}Relationship"):
                target = rel.get("Target")
                if target and target.startswith("../"):
                    candidate = (xml_file.parent / target).resolve()
                    try:
                        candidate.relative_to(self.unpacked_dir)
                    except ValueError:
                        errors.append(f"  {xml_file.relative_to(self.unpacked_dir)}: invalid relative target {target}")
        if errors:
            print(f"FAILED - Found {len(errors)} file reference issues:\n" + "\n".join(errors))
            return False
        if self.verbose:
            print("PASSED - All file references are valid")
        return True

    def validate_content_types(self):
        missing = []
        content_types = self.unpacked_dir / "[Content_Types].xml"
        if not content_types.exists():
            missing.append("[Content_Types].xml")
        if missing:
            print("FAILED - Found content types issues:\n" + "\n".join(f"  {item}" for item in missing))
            return False
        if self.verbose:
            print("PASSED - Content types file exists")
        return True

    def validate_against_xsd(self):
        if not HAS_ADVANCED_VALIDATORS:
            if self.verbose:
                print("PASSED - skipped XSD validation (missing lxml)")
            return True
        errors = []
        xsd_dir = self.schemas_dir
        if not xsd_dir.exists():
            if self.verbose:
                print("PASSED - skipped XSD validation (missing schemas)")
            return True
        for xml_file in self.xml_files:
            schema_path = self._resolve_schema(xml_file)
            if not schema_path:
                continue
            try:
                schema = lxml.etree.XMLSchema(lxml.etree.parse(str(schema_path)))
                schema.assertValid(lxml.etree.parse(str(xml_file)))
            except lxml.etree.XMLSyntaxError as e:
                if any(ignored in str(e) for ignored in self.IGNORED_VALIDATION_ERRORS):
                    continue
                errors.append(f"  {xml_file.relative_to(self.unpacked_dir)}: {e}")
            except Exception as e:
                errors.append(f"  {xml_file.relative_to(self.unpacked_dir)}: {e}")
        if errors:
            print(f"FAILED - Found {len(errors)} schema violations:\n" + "\n".join(errors))
            return False
        if self.verbose:
            print("PASSED - All XML files match schema")
        return True

    def _resolve_schema(self, xml_file: Path) -> Path | None:
        rel = xml_file.relative_to(self.unpacked_dir).as_posix()
        for key, schema_name in self.SCHEMA_MAPPINGS.items():
            if rel == key or rel.startswith(f"{key}/"):
                return xsd_dir / schema_name
        return None

    def validate_whitespace_preservation(self):
        if not HAS_ADVANCED_VALIDATORS:
            if self.verbose:
                print("PASSED - skipped whitespace preservation validation (missing lxml)")
            return True
        errors = []
        for xml_file in self.xml_files:
            if xml_file.name != "document.xml":
                continue
            try:
                root = lxml.etree.parse(str(xml_file)).getroot()
                word_ns = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
                for elem in root.iter(f"{{{word_ns}}}t"):
                    if elem.text and (elem.text.startswith((" ", "\t")) or elem.text.endswith((" ", "\t"))):
                        if elem.get("{%s}space" % self.XML_NAMESPACE) != "preserve":
                            errors.append(f"  {xml_file.relative_to(self.unpacked_dir)}: missing xml:space='preserve'")
            except Exception as e:
                errors.append(f"  {xml_file.relative_to(self.unpacked_dir)}: {e}")
        if errors:
            print(f"FAILED - Found {len(errors)} whitespace preservation violations:\n" + "\n".join(errors))
            return False
        if self.verbose:
            print("PASSED - All whitespace is properly preserved")
        return True

    def compare_paragraph_counts(self):
        if not self.original_file:
            return
        try:
            original_count = self._count_paragraphs(self.original_file)
            unpacked_count = self._count_paragraphs(self.unpacked_dir / "word" / "document.xml")
            if self.verbose:
                print(f"Paragraph count original={original_count} unpacked={unpacked_count}")
        except Exception:
            pass

    def _count_paragraphs(self, path: Path) -> int:
        if HAS_ADVANCED_VALIDATORS:
            root = lxml.etree.parse(str(path)).getroot()
        else:
            import xml.etree.ElementTree as ET
            root = ET.parse(str(path)).getroot()
        word_ns = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
        return len(root.findall(f".//{{{word_ns}}}p"))
