#!/usr/bin/env python3
"""Build the printable BE012O1R field packet from the shared trip brief data."""

from __future__ import annotations

import argparse
import html
import json
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfbase import pdfmetrics
from reportlab.platypus import (
    Flowable,
    KeepTogether,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

ROOT = Path(__file__).resolve().parents[1]
DATA_PATH = ROOT / "lib" / "trip-brief.json"
DEFAULT_OUTPUT = ROOT / "output" / "pdf" / "be012o1r-field-packet-sep-26-29-2026.pdf"

PINE = colors.HexColor("#173A2A")
PINE_MID = colors.HexColor("#2F6650")
ORANGE = colors.HexColor("#D66B35")
ORANGE_SOFT = colors.HexColor("#F4DFD2")
PAPER = colors.HexColor("#F4F0E7")
INK = colors.HexColor("#14261D")
MUTED = colors.HexColor("#5D685F")
LINE = colors.HexColor("#D7D1C5")
STOP = colors.HexColor("#9C4036")


def safe(value: object) -> str:
    return html.escape(str(value), quote=True)


class RouteStrip(Flowable):
    def __init__(self, width: float):
        super().__init__()
        self.width = width
        self.height = 78
        self.nodes = [
            ("Rifle", "charge"),
            ("West Rifle", "2 nights"),
            ("Meeker", "loop"),
            ("Trappers", "hunt/camp"),
            ("Chapman", "optional"),
            ("Kremmling", "charge"),
        ]

    def draw(self) -> None:
        canvas = self.canv
        left = 18
        right = self.width - 18
        y = 43
        step = (right - left) / (len(self.nodes) - 1)
        canvas.setStrokeColor(PINE_MID)
        canvas.setLineWidth(2.2)
        canvas.line(left, y, right, y)
        for index, (name, detail) in enumerate(self.nodes):
            x = left + index * step
            optional = name == "Chapman"
            canvas.setFillColor(colors.white if optional else ORANGE)
            canvas.setStrokeColor(ORANGE if optional else PINE)
            canvas.setLineWidth(2)
            canvas.circle(x, y, 6, stroke=1, fill=1)
            canvas.setFillColor(INK)
            canvas.setFont("Helvetica-Bold", 7.5)
            canvas.drawCentredString(x, y + 13, name)
            canvas.setFillColor(MUTED)
            canvas.setFont("Helvetica", 6.5)
            canvas.drawCentredString(x, y - 17, detail)


def register_fonts() -> tuple[str, str, str]:
    candidates = [
        (
            "/System/Library/Fonts/Supplemental/Arial.ttf",
            "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
            "/System/Library/Fonts/Supplemental/Georgia.ttf",
        ),
        (
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
        ),
    ]
    for regular, bold, serif in candidates:
        if all(Path(path).exists() for path in (regular, bold, serif)):
            pdfmetrics.registerFont(TTFont("TripSans", regular))
            pdfmetrics.registerFont(TTFont("TripSansBold", bold))
            pdfmetrics.registerFont(TTFont("TripSerif", serif))
            return "TripSans", "TripSansBold", "TripSerif"
    return "Helvetica", "Helvetica-Bold", "Times-Roman"


def build_styles() -> dict[str, ParagraphStyle]:
    regular, bold, serif = register_fonts()
    base = getSampleStyleSheet()
    return {
        "title": ParagraphStyle(
            "TripTitle",
            parent=base["Title"],
            fontName=serif,
            fontSize=28,
            leading=30,
            textColor=colors.white,
            alignment=TA_LEFT,
            spaceAfter=5,
        ),
        "cover_meta": ParagraphStyle(
            "CoverMeta",
            fontName=regular,
            fontSize=8.5,
            leading=11,
            textColor=colors.HexColor("#DCE7DF"),
        ),
        "kicker": ParagraphStyle(
            "Kicker",
            fontName=bold,
            fontSize=7.2,
            leading=9,
            textColor=ORANGE,
            spaceAfter=3,
        ),
        "h1": ParagraphStyle(
            "TripH1",
            fontName=serif,
            fontSize=21,
            leading=23,
            textColor=PINE,
            spaceAfter=8,
        ),
        "h2": ParagraphStyle(
            "TripH2",
            fontName=bold,
            fontSize=11,
            leading=13,
            textColor=INK,
            spaceAfter=5,
        ),
        "body": ParagraphStyle(
            "TripBody",
            fontName=regular,
            fontSize=8.2,
            leading=11.2,
            textColor=INK,
            spaceAfter=4,
        ),
        "small": ParagraphStyle(
            "TripSmall",
            fontName=regular,
            fontSize=7.2,
            leading=9.5,
            textColor=MUTED,
        ),
        "small_bold": ParagraphStyle(
            "TripSmallBold",
            fontName=bold,
            fontSize=7.2,
            leading=9.5,
            textColor=INK,
        ),
        "tag": ParagraphStyle(
            "TripTag",
            fontName=bold,
            fontSize=6.8,
            leading=8,
            textColor=ORANGE,
            spaceAfter=4,
        ),
        "center": ParagraphStyle(
            "TripCenter",
            fontName=bold,
            fontSize=7.2,
            leading=9,
            textColor=INK,
            alignment=TA_CENTER,
        ),
        "source": ParagraphStyle(
            "TripSource",
            fontName=regular,
            fontSize=6.6,
            leading=8.5,
            textColor=PINE_MID,
        ),
    }


def card_table(cells: list[list[object]], widths: list[float], padding: float = 8) -> Table:
    table = Table(cells, colWidths=widths, hAlign="LEFT")
    table.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("BOX", (0, 0), (-1, -1), 0.6, LINE),
                ("INNERGRID", (0, 0), (-1, -1), 0.45, LINE),
                ("BACKGROUND", (0, 0), (-1, -1), colors.white),
                ("LEFTPADDING", (0, 0), (-1, -1), padding),
                ("RIGHTPADDING", (0, 0), (-1, -1), padding),
                ("TOPPADDING", (0, 0), (-1, -1), padding),
                ("BOTTOMPADDING", (0, 0), (-1, -1), padding),
            ]
        )
    )
    return table


