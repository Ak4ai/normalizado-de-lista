#!/usr/bin/env python3
"""Normalize exercise lists from PDF and generate a clean PDF with answer space."""

from __future__ import annotations

import argparse
import re
from pathlib import Path
from typing import List, Sequence

import fitz  # PyMuPDF


# Matches: R1 – ..., Questao 01, Q2, Exercicio 3  (solution-list PDFs)
DEFAULT_BLOCK_START_REGEX = (
    r"(?im)^\s*(?:"
    r"quest(?:ao|\u00e3o)\s*\d+|"
    r"q\s*\d+|"
    r"r\s*\d+|"
    r"exerc(?:icio|\u00edcio)\s*\d+"
    r")\b[^\n]*"
)

# Matches: 1. Dado ... or 1) Dado ...  (numbered exercise-list PDFs)
NUMBERED_BLOCK_START_REGEX = r"(?m)^\s*(?:[1-9]\d{0,2})[\.)]\s+\S"

PDF_HEADER_PATTERN = re.compile(
    r"(?im)^\s*(?:"
    r"centro federal.*|"
    r"campus .*|"
    r"pesquisa operacional.*|"
    r"lista\s*\d+.*|"
    r"prof\.:.*"
    r")\s*$"
)

SOLUTION_START_PATTERN = re.compile(
    r"(?i)\b(?:max\s+z|min\s+z|sujeito\s+a|resolu[cç][aã]o|gabarito|solu[cç][aã]o\s*[=:])\b"
)

# Patterns that strongly indicate a solution-list PDF
_SOLUTION_LIST_PATTERNS = re.compile(
    r"(?im)^\s*(?:r\s*\d+|q\s*\d+|quest(?:ao|\u00e3o)\s*\d+)\s*[\-\u2013\u2014]"
)


def convert_simple_pattern_to_regex(simple_pattern: str) -> str:
    r"""Convert simplified manual pattern to regex.
    
    Examples:
        "1) O diagrama..." -> r"(?m)^\s*(?:[1-9]\d{0,2})\)\s*O\s+diagrama"
        "1) Quando..." -> r"(?m)^\s*(?:[1-9]\d{0,2})\)\s*Quando"
    
    Rules:
        - "1)" becomes regex for any number with parenthesis
        - Text until "..." is treated as literal (escaped for regex)
        - "..." means stop matching pattern (content after can vary)
    """
    # Remove leading/trailing whitespace
    pattern = simple_pattern.strip()
    
    # Replace "1)" with number regex
    pattern = re.sub(r"^\s*1\s*\)", "NUMBER)", pattern)
    
    # Find where "..." appears (if at all)
    if "..." in pattern:
        pattern = pattern.replace("...", "")
    
    # Escape special regex characters except our NUMBER placeholder
    escaped = re.escape(pattern)
    escaped = escaped.replace(r"NUMBER\)", r"(?:[1-9]\d{0,2})\)")
    
    # Build final regex: match at line start, allow leading whitespace
    # Collapse multiple spaces into single space in pattern
    escaped = re.sub(r"\\ +", r"\\s+", escaped)
    
    final_regex = r"(?m)^\s*" + escaped
    
    return final_regex



def find_questions_start(text: str) -> int:
    """Find where questions start by looking for "1)" or "1." followed by actual content.
    Returns 0 if no clear start is found."""
    # Look for "1)" or "1." at line start, followed by capitalized word or common question words
    # This avoids matching "1)" in headers or metadata
    match = re.search(
        r"(?m)^\s*1\s*[\.)]\s+(?:[A-Z]|\b(?:O|Um|Uma|Dado|Quando|Qual|Determine|Encontre)\b)",
        text,
        re.IGNORECASE
    )
    if match:
        return match.start()
    return 0


def detect_block_style(text: str):
    """Return (start_regex, should_strip_solutions) based on PDF content."""
    solution_hits = len(_SOLUTION_LIST_PATTERNS.findall(text))
    numbered_hits = len(re.findall(NUMBERED_BLOCK_START_REGEX, text))
    if solution_hits >= numbered_hits:
        has_solutions = bool(SOLUTION_START_PATTERN.search(text))
        return DEFAULT_BLOCK_START_REGEX, has_solutions
    return NUMBERED_BLOCK_START_REGEX, False


