from __future__ import annotations

from io import BytesIO
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import letter
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen.canvas import Canvas
from reportlab.lib.utils import ImageReader


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "generated"
PAGE_WIDTH, PAGE_HEIGHT = letter


def draw_header(canvas: Canvas, title: str, page_number: int) -> None:
    canvas.setFillColor(HexColor("#345c4c"))
    canvas.setFont("Helvetica-Bold", 11)
    canvas.drawString(54, PAGE_HEIGHT - 50, "LexiAnchor PDF test fixture")
    canvas.setFillColor(HexColor("#20211f"))
    canvas.setFont("Helvetica-Bold", 24)
    canvas.drawString(54, PAGE_HEIGHT - 96, title)
    canvas.setStrokeColor(HexColor("#d8d5ce"))
    canvas.line(54, PAGE_HEIGHT - 112, PAGE_WIDTH - 54, PAGE_HEIGHT - 112)
    canvas.setFillColor(HexColor("#6b6d67"))
    canvas.setFont("Helvetica", 9)
    canvas.drawRightString(PAGE_WIDTH - 54, 36, f"Page {page_number} of 3")


def draw_paragraph(canvas: Canvas, lines: list[str], y: float) -> float:
    text = canvas.beginText(54, y)
    text.setFont("Helvetica", 12)
    text.setFillColor(HexColor("#20211f"))
    text.setLeading(19)
    for line in lines:
        text.textLine(line)
    canvas.drawText(text)
    return y - len(lines) * 19 - 18


def register_cjk_font() -> str:
    candidates = (
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "C:/Windows/Fonts/msyh.ttc",
    )
    for candidate in candidates:
        if Path(candidate).exists():
            pdfmetrics.registerFont(TTFont("FixtureCJK", candidate))
            return "FixtureCJK"
    pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
    return "STSong-Light"


def create_text_pdf(path: Path) -> None:
    cjk_font = register_cjk_font()
    canvas = Canvas(str(path), pagesize=letter, pageCompression=1)
    canvas.setTitle("Anchored Pages")
    canvas.setAuthor("LexiAnchor")

    draw_header(canvas, "A stable page", 1)
    y = draw_paragraph(
        canvas,
        [
            "A resilient reader keeps the page steady while the learner explores a new word.",
            "Select resilient to verify that the text layer preserves the complete sentence.",
            "The visual page and selectable text should remain aligned at every supported zoom.",
        ],
        PAGE_HEIGHT - 150,
    )
    y = draw_paragraph(
        canvas,
        [
            "This document is owned by the LexiAnchor project. It contains no DRM, remote",
            "resources, embedded scripts, or third-party copyrighted passages.",
        ],
        y,
    )
    canvas.setFont("Helvetica-Oblique", 11)
    canvas.setFillColor(HexColor("#345c4c"))
    canvas.drawString(54, y, "English text layer baseline - 100% scale")
    canvas.showPage()

    draw_header(canvas, "Language and spacing", 2)
    y = draw_paragraph(
        canvas,
        [
            "French: La lecture attentive protège le rythme et réduit les interruptions.",
            "Accents: café, élève, forêt, déjà, où, façade.",
            "Numbers and symbols: 24%, 1.5x, CFI, PDF, EPUB, and e-mail.",
        ],
        PAGE_HEIGHT - 150,
    )
    canvas.setFont(cjk_font, 13)
    canvas.setFillColor(HexColor("#20211f"))
    canvas.drawString(54, y, "中文：清晰的文字层应当与页面保持对齐。")
    canvas.showPage()

    draw_header(canvas, "Zoom and position", 3)
    draw_paragraph(
        canvas,
        [
            "The final page verifies navigation and persisted page position.",
            "Zooming changes the viewport, never the source PDF.",
            "Returning to this file should restore page three and the chosen scale.",
        ],
        PAGE_HEIGHT - 150,
    )
    canvas.save()


def load_scan_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = (
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "C:/Windows/Fonts/arial.ttf",
    )
    for candidate in candidates:
        if Path(candidate).exists():
            return ImageFont.truetype(candidate, size=size)
    return ImageFont.load_default()


def create_scanned_pdf(path: Path) -> None:
    image = Image.new("RGB", (1224, 1584), "#f7f4e9")
    draw = ImageDraw.Draw(image)
    title_font = load_scan_font(52)
    body_font = load_scan_font(28)
    draw.text((110, 120), "Image-only reading sample", fill="#20211f", font=title_font)
    draw.line((110, 205, 1114, 205), fill="#b8b2a3", width=3)
    scan_lines = (
        "This page looks like text, but it is a single raster image.",
        "LexiAnchor should render it while disabling selection features.",
        "OCR is intentionally outside the MVP.",
    )
    y = 270
    for line in scan_lines:
        draw.text((110, y), line, fill="#343631", font=body_font)
        y += 62
    draw.rectangle((110, 520, 1114, 1260), outline="#c8c1b2", width=3)
    draw.text((150, 590), "SCAN", fill="#8b8578", font=title_font)

    png = BytesIO()
    image.save(png, format="PNG", optimize=True)
    png.seek(0)

    canvas = Canvas(str(path), pagesize=letter, pageCompression=1)
    canvas.setTitle("Image-only PDF")
    canvas.setAuthor("LexiAnchor")
    canvas.drawImage(ImageReader(png), 0, 0, width=PAGE_WIDTH, height=PAGE_HEIGHT)
    canvas.save()


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    create_text_pdf(OUTPUT / "lexianchor-text.pdf")
    create_scanned_pdf(OUTPUT / "lexianchor-scan.pdf")


if __name__ == "__main__":
    main()