def section_heading(number: str, title: str, subtitle: str, styles: dict[str, ParagraphStyle]) -> Table:
    badge = Table([[Paragraph(number, styles["center"])]], colWidths=[0.3 * inch], rowHeights=[0.3 * inch])
    badge.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), PINE),
                ("TEXTCOLOR", (0, 0), (-1, -1), colors.white),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("ALIGN", (0, 0), (-1, -1), "CENTER"),
            ]
        )
    )
    copy = [Paragraph(safe(title), styles["h1"]), Paragraph(safe(subtitle), styles["small"])]
    table = Table([[badge, copy]], colWidths=[0.42 * inch, 6.3 * inch])
    table.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0)]))
    return table


def page_footer(canvas, doc) -> None:
    canvas.saveState()
    width, _ = letter
    canvas.setStrokeColor(LINE)
    canvas.setLineWidth(0.5)
    canvas.line(doc.leftMargin, 0.38 * inch, width - doc.rightMargin, 0.38 * inch)
    canvas.setFillColor(MUTED)
    canvas.setFont("Helvetica", 6.5)
    canvas.drawString(doc.leftMargin, 0.24 * inch, "HUNT ASSIST / BE012O1R / PREPARED SEP 26 2026")
    canvas.drawRightString(width - doc.rightMargin, 0.24 * inch, f"PAGE {doc.page}")
    canvas.restoreState()