def extract_text_from_pdf(pdf_path: Path) -> str:
    """Extract plain text from all pages of a PDF."""
    parts: List[str] = []
    with fitz.open(pdf_path) as pdf_doc:
        for page in pdf_doc:
            parts.append(page.get_text("text"))

    text = "\n".join(parts)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def split_into_exercise_blocks(text: str, start_regex: str) -> List[str]:
    """Split text into blocks that start with headings like 'Questao 01' or 'R1'."""
    pattern = re.compile(start_regex)
    matches = list(pattern.finditer(text))

    if not matches:
        cleaned = text.strip()
        return [cleaned] if cleaned else []

    blocks: List[str] = []
    for idx, match in enumerate(matches):
        start = match.start()
        end = matches[idx + 1].start() if idx + 1 < len(matches) else len(text)
        block = text[start:end].strip()
        if block:
            blocks.append(block)

    return blocks


def sanitize_text(text: str) -> str:
    """Remove common page header/footer artifacts and normalize whitespace."""
    lines: List[str] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if PDF_HEADER_PATTERN.match(line):
            continue
        if re.fullmatch(r"\d+", line):
            continue
        lines.append(line)

    cleaned = " ".join(lines)
    cleaned = re.sub(r"\s{2,}", " ", cleaned)
    return cleaned.strip()


def remove_resolution_from_block(block: str) -> str:
    """Keep only statement text and drop solved parts when detected."""
    cleaned = sanitize_text(block)
    if not cleaned:
        return ""

    heading_match = re.match(
        r"(?is)^\s*("
        r"(?:r\s*\d+|q\s*\d+|quest(?:ao|\u00e3o)\s*\d+|exerc(?:icio|\u00edcio)\s*\d+)"
        r"\s*[\-\u2013\u2014:]?"
        r")\s*(.*)$",
        cleaned,
    )
    if heading_match:
        heading = heading_match.group(1).strip()
        body = heading_match.group(2).strip()
    else:
        heading = "Exercicio"
        body = cleaned

    marker_match = SOLUTION_START_PATTERN.search(body)
    if marker_match:
        body = body[: marker_match.start()].strip()

    question_pos = body.find("?")
    if question_pos != -1:
        body = body[: question_pos + 1].strip()

    body = re.sub(r"\s{2,}", " ", body)
    body = body.strip("-:; ")

    return f"{heading} {body}".strip()


def clean_exercise_blocks(blocks: Sequence[str], strip_solutions: bool = True) -> List[str]:
    """Apply solution-removal rules and discard empty blocks."""
    cleaned_blocks: List[str] = []
    for block in blocks:
        cleaned = remove_resolution_from_block(block) if strip_solutions else sanitize_text(block)
        if cleaned:
            cleaned_blocks.append(cleaned)
    return cleaned_blocks


def wrap_text_lines(text: str, font_name: str, font_size: float, max_width: float) -> List[str]:
    """Wrap text to fit in the available width using font metrics."""
    wrapped: List[str] = []
    for paragraph in text.splitlines():
        paragraph = paragraph.strip()
        if not paragraph:
            continue

        words = paragraph.split()
        if not words:
            continue

        current = words[0]
        for word in words[1:]:
            candidate = f"{current} {word}"
            width = fitz.get_text_length(candidate, fontname=font_name, fontsize=font_size)
            if width <= max_width:
                current = candidate
            else:
                wrapped.append(current)
                current = word
        wrapped.append(current)

    return wrapped


