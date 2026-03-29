"""
engine.py – processamento de PDF para a interface web.
Roda dentro do Pyodide (WebAssembly) no browser.
Todas as funções retornam tipos simples (str, list, bytes) para o JS.
"""
from __future__ import annotations
import re
import json
from typing import List

import fitz  # PyMuPDF (pymupdf)

# ---------------------------------------------------------------------------
# Padrões de detecção de blocos
# ---------------------------------------------------------------------------
DEFAULT_BLOCK_START_REGEX = (
    r"(?im)^\s*(?:"
    r"quest(?:ao|\u00e3o)\s*\d+|"
    r"q\s*\d+|"
    r"r\s*\d+|"
    r"exerc(?:icio|\u00edcio)\s*\d+"
    r")\b[^\n]*"
)
NUMBERED_BLOCK_START_REGEX = r"(?m)^\s*(?:[1-9]\d{0,2})\.[ \t]+\S"

_SOLUTION_LIST_PAT = re.compile(
    r"(?im)^\s*(?:r\s*\d+|q\s*\d+|quest(?:ao|\u00e3o)\s*\d+)\s*[\-\u2013\u2014]"
)
_SOLUTION_BODY_PAT = re.compile(
    r"(?i)\b(?:max\s+z|min\s+z|sujeito\s+a|resolu[cç][aã]o|gabarito|solu[cç][aã]o\s*[=:])\b"
)
_HEADER_PAT = re.compile(
    r"(?im)^\s*(?:centro federal.*|campus .*|pesquisa operacional.*|lista\s*\d+.*|prof\.:.*)\s*$"
)


# ---------------------------------------------------------------------------
# Extração e limpeza de texto
# ---------------------------------------------------------------------------
def extract_text(pdf_bytes: bytes) -> str:
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    parts = [page.get_text("text") for page in doc]
    doc.close()
    text = "\n".join(parts)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def detect_style(text: str) -> dict:
    sol_hits = len(_SOLUTION_LIST_PAT.findall(text))
    num_hits = len(re.findall(NUMBERED_BLOCK_START_REGEX, text))
    if sol_hits >= num_hits:
        return {
            "regex": DEFAULT_BLOCK_START_REGEX,
            "strip_solutions": bool(_SOLUTION_BODY_PAT.search(text)),
            "label": "lista-resolucoes",
        }
    return {
        "regex": NUMBERED_BLOCK_START_REGEX,
        "strip_solutions": False,
        "label": "lista-numerada",
    }


def split_blocks(text: str, regex: str) -> List[str]:
    pat = re.compile(regex)
    matches = list(pat.finditer(text))
    if not matches:
        return [text.strip()] if text.strip() else []
    blocks = []
    for i, m in enumerate(matches):
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        b = text[m.start():end].strip()
        if b:
            blocks.append(b)
    return blocks


def _sanitize(text: str) -> str:
    lines = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or _HEADER_PAT.match(line) or re.fullmatch(r"\d+", line):
            continue
        lines.append(line)
    return re.sub(r"\s{2,}", " ", " ".join(lines)).strip()


def _strip_solution(block: str) -> str:
    cleaned = _sanitize(block)
    if not cleaned:
        return ""
    hm = re.match(
        r"(?is)^\s*((?:r\s*\d+|q\s*\d+|quest(?:ao|\u00e3o)\s*\d+|exerc(?:icio|\u00edcio)\s*\d+)"
        r"\s*[\-\u2013\u2014:]?)\s*(.*)$",
        cleaned,
    )
    heading, body = (hm.group(1).strip(), hm.group(2).strip()) if hm else ("", cleaned)
    mm = _SOLUTION_BODY_PAT.search(body)
    if mm:
        body = body[:mm.start()].strip()
    qp = body.find("?")
    if qp != -1:
        body = body[:qp + 1].strip()
    body = re.sub(r"\s{2,}", " ", body).strip("-:; ")
    return f"{heading} {body}".strip() if heading else body


def clean_blocks(blocks: List[str], strip_solutions: bool) -> List[str]:
    out = []
    for b in blocks:
        c = _strip_solution(b) if strip_solutions else _sanitize(b)
        if c:
            out.append(c)
    return out


