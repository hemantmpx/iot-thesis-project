#!/usr/bin/env python3
from __future__ import annotations
import re
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from xml.sax.saxutils import escape

W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
CP_NS = 'http://schemas.openxmlformats.org/package/2006/metadata/core-properties'
DC_NS = 'http://purl.org/dc/elements/1.1/'
DCTERMS_NS = 'http://purl.org/dc/terms/'
XSI_NS = 'http://www.w3.org/2001/XMLSchema-instance'
EP_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/extended-properties'
VT_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes'


def strip_inline_md(text: str) -> str:
    text = text.replace('**', '')
    text = text.replace('__', '')
    text = re.sub(r'`([^`]*)`', r'\1', text)
    text = re.sub(r'\*([^*]+)\*', r'\1', text)
    text = re.sub(r'_([^_]+)_', r'\1', text)
    text = text.replace('&nbsp;', ' ')
    return text


def parse_markdown(md_text: str):
    paras = []
    buf = []
    in_code = False

    def flush(style='Normal'):
        nonlocal buf
        if buf:
            text = ' '.join(line.strip() for line in buf).strip()
            if text:
                paras.append((style, strip_inline_md(text)))
            buf = []

    for raw in md_text.splitlines():
        line = raw.rstrip('\n')
        if line.startswith('```'):
            flush()
            in_code = not in_code
            continue
        if in_code:
            paras.append(('Code', line))
            continue
        stripped = line.strip()
        if not stripped:
            flush()
            continue
        if stripped.startswith('# '):
            flush()
            paras.append(('Title', strip_inline_md(stripped[2:].strip())))
            continue
        if stripped.startswith('## '):
            flush()
            paras.append(('Heading1', strip_inline_md(stripped[3:].strip())))
            continue
        if stripped.startswith('### '):
            flush()
            paras.append(('Heading2', strip_inline_md(stripped[4:].strip())))
            continue
        if stripped.startswith('#### '):
            flush()
            paras.append(('Heading3', strip_inline_md(stripped[5:].strip())))
            continue
        if re.match(r'^[-*]\s+', stripped):
            flush()
            paras.append(('List', '• ' + strip_inline_md(re.sub(r'^[-*]\s+', '', stripped))))
            continue
        if re.match(r'^\d+\.\s+', stripped):
            flush()
            paras.append(('List', strip_inline_md(stripped)))
            continue
        if stripped.startswith('|') and stripped.endswith('|'):
            flush()
            # Keep markdown tables readable as tab-delimited text.
            parts = [p.strip() for p in stripped.strip('|').split('|')]
            if set(''.join(parts)) <= {'-', ':'}:
                continue
            paras.append(('Code', ' | '.join(strip_inline_md(p) for p in parts)))
            continue
        buf.append(stripped)
    flush()
    return paras


def p_xml(style: str, text: str) -> str:
    text = escape(text)
    style_xml = f'<w:pPr><w:pStyle w:val="{style}"/></w:pPr>' if style != 'Normal' else ''
    # preserve multiple spaces via xml:space
    return f'<w:p>{style_xml}<w:r><w:t xml:space="preserve">{text}</w:t></w:r></w:p>'


def build_document_xml(paras) -> str:
    body = ''.join(p_xml(style, text) for style, text in paras)
    sect = (
        '<w:sectPr>'
        '<w:pgSz w:w="12240" w:h="15840"/>'
        '<w:pgMar w:top="1440" w:right="1080" w:bottom="1440" w:left="1080" w:header="720" w:footer="720" w:gutter="0"/>'
        '</w:sectPr>'
    )
    return (
        f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<w:document xmlns:w="{W_NS}" xmlns:r="{R_NS}"><w:body>{body}{sect}</w:body></w:document>'
    )


def styles_xml() -> str:
    return f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="{W_NS}">
  <w:docDefaults>
    <w:rPrDefault><w:rPr><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:rPrDefault>
    <w:pPrDefault><w:pPr><w:spacing w:after="120"/></w:pPr></w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:rPr><w:b/><w:sz w:val="34"/></w:rPr><w:pPr><w:spacing w:after="240"/></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="28"/></w:rPr><w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="24"/></w:rPr><w:pPr><w:spacing w:before="180" w:after="100"/></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="22"/></w:rPr><w:pPr><w:spacing w:before="120" w:after="80"/></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="List"><w:name w:val="List"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/><w:sz w:val="18"/></w:rPr><w:pPr><w:spacing w:after="60"/></w:pPr></w:style>
</w:styles>'''


def content_types_xml() -> str:
    return '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>'''


def rels_xml() -> str:
    return '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>'''


def document_rels_xml() -> str:
    return '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>'''


def core_xml(title: str) -> str:
    created = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    return f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="{CP_NS}" xmlns:dc="{DC_NS}" xmlns:dcterms="{DCTERMS_NS}" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="{XSI_NS}">
  <dc:title>{escape(title)}</dc:title>
  <dc:creator>OpenAI Codex</dc:creator>
  <cp:lastModifiedBy>OpenAI Codex</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">{created}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">{created}</dcterms:modified>
</cp:coreProperties>'''


def app_xml() -> str:
    return f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="{EP_NS}" xmlns:vt="{VT_NS}">
  <Application>OpenAI Codex</Application>
</Properties>'''


def build_docx(md_path: Path):
    text = md_path.read_text(encoding='utf-8')
    paras = parse_markdown(text)
    title = paras[0][1] if paras else md_path.stem
    out_path = md_path.with_suffix('.docx')
    with zipfile.ZipFile(out_path, 'w', compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr('[Content_Types].xml', content_types_xml())
        zf.writestr('_rels/.rels', rels_xml())
        zf.writestr('word/document.xml', build_document_xml(paras))
        zf.writestr('word/styles.xml', styles_xml())
        zf.writestr('word/_rels/document.xml.rels', document_rels_xml())
        zf.writestr('docProps/core.xml', core_xml(title))
        zf.writestr('docProps/app.xml', app_xml())
    return out_path


def main(argv):
    if len(argv) < 2:
        print('usage: export_simple_docx.py file1.md [file2.md ...]', file=sys.stderr)
        return 1
    for arg in argv[1:]:
        path = Path(arg)
        out = build_docx(path)
        print(out)
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv))