def _draw_grid(
    page: fitz.Page,
    y_top: float,
    grid_height: float,
    grid_left: float,
    grid_right: float,
    cell_size: float,
) -> None:
    """Draw a squared grid box on the page."""
    grid_bottom = y_top + grid_height
    page.draw_rect(
        fitz.Rect(grid_left, y_top, grid_right, grid_bottom),
        color=(0.7, 0.7, 0.7),
        width=0.6,
    )
    h = y_top + cell_size
    while h < grid_bottom:
        page.draw_line(
            fitz.Point(grid_left, h), fitz.Point(grid_right, h),
            color=(0.8, 0.8, 0.8), width=0.5,
        )
        h += cell_size
    v = grid_left + cell_size
    while v < grid_right:
        page.draw_line(
            fitz.Point(v, y_top), fitz.Point(v, grid_bottom),
            color=(0.85, 0.85, 0.85), width=0.4,
        )
        v += cell_size


def write_blocks_to_pdf(blocks: Sequence[str], output_path: Path, answer_space_lines: int) -> None:
    """Write exercises to PDF and insert blank answer space after each item."""
    doc = fitz.open()

    page_width = 595  # A4 portrait
    page_height = 842
    margin = 48
    title_size = 15
    text_size = 11
    text_line_height = 16
    answer_cell_size = 16
    section_gap = 14
    label_h = 16        # height of the "Espaco para resolucao:" label row

    usable_height = page_height - 2 * margin

    page = doc.new_page(width=page_width, height=page_height)
    y = margin

    title = "Lista com espaco para resolucao"
    page.insert_text(
        fitz.Point(margin, y + title_size),
        title, fontname="helv", fontsize=title_size,
    )
    y += title_size + 12

    text_width = page_width - (2 * margin)
    effective_answer_lines = answer_space_lines * 2
    grid_height = effective_answer_lines * answer_cell_size
    grid_block_h = label_h + grid_height  # grid label + grid box

    def new_page() -> fitz.Page:
        return doc.new_page(width=page_width, height=page_height)

    for idx, block in enumerate(blocks, start=1):
        text = f"{idx}. {block}"
        lines = wrap_text_lines(text, font_name="helv", font_size=text_size, max_width=text_width)

        text_h = len(lines) * text_line_height
        total_block_h = text_h + section_gap + grid_block_h

        if total_block_h <= usable_height:
            # Entire block fits on one page – keep enunciado + grid together
            if y + total_block_h > page_height - margin:
                page = new_page()
                y = margin
            for line in lines:
                page.insert_text(
                    fitz.Point(margin, y + text_size),
                    line, fontname="helv", fontsize=text_size,
                )
                y += text_line_height
        else:
            # Text is too long for one page – spread across pages normally
            remaining = list(lines)
            while remaining:
                available = page_height - margin - y
                max_lines = int(available // text_line_height)
                if max_lines <= 0:
                    page = new_page()
                    y = margin
                    continue
                chunk = remaining[:max_lines]
                for line in chunk:
                    page.insert_text(
                        fitz.Point(margin, y + text_size),
                        line, fontname="helv", fontsize=text_size,
                    )
                    y += text_line_height
                remaining = remaining[max_lines:]
                if remaining:
                    page = new_page()
                    y = margin

        # Ensure grid (label + box) fits on the current page after the text
        if y + section_gap + grid_block_h > page_height - margin:
            page = new_page()
            y = margin
        else:
            y += section_gap

        page.insert_text(
            fitz.Point(margin, y + 10),
            "Espaco para resolucao:",
            fontname="helv", fontsize=10,
        )
        y += label_h

        _draw_grid(page, y, grid_height, margin, page_width - margin, answer_cell_size)
        y += grid_height + section_gap

    output_path.parent.mkdir(parents=True, exist_ok=True)
    doc.save(output_path)
    doc.close()


OUTPUT_DIR = Path("saida")


def select_pdf_interactive(search_dir: Path) -> Path:
    """List PDF files in search_dir and let the user pick one interactively."""
    pdfs = sorted(search_dir.glob("*.pdf"))
    # Exclude any PDFs inside the output folder itself
    pdfs = [p for p in pdfs if OUTPUT_DIR not in p.parents and p.parent == search_dir]

    if not pdfs:
        raise SystemExit("Nenhum arquivo PDF encontrado na pasta atual.")

    print("\nPDFs disponiveis:")
    for i, pdf in enumerate(pdfs, start=1):
        print(f"  [{i}] {pdf.name}")
    print()

    while True:
        raw = input("Escolha o numero do PDF a processar: ").strip()
        if raw.isdigit() and 1 <= int(raw) <= len(pdfs):
            return pdfs[int(raw) - 1]
        print(f"  Entrada invalida. Digite um numero entre 1 e {len(pdfs)}.")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Extrai exercicios de um PDF, remove partes resolvidas e gera um .pdf "
            "com espaco quadriculado para resolucao."
        )
    )
    parser.add_argument(
        "input_pdf",
        type=Path,
        nargs="?",
        default=None,
        help="Caminho do PDF de entrada (opcional; se omitido, sera solicitado interativamente).",
    )
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        default=None,
        help="Caminho do .pdf de saida (padrao: saida/<nome_entrada>_resolucao.pdf).",
    )
    parser.add_argument(
        "-b",
        "--answer-space-lines",
        type=int,
        default=8,
        help="Quantidade de linhas de resolucao apos cada exercicio (sera duplicada internamente).",
    )
    parser.add_argument(
        "-p",
        "--simple-pattern",
        type=str,
        default=None,
        help="Padrão simplificado manual para filtrar questões (ex: '1) O diagrama...' ou '1) Quando...').",
    )
    parser.add_argument(
        "--start-regex",
        default=DEFAULT_BLOCK_START_REGEX,
        help="Regex para detectar o inicio de cada exercicio.",
    )
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    # --- Selecao do PDF de entrada ---
    if args.input_pdf is None:
        input_pdf = select_pdf_interactive(Path("."))
    else:
        input_pdf = args.input_pdf
        if not input_pdf.exists():
            parser.error(f"Arquivo de entrada nao encontrado: {input_pdf}")

    # --- Caminho de saida ---
    if args.output is not None:
        output_pdf = args.output
    else:
        OUTPUT_DIR.mkdir(exist_ok=True)
        stem = re.sub(r"[^\w]+", "_", input_pdf.stem).strip("_").lower()
        output_pdf = OUTPUT_DIR / f"{stem}_resolucao.pdf"

    if args.answer_space_lines < 0:
        parser.error("O numero de linhas de espaco deve ser >= 0.")

    raw_text = extract_text_from_pdf(input_pdf)
    if not raw_text:
        parser.error("Nao foi possivel extrair texto do PDF informado.")

    # Remove header/structure before questions start (e.g., keep only from "1)" onwards)
    questions_start = find_questions_start(raw_text)
    if questions_start > 0:
        raw_text = raw_text[questions_start:]

    # Determine which regex pattern to use (in priority order)
    # 1. User provided a simple pattern
    # 2. User provided a custom regex
    # 3. Auto-detect from PDF content
    if args.simple_pattern:
        detected_regex = convert_simple_pattern_to_regex(args.simple_pattern)
        should_strip = True
        pattern_source = f"padrão simplificado: {args.simple_pattern}"
    elif args.start_regex != DEFAULT_BLOCK_START_REGEX:
        detected_regex = args.start_regex
        should_strip = True
        pattern_source = "regex customizado"
    else:
        detected_regex, should_strip = detect_block_style(raw_text)
        pattern_source = "detectado automaticamente"

    blocks = split_into_exercise_blocks(raw_text, detected_regex)
    cleaned_blocks = clean_exercise_blocks(blocks, strip_solutions=should_strip)
    if not cleaned_blocks:
        parser.error("Nenhum bloco de exercicio foi encontrado no texto extraido.")

    write_blocks_to_pdf(cleaned_blocks, output_pdf, args.answer_space_lines)
    print(f"\nConcluido! Arquivo gerado: {output_pdf.resolve()}")
    print(f"Padrão usado       : {pattern_source}")
    print(f"Blocos detectados  : {len(blocks)}")
    print(f"Blocos apos limpeza: {len(cleaned_blocks)}")


if __name__ == "__main__":
    main()
