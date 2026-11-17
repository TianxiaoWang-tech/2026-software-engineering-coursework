"""Dump a DOCX to plain text (paragraphs + tables) for review."""
import sys
from docx import Document
from docx.table import Table
from docx.text.paragraph import Paragraph


def iter_block_items(parent):
    from docx.oxml.ns import qn
    body = parent.element.body
    for child in body.iterchildren():
        if child.tag == qn("w:p"):
            yield Paragraph(child, parent)
        elif child.tag == qn("w:tbl"):
            yield Table(child, parent)


def main(src, dst):
    doc = Document(src)
    out = []
    for block in iter_block_items(doc):
        if isinstance(block, Paragraph):
            text = block.text.strip()
            if text:
                style = block.style.name if block.style is not None else ""
                out.append(f"[{style}] {text}")
        else:
            out.append("<TABLE %dx%d>" % (len(block.rows), len(block.columns)))
            for row in block.rows:
                cells = [c.text.replace("\n", " / ").strip() for c in row.cells]
                out.append("| " + " | ".join(cells) + " |")
            out.append("</TABLE>")
    with open(dst, "w", encoding="utf-8") as f:
        f.write("\n".join(out))
    print("paragraphs:", len(doc.paragraphs), "tables:", len(doc.tables))
    print("chars:", len("\n".join(out)))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