# ---------------------------------------------------------------------------
# Pré-visualização (retorna os primeiros N blocos como JSON)
# ---------------------------------------------------------------------------
def preview_blocks_json(pdf_bytes: bytes, regex: str, strip_solutions: bool, max_blocks: int = 5) -> str:
    text = extract_text(pdf_bytes)
    blocks = split_blocks(text, regex)
    cleaned = clean_blocks(blocks, strip_solutions)
    return json.dumps({
        "total": len(cleaned),
        "preview": cleaned[:max_blocks],
    }, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Geração do PDF de saída
# ---------------------------------------------------------------------------
def _wrap_lines(text: str, font: str, size: float, max_w: float) -> List[str]:
    out = []
    for para in text.splitlines():
        para = para.strip()
        if not para:
            continue
        words = para.split()
        cur = words[0]
        for w in words[1:]:
            cand = f"{cur} {w}"
            if fitz.get_text_length(cand, fontname=font, fontsize=size) <= max_w:
                cur = cand
            else:
                out.append(cur)
                cur = w
        out.append(cur)
    return out


def _draw_box(page: fitz.Page, y_top: float, height: float,
              left: float, right: float, style: str, cell: float) -> None:
    bottom = y_top + height
    page.draw_rect(fitz.Rect(left, y_top, right, bottom),
                   color=(0.6, 0.6, 0.6), width=0.7)
    if style == "pautada":
        y = y_top + cell
        while y < bottom:
            page.draw_line(fitz.Point(left, y), fitz.Point(right, y),
                           color=(0.75, 0.75, 0.75), width=0.5)
            y += cell
    elif style == "quadriculada":
        y = y_top + cell
        while y < bottom:
            page.draw_line(fitz.Point(left, y), fitz.Point(right, y),
                           color=(0.78, 0.78, 0.78), width=0.45)
            y += cell
        x = left + cell
        while x < right:
            page.draw_line(fitz.Point(x, y_top), fitz.Point(x, bottom),
                           color=(0.82, 0.82, 0.82), width=0.35)
            x += cell
    # "vazia" → só o retângulo externo


def generate_pdf(
    pdf_bytes: bytes,
    regex: str,
    strip_solutions: bool,
    box_style: str,          # "quadriculada" | "pautada" | "vazia"
    box_lines: int,          # número base de linhas (será multiplicado x2 internamente)
    box_size_mode: str,      # "fixo" | "variavel"  (variavel = proporcional ao enunciado)
    keep_on_same_page: bool,
    title: str,
) -> bytes:
    text = extract_text(pdf_bytes)
    blocks = split_blocks(text, regex)
    cleaned = clean_blocks(blocks, strip_solutions)

    doc = fitz.open()
    PW, PH, M = 595, 842, 48
    FS, LS = 11, 16          # font size, line height
    CELL = 16
    LABEL_H = 16
    GAP = 12

    effective_lines = box_lines * 2
    fixed_grid_h = effective_lines * CELL
    usable = PH - 2 * M

    page = doc.new_page(width=PW, height=PH)
    y = M

    page.insert_text(fitz.Point(M, y + 15), title, fontname="helv", fontsize=15)
    y += 28

    tw = PW - 2 * M

    def np():
        return doc.new_page(width=PW, height=PH)

    for idx, block in enumerate(cleaned, 1):
        lines = _wrap_lines(f"{idx}. {block}", "helv", FS, tw)
        text_h = len(lines) * LS

        grid_h = fixed_grid_h
        if box_size_mode == "variavel":
            # scale answer box relative to statement length (min 3x, max 8x text height)
            scale = max(3, min(8, len(lines)))
            grid_h = scale * CELL * 2

        block_h = text_h + GAP + LABEL_H + grid_h + GAP

        if keep_on_same_page and block_h <= usable:
            if y + block_h > PH - M:
                page = np()
                y = M
            for ln in lines:
                page.insert_text(fitz.Point(M, y + FS), ln, fontname="helv", fontsize=FS)
                y += LS
        else:
            rem = list(lines)
            while rem:
                av = PH - M - y
                ml = int(av // LS)
                if ml <= 0:
                    page = np()
                    y = M
                    continue
                for ln in rem[:ml]:
                    page.insert_text(fitz.Point(M, y + FS), ln, fontname="helv", fontsize=FS)
                    y += LS
                rem = rem[ml:]
                if rem:
                    page = np()
                    y = M

        if y + GAP + LABEL_H + grid_h > PH - M:
            page = np()
            y = M
        else:
            y += GAP

        page.insert_text(fitz.Point(M, y + 10), "Espaço para resolução:",
                         fontname="helv", fontsize=10)
        y += LABEL_H

        _draw_box(page, y, grid_h, M, PW - M, box_style, CELL)
        y += grid_h + GAP

    buf = doc.tobytes()
    doc.close()
    return buf


# ---------------------------------------------------------------------------
# Ponto de entrada chamado pelo JS via Pyodide
# ---------------------------------------------------------------------------
def process(params_json: str, pdf_bytes: bytes) -> bytes:
    p = json.loads(params_json)
    return generate_pdf(
        pdf_bytes=pdf_bytes,
        regex=p.get("regex", DEFAULT_BLOCK_START_REGEX),
        strip_solutions=p.get("strip_solutions", True),
        box_style=p.get("box_style", "quadriculada"),
        box_lines=int(p.get("box_lines", 8)),
        box_size_mode=p.get("box_size_mode", "fixo"),
        keep_on_same_page=bool(p.get("keep_on_same_page", True)),
        title=p.get("title", "Lista com espaço para resolução"),
    )