def build_pdf(output: Path) -> None:
    trip = json.loads(DATA_PATH.read_text(encoding="utf-8"))
    styles = build_styles()
    output.parent.mkdir(parents=True, exist_ok=True)
    doc = SimpleDocTemplate(
        str(output),
        pagesize=letter,
        rightMargin=0.46 * inch,
        leftMargin=0.46 * inch,
        topMargin=0.46 * inch,
        bottomMargin=0.52 * inch,
        title=trip["title"],
        author="Hunt Assist",
        subject="Legality-first field packet for BE012O1R",
    )
    usable = letter[0] - doc.leftMargin - doc.rightMargin
    story: list[object] = []

    cover = Table(
        [[
            [
                Paragraph("HUNT ASSIST / FIELD PACKET", styles["kicker"]),
                Paragraph(safe(trip["title"]), styles["title"]),
                Paragraph(f"{safe(trip['subtitle'])}<br/>Prepared {safe(trip['prepared'])}", styles["cover_meta"]),
            ]
        ]],
        colWidths=[usable],
    )
    cover.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), PINE),
                ("LEFTPADDING", (0, 0), (-1, -1), 20),
                ("RIGHTPADDING", (0, 0), (-1, -1), 20),
                ("TOPPADDING", (0, 0), (-1, -1), 18),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 18),
            ]
        )
    )
    story.extend([cover, Spacer(1, 8)])

    posture = Table(
        [[Paragraph("LEGALITY-FIRST POSTURE", styles["tag"]), Paragraph(safe(trip["stance"]), styles["body"])]],
        colWidths=[1.35 * inch, usable - 1.35 * inch],
    )
    posture.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#FFF7F0")),
                ("BOX", (0, 0), (-1, -1), 0.8, colors.HexColor("#DFB08F")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 9),
                ("RIGHTPADDING", (0, 0), (-1, -1), 9),
                ("TOPPADDING", (0, 0), (-1, -1), 8),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
            ]
        )
    )
    story.extend([posture, Spacer(1, 8)])

    hunt = trip["hunt"]
    hunt_cells = [[
        Paragraph(f"<b>HUNT</b><br/>{safe(hunt['code'])}<br/>{safe(hunt['species'])}", styles["small"]),
        Paragraph(f"<b>SEASON</b><br/>{safe(hunt['season'])}<br/>{safe(hunt['legalHours'])}", styles["small"]),
        Paragraph(f"<b>UNITS</b><br/>{safe(hunt['units'])}<br/>{safe(hunt['method'])}", styles["small"]),
    ]]
    story.extend([card_table(hunt_cells, [usable / 3] * 3, padding=7), Spacer(1, 5), RouteStrip(usable), Spacer(1, 4)])
    story.append(section_heading("01", "Run of trip", "Two nights at West Rifle Creek, then the Meeker loop.", styles))
    story.append(Spacer(1, 7))

    itinerary_cells: list[list[object]] = []
    days = trip["itinerary"]
    for row_start in range(0, len(days), 2):
        row = []
        for day in days[row_start : row_start + 2]:
            row.append(
                [
                    Paragraph(safe(day["day"]), styles["tag"]),
                    Paragraph(safe(day["title"]), styles["h2"]),
                    Paragraph(safe(day["plan"]), styles["body"]),
                    Paragraph(f"<b>Sleep:</b> {safe(day['sleep'])}", styles["small"]),
                    Spacer(1, 3),
                    Paragraph(f"<b>Legal hinge:</b> {safe(day['decision'])}", styles["small"]),
                ]
            )
        itinerary_cells.append(row)
    story.append(card_table(itinerary_cells, [usable / 2] * 2, padding=8))

    story.extend([PageBreak(), section_heading("02", "Hard legal rules", "The governing requirements; optional caution margins are not promoted to law.", styles), Spacer(1, 8)])
    rule_rows: list[list[object]] = []
    for rule in trip["legalRules"]:
        rule_rows.append(
            [
                Paragraph(safe(rule["label"]), styles["tag"]),
                [
                    Paragraph(safe(rule["rule"]), styles["body"]),
                    Paragraph(f"<b>FIELD:</b> {safe(rule['fieldAction'])}", styles["small_bold"]),
                ],
            ]
        )
    rules_table = Table(rule_rows, colWidths=[1.08 * inch, usable - 1.08 * inch], repeatRows=0)
    rules_table.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("ROWBACKGROUNDS", (0, 0), (-1, -1), [colors.white, colors.HexColor("#FAF8F3")]),
                ("BOX", (0, 0), (-1, -1), 0.6, LINE),
                ("INNERGRID", (0, 0), (-1, -1), 0.45, LINE),
                ("LEFTPADDING", (0, 0), (-1, -1), 8),
                ("RIGHTPADDING", (0, 0), (-1, -1), 8),
                ("TOPPADDING", (0, 0), (-1, -1), 8),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
            ]
        )
    )
    story.append(rules_table)
    story.extend([Spacer(1, 8), Paragraph("FAST GO / NO-GO", styles["kicker"])] )
    for decision in trip["goNoGo"]:
        story.append(Paragraph(f"- {safe(decision)}", styles["body"]))

    story.extend([PageBreak(), section_heading("03", "Camp and charge cards", "Legal eligibility first; road judgment stays with the driver in the field.", styles), Spacer(1, 8)])
    for camp in trip["camps"]:
        stop = camp["fit"] == "INELIGIBLE"
        cell = [
            Paragraph(safe(camp["fit"]), styles["tag"]),
            Paragraph(safe(camp["name"]), styles["h2"]),
            Paragraph(f"<b>PLACE:</b> {safe(camp['location'])}", styles["small"]),
            Paragraph(f"<b>AUTHORITY:</b> {safe(camp['legal'])}", styles["body"]),
            Paragraph(f"<b>FOOD:</b> {safe(camp['food'])}", styles["body"]),
            Paragraph(safe(camp["note"]), styles["small"]),
        ]
        table = Table([[cell]], colWidths=[usable])
        table.setStyle(
            TableStyle(
                [
                    ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#FFF7F7") if stop else colors.white),
                    ("BOX", (0, 0), (-1, -1), 0.7, colors.HexColor("#D9A6A0") if stop else LINE),
                    ("LEFTPADDING", (0, 0), (-1, -1), 10),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 10),
                    ("TOPPADDING", (0, 0), (-1, -1), 8),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
                ]
            )
        )
        story.extend([KeepTogether(table), Spacer(1, 6)])

    charge_cells = []
    for charger in trip["charging"]:
        charge_cells.append(
            [
                Paragraph("CHARGE", styles["tag"]),
                Paragraph(safe(charger["name"]), styles["h2"]),
                Paragraph(safe(charger["address"]), styles["small_bold"]),
                Paragraph(safe(charger["detail"]), styles["small"]),
            ]
        )
    story.extend([Spacer(1, 2), card_table([charge_cells], [usable / 2] * 2, padding=8)])

    story.extend([PageBreak(), section_heading("04", "Scout cards", "Rule-screen starts; these are map anchors, not automatic shooting positions.", styles), Spacer(1, 6)])
    story.append(Paragraph("Confirm public access, the true facility and road boundary, current signs, legal hours, target identity, and a safe backstop before occupying or shooting from any point.", styles["body"]))
    for card in trip["scoutCards"]:
        options = []
        for option in card["options"]:
            options.append(
                [
                    Paragraph(f"<b>{safe(option['id'])} / {safe(option['name'])}</b>", styles["body"]),
                    Paragraph(safe(option["coordinates"]), styles["small_bold"]),
                    Paragraph(f"{safe(option['sourceDistance'])}<br/>{safe(option['ruleRoute'])}<br/>{safe(option['mapSignal'])}", styles["small"]),
                ]
            )
        header = [
            Paragraph(safe(card["target"]), styles["h2"]),
            Paragraph(f"Base: {safe(card['camp'])}", styles["small"]),
        ]
        block = Table([[header], [card_table([options], [usable / 2] * 2, padding=7)]], colWidths=[usable])
        block.setStyle(
            TableStyle(
                [
                    ("BOX", (0, 0), (-1, -1), 0.7, LINE),
                    ("BACKGROUND", (0, 0), (-1, 0), PAPER),
                    ("LEFTPADDING", (0, 0), (-1, -1), 8),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 8),
                    ("TOPPADDING", (0, 0), (-1, -1), 7),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
                ]
            )
        )
        story.extend([KeepTogether(block), Spacer(1, 7)])

    story.extend([PageBreak(), section_heading("05", "Departure and recovery", "The things that are hard to fix after cell service ends.", styles), Spacer(1, 8)])
    left = [Paragraph("PACK BEFORE DEPARTURE", styles["kicker"])]
    for item in trip["checklist"]:
        left.append(Paragraph(f"[ ] {safe(item)}", styles["body"]))
    right = [Paragraph("CONTACTS", styles["kicker"])]
    for contact in trip["contacts"]:
        right.append(Paragraph(f"<b>{safe(contact['label'])}</b><br/>{safe(contact['value'])}", styles["small"] ))
        right.append(Spacer(1, 4))
    story.append(card_table([[left, right]], [usable * 0.62, usable * 0.38], padding=9))
    story.extend([Spacer(1, 12), Paragraph("OFFICIAL SOURCES", styles["kicker"]), Spacer(1, 2)])
    source_rows = []
    for index, source in enumerate(trip["sources"], start=1):
        source_rows.append(
            [
                Paragraph(str(index), styles["small_bold"]),
                Paragraph(f'<link href="{safe(source["url"])}">{safe(source["label"])}</link><br/><font color="#5D685F">{safe(source["url"])}</font>', styles["source"]),
            ]
        )
    source_table = Table(source_rows, colWidths=[0.36 * inch, usable - 0.36 * inch])
    source_table.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("ROWBACKGROUNDS", (0, 0), (-1, -1), [colors.white, colors.HexColor("#FAF8F3")]),
                ("LEFTPADDING", (0, 0), (-1, -1), 5),
                ("RIGHTPADDING", (0, 0), (-1, -1), 5),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]
        )
    )
    story.append(source_table)
    story.extend([Spacer(1, 8), Paragraph(f"Prepared {safe(trip['prepared'])}. Posted orders, closures, property boundaries, and the physical license control over this planning aid.", styles["small_bold"])])

    doc.build(story, onFirstPage=page_footer, onLaterPages=page_footer)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    build_pdf(args.output.resolve())
    print(args.output.resolve())


if __name__ == "__main__":
    main()
