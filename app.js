'use strict';

/* =============================================================
   SETUP
   ============================================================= */
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// Regex patterns (JS-style, flags applied when constructing RegExp)
const PATTERNS = {
  numbered: String.raw`^[ \t]*(?:[1-9]\d{0,2})\.[ \t]+\S`,
  rstyle:   String.raw`^[ \t]*(?:quest(?:ao|ão)\s*\d+|q\s*\d+|r\s*\d+|exerc(?:icio|ício)\s*\d+)\b[^\n]*`,
};

const SOLUTION_RE      = /\b(?:max\s+z|min\s+z|sujeito\s+a|resolu[cç][aã]o|gabarito|solu[cç][aã]o\s*[=:])\b/i;
const SOLUTION_LIST_RE = /^[ \t]*(?:r\s*\d+|q\s*\d+|quest(?:ao|ão)\s*\d+)\s*[-–—]/gim;
const HEADER_RE        = /^[ \t]*(?:centro federal.*|campus .*|pesquisa operacional.*|lista\s*\d+.*|prof\.:.*)\s*$/im;

/* =============================================================
   STATE
   ============================================================= */
const state = {
  file:        null,
  rawText:     '',
  blocks:      [],   // cleaned, ready for PDF
  pageCount:   0,    // pages read from source PDF
  pageImages:  [],   // extracted real images from PDF
  pageBreaks:  [],   // char positions where each page breaks
};

/* =============================================================
   PDF TEXT EXTRACTION  (PDF.js)
   ============================================================= */
async function extractTextFromPDF(file) {
  const ab   = await file.arrayBuffer();
  // Use Uint8Array — more reliable with PDF.js than a raw ArrayBuffer
  const data = new Uint8Array(ab);
  const pdf  = await pdfjsLib.getDocument({ data, disableRange: true, disableStream: true }).promise;
  const pages = [];

  console.log(`[normalizar-lista] PDF carregado: ${pdf.numPages} página(s) — ${file.name}`);

  for (let p = 1; p <= pdf.numPages; p++) {
    const page    = await pdf.getPage(p);
    const content = await page.getTextContent({ includeMarkedContent: false });

    // Group items by rounded Y coordinate → reconstruct lines
    const bucket = new Map();
    for (const item of content.items) {
      if (!item.str) continue;
      const y = Math.round(item.transform[5] / 2) * 2;
      if (!bucket.has(y)) bucket.set(y, []);
      bucket.get(y).push({ x: item.transform[4], str: item.str });
    }

    const sortedYs = [...bucket.keys()].sort((a, b) => b - a); // top → bottom
    const lines    = sortedYs.map(y =>
      bucket.get(y).sort((a, b) => a.x - b.x).map(i => i.str).join('')
    );
    const pageText = lines.join('\n');
    console.log(`[normalizar-lista]  página ${p}: ${pageText.length} chars extraídos`);
    pages.push(pageText);
  }

  let text = pages.join('\n')
    .replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  
  // Track where each page breaks in the concatenated text
  const pageBreaks = [];
  let charPos = 0;
  for (let i = 0; i < pages.length; i++) {
    charPos += pages[i].length + 1; // +1 for the \n
    pageBreaks.push(charPos);
  }
  state.pageBreaks = pageBreaks;
  
  console.log(`[normalizar-lista] Total extraído: ${text.length} chars`);
  state.pageCount = pdf.numPages;
  
  // Extract real images from PDF using Python API
  try {
    const formData = new FormData();
    formData.append('pdf', file);
    const response = await fetch('http://127.0.0.1:5000/api/extract-images', {
      method: 'POST',
      body: formData,
    });
    if (response.ok) {
      const result = await response.json();
      if (result.success && result.images) {
        // Convert images object to array format
        const imagesArray = [];
        for (const [pageNumStr, pageImages] of Object.entries(result.images)) {
          const pageNum = parseInt(pageNumStr);
          for (const img of pageImages) {
            imagesArray.push({
              pageNum: pageNum,
              data: img.data,
              x: img.x,
              y: img.y,
              width: img.width,
              height: img.height,
            });
          }
        }
        state.pageImages = imagesArray;
        console.log(`[normalizar-lista] ${imagesArray.length} imagem(ns) real(is) extraída(s)`);
      }
    } else {
      console.log('[normalizar-lista] Aviso: não foi possível extrair imagens reais');
      state.pageImages = [];
    }
  } catch (e) {
    console.log(`[normalizar-lista] Aviso ao extrair imagens: ${e.message}`);
    state.pageImages = [];
  }
  
  return text;
}

/* =============================================================
   TEXT PROCESSING  (ported from normalizar_lista.py)
   ============================================================= */
function detectBlockStyle(text) {
  const solHits = (text.match(SOLUTION_LIST_RE) || []).length;
  const numHits = (text.match(new RegExp(PATTERNS.numbered, 'gm')) || []).length;
  if (solHits >= numHits) {
    return { patternKey: 'rstyle', stripSolutions: SOLUTION_RE.test(text) };
  }
  return { patternKey: 'numbered', stripSolutions: false };
}

/**
 * Build a JS RegExp from a pattern string.
 * Accepts Python inline-flag syntax like (?im)... or plain JS regex strings.
 */
function buildRegex(str) {
  // Strip Python-style inline flags prefix: (?im), (?m), etc.
  const m = str.match(/^\(\?([gimsuy]+)\)([\s\S]*)$/);
  let source = m ? m[2] : str;
  // Always multiline + global; add case-insensitive (matches Python's (?im) default)
  let flags  = 'gmi';
  // If pattern explicitly opted out of 'i' somehow, still keep it unless caller strips
  if (m && !m[1].includes('i')) {
    // inline flags present but no 'i' — respect that for custom patterns
    flags = 'gm';
  }
  return new RegExp(source, flags);
}

/**
 * Convert simplified manual pattern to regex.
 * Examples:
 *   "1) O diagrama..." -> "(?m)^\\s*(?:[1-9]\\d{0,2})\\)\\s*O\\s+diagrama"
 *   "1) Quando..." -> "(?m)^\\s*(?:[1-9]\\d{0,2})\\)\\s*Quando"
 */
function convertSimplePatternToRegex(simplePattern) {
  let pattern = simplePattern.trim();
  
  // Replace "1)" with number regex placeholder
  pattern = pattern.replace(/^\s*1\s*\)/, 'NUMBER)');
  
  // Remove "..." if present
  if (pattern.includes('...')) {
    pattern = pattern.replace(/\.\.\./, '');
  }
  
  // Escape special regex characters except our NUMBER placeholder
  let escaped = pattern
    .replace(/\\/g, '\\\\')
    .replace(/\./g, '\\.')
    .replace(/\*/g, '\\*')
    .replace(/\+/g, '\\+')
    .replace(/\?/g, '\\?')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\|/g, '\\|')
    .replace(/\^/g, '\\^')
    .replace(/\$/g, '\\$');
  
  // Replace NUMBER placeholder with actual number regex
  escaped = escaped.replace('NUMBER\\)', '(?:[1-9]\\d{0,2})\\)');
  
  // Collapse multiple spaces into \s+
  escaped = escaped.replace(/\\ +/g, '\\s+');
  
  // Build final regex
  const finalRegex = '(?m)^\\s*' + escaped;
  
  return finalRegex;
}

function splitIntoBlocks(text, regexStr) {
  let re;
  try { re = buildRegex(regexStr); } catch { return []; }

  const matches = [...text.matchAll(re)];
  if (!matches.length) return [text.trim()].filter(Boolean);

  return matches.map((match, i) => {
    const start = match.index;
    const end   = i + 1 < matches.length ? matches[i + 1].index : text.length;
    return text.slice(start, end).trim();
  }).filter(Boolean);
}

function splitIntoBlocksWithPageInfo(text, regexStr) {
  let re;
  try { re = buildRegex(regexStr); } catch { return []; }

  const matches = [...text.matchAll(re)];
  if (!matches.length) return [{ text: text.trim(), pageNum: 0 }].filter(b => b.text);

  return matches.map((match, i) => {
    const start = match.index;
    const end   = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const blockText = text.slice(start, end).trim();
    
    // Determine which page this block belongs to
    let pageNum = 0;
    for (let p = 0; p < state.pageBreaks.length; p++) {
      if (start < state.pageBreaks[p]) {
        pageNum = p;
        break;
      }
    }
    
    return { text: blockText, pageNum };
  }).filter(b => b.text);
}

function sanitize(text) {
  return text
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !HEADER_RE.test(l) && !/^\d+$/.test(l))
    .join(' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function removeResolution(block) {
  const c = sanitize(block);
  if (!c) return '';

  const headMatch = c.match(
    /^\s*((?:r\s*\d+|q\s*\d+|quest(?:ao|ão)\s*\d+|exerc(?:icio|ício)\s*\d+)\s*[-–—:]?)\s*([\s\S]*)$/i
  );
  let heading = '', body = c;
  if (headMatch) { heading = headMatch[1].trim(); body = headMatch[2].trim(); }

  const solIdx = SOLUTION_RE.exec(body)?.index ?? -1;
  if (solIdx !== -1) body = body.slice(0, solIdx).trim();

  const qPos = body.indexOf('?');
  if (qPos !== -1) body = body.slice(0, qPos + 1).trim();

  body = body.replace(/\s{2,}/g, ' ').replace(/^[-:; ]+|[-:; ]+$/g, '').trim();
  return heading ? `${heading} ${body}`.trim() : body;
}

function processBlocks(blocks, strip) {
  return blocks.map(b => strip ? removeResolution(b) : sanitize(b)).filter(Boolean);
}

/* =============================================================
   OPTIONS READER
   ============================================================= */
function getOptions() {
  const patternSel  = document.querySelector('input[name="pattern"]:checked').value;
  const boxStyle    = document.querySelector('input[name="box-style"]:checked').value;
  const boxSizeMode = document.querySelector('input[name="box-size"]:checked').value;
  const customRegex = document.getElementById('custom-regex').value.trim();
  const simplePattern = document.getElementById('simple-pattern').value.trim();
  const answerLines = +document.getElementById('answer-lines').value;
  const cellSize    = +document.getElementById('cell-size').value;
  const strip       = document.getElementById('strip-solutions').checked;
  const samePage    = document.getElementById('same-page').checked;
  const showTitle   = document.getElementById('show-title').checked;
  const title       = document.getElementById('pdf-title').value.trim() || 'Lista de Exercícios';

  let regexStr;
  if (patternSel === 'auto') {
    const d = detectBlockStyle(state.rawText);
    regexStr = PATTERNS[d.patternKey];
  } else if (patternSel === 'simple') {
    regexStr = convertSimplePatternToRegex(simplePattern);
  } else if (patternSel === 'custom') {
    regexStr = customRegex;
  } else {
    regexStr = PATTERNS[patternSel];
  }

  return { patternSel, boxStyle, boxSizeMode, customRegex, simplePattern, answerLines,
           cellSize, strip, samePage, showTitle, title, regexStr };
}

/* =============================================================
   PREVIEW RENDERER
   ============================================================= */
function renderPreview() {
  if (!state.rawText) return;
  const opts = getOptions();

  // Validate custom regex live
  if (opts.patternSel === 'custom') {
    const msg = document.getElementById('regex-msg');
    if (!opts.customRegex) { msg.textContent = ''; return; }
    try {
      buildRegex(opts.customRegex);
      msg.textContent = '✓ Regex válida';
      msg.className   = 'regex-msg ok';
    } catch (e) {
      msg.textContent = `✗ ${e.message}`;
      msg.className   = 'regex-msg err';
      clearPreview(0);
      return;
    }
  }

  // Validate simple pattern live
  if (opts.patternSel === 'simple') {
    const msg = document.getElementById('simple-msg');
    if (!opts.simplePattern) { msg.textContent = ''; return; }
    try {
      const regex = convertSimplePatternToRegex(opts.simplePattern);
      buildRegex(regex);
      msg.textContent = '✓ Padrão válido';
      msg.className   = 'simple-msg ok';
    } catch (e) {
      msg.textContent = `✗ ${e.message}`;
      msg.className   = 'simple-msg err';
      clearPreview(0);
      return;
    }
  }

  const rawBlocks = splitIntoBlocks(state.rawText, opts.regexStr);
  const blocks    = processBlocks(rawBlocks, opts.strip);
  state.blocks    = blocks;

  const pgInfo = state.pageCount ? ` · ${state.pageCount} pág.` : '';
  document.getElementById('preview-stats').textContent =
    `${blocks.length} exercício${blocks.length !== 1 ? 's' : ''}${pgInfo}`;
  document.getElementById('generate-btn').disabled = blocks.length === 0;

  const container = document.getElementById('preview-blocks');
  const empty     = document.getElementById('preview-empty');
  container.innerHTML = '';

  if (!blocks.length) {
    empty.textContent = 'Nenhum exercício detectado com este padrão.';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  
  // Generate PDF and render preview
  renderPdfPreview(blocks, opts);
}

async function renderPdfPreview(blocks, opts) {
  const container = document.getElementById('preview-blocks');
  const empty = document.getElementById('preview-empty');
  
  try {
    empty.textContent = 'Gerando pré-visualização do PDF...';
    empty.classList.remove('hidden');
    
    // Generate actual PDF
    const pdfBytes = await generatePDF(blocks, opts);
    
    // Render first 2 pages as preview
    const blob = new Blob([pdfBytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const pdf = await pdfjsLib.getDocument(url).promise;
    
    container.innerHTML = '';
    empty.classList.add('hidden');
    
    const pagesToShow = Math.min(2, pdf.numPages);
    for (let pageNum = 1; pageNum <= pagesToShow; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const scale = 1;
      const viewport = page.getViewport({ scale });
      
      // Create canvas for page
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.style.maxWidth = '100%';
      canvas.style.marginBottom = '16px';
      canvas.style.border = '1px solid #e2e8f0';
      canvas.style.borderRadius = '8px';
      
      const ctx = canvas.getContext('2d');
      await page.render({
        canvasContext: ctx,
        viewport: viewport,
      }).promise;
      
      const pageLabel = document.createElement('div');
      pageLabel.style.fontSize = '0.85rem';
      pageLabel.style.color = '#64748b';
      pageLabel.style.marginBottom = '8px';
      pageLabel.textContent = `Página ${pageNum}`;
      
      container.appendChild(pageLabel);
      container.appendChild(canvas);
    }
    
    if (pdf.numPages > 2) {
      const more = document.createElement('div');
      more.className = 'preview-more';
      more.textContent = `… e mais ${pdf.numPages - 2} página(s) não exibida(s)`;
      container.appendChild(more);
    }
    
    URL.revokeObjectURL(url);
  } catch (err) {
    console.error('Erro ao gerar pré-visualização:', err);
    empty.textContent = `Erro: ${err.message}`;
    empty.classList.remove('hidden');
  }
}

function clearPreview(count) {
  state.blocks = [];
  document.getElementById('preview-stats').textContent = count ? `${count} exercício(s)` : '';
  document.getElementById('preview-blocks').innerHTML = '';
  document.getElementById('generate-btn').disabled = true;
}

function computeBoxHeight(blockText, opts) {
  const cell = opts.cellSize;
  if (opts.boxSizeMode === 'fixed') {
    return opts.answerLines * 2 * cell;
  }
  const words = blockText.split(/\s+/).length;
  const lines = Math.max(8, Math.min(30, Math.round(words / 4))) * 2;
  return lines * cell;
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

/* =============================================================
   PDF GENERATION  (pdf-lib)
   ============================================================= */

/**
 * Sanitize a string so it only contains characters encodable by WinAnsiEncoding
 * (roughly U+0020–U+00FF plus a few Windows-1252 extras).
 * Replaces common Unicode chars with near-equivalents; strips the rest.
 */
function toWinAnsi(str) {
  return str
    // Smart quotes → plain quotes
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    // Dashes
    .replace(/[\u2013\u2014\u2015]/g, '-')
    // Ellipsis
    .replace(/\u2026/g, '...')
    // Bullet, middle dot
    .replace(/[\u2022\u00B7\u2219]/g, '*')
    // Non-breaking space → space
    .replace(/\u00A0/g, ' ')
    // Minus sign, en-minus
    .replace(/[\u2212\u2010\u2011]/g, '-')
    // Multiplication × and similar
    .replace(/\u00D7/g, 'x')
    .replace(/\u00F7/g, '/')
    // Arrows
    .replace(/[\u2190-\u21FF]/g, '->')
    // Mathematical operators that have ASCII equivalents
    .replace(/\u2264/g, '<=').replace(/\u2265/g, '>=')
    .replace(/\u2260/g, '!=').replace(/\u2248/g, '~=')
    .replace(/\u221E/g, 'inf')
    // Strip anything outside WinAnsi range (keep 0x09, 0x0A, 0x20-0xFF, exclude 0x81,0x8D,0x8F,0x90,0x9D)
    .replace(/[^\x09\x0A\x20-\xFF]/g, '');
}

/**
 * Convert canvas to PNG bytes (Uint8Array)
 * Extracts PNG data from data URL
 */
function canvasToPngBytes(canvas) {
  const dataUrl = canvas.toDataURL('image/png');
  const base64 = dataUrl.split(',')[1];
  const binaryStr = atob(base64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  return bytes;
}

function wrapText(font, text, fontSize, maxWidth) {
  const lines = [];
  for (const para of text.split('\n')) {
    const words = para.trim().split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    let cur = '';
    for (const w of words) {
      const cand = cur ? `${cur} ${w}` : w;
      if (font.widthOfTextAtSize(cand, fontSize) <= maxWidth) {
        cur = cand;
      } else {
        if (cur) lines.push(cur);
        cur = w;
      }
    }
    if (cur) lines.push(cur);
  }
  return lines;
}

async function generatePDF(blocks, opts) {
  const { PDFDocument, rgb, StandardFonts } = PDFLib;
  const doc   = await PDFDocument.create();
  const font  = await doc.embedFont(StandardFonts.Helvetica);
  const fontB = await doc.embedFont(StandardFonts.HelveticaBold);

  // Page layout constants (A4 portrait, points)
  const PW = 595, PH = 842, MARGIN = 48, UW = PW - 2 * MARGIN;
  const TITLE_SZ = 15, TEXT_SZ = 11, LBL_SZ = 10;
  const TEXT_LH = 16, LBL_H = 16, GAP = 14;
  const CELL = opts.cellSize;

  // Embed real images if available (from extracted images, not canvas renders)
  const embeddedImages = [];
  if (state.pageImages && state.pageImages.length > 0) {
    for (const imgData of state.pageImages) {
      try {
        // Images come as data:image/png;base64,... format
        const base64Data = imgData.data.split(',')[1];
        if (!base64Data) continue;
        
        // Convert base64 to Uint8Array
        const binaryStr = atob(base64Data);
        const imgBytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) {
          imgBytes[i] = binaryStr.charCodeAt(i);
        }
        
        const embedded = await doc.embedPng(imgBytes);
        embeddedImages.push({
          image: embedded,
          x: imgData.x,
          y: imgData.y,
          width: imgData.width,
          height: imgData.height,
          pageNum: imgData.pageNum,
        });
        console.log(`[normalizar-lista] Imagem de página ${imgData.pageNum + 1} embedded com sucesso`);
      } catch (e) {
        console.log(`Erro ao embedar imagem de página ${imgData.pageNum + 1}: ${e.message}`);
      }
    }
  }

  // y tracking (measured from TOP of page; convert to pdf-lib with: PH - y)
  let page = doc.addPage([PW, PH]);
  let y    = MARGIN;

  function newPage() {
    page = doc.addPage([PW, PH]);
    y    = MARGIN;
  }

  // Draw text at current y (advances y)
  function putText(text, size, fnt) {
    page.drawText(toWinAnsi(text), {
      x: MARGIN,
      y: PH - y - size,   // pdf-lib baseline = top - size
      size, font: fnt || font,
      color: rgb(0.1, 0.1, 0.1),
      maxWidth: UW,
    });
    y += TEXT_LH;
  }

  // Draw grid/lined/blank answer box at current y (does NOT advance y)
  function drawBox(boxH) {
    const pdfYBottom = PH - y - boxH;

    // White fill + border
    page.drawRectangle({
      x: MARGIN, y: pdfYBottom, width: UW, height: boxH,
      color: rgb(1, 1, 1),
      borderColor: rgb(0.65, 0.65, 0.65),
      borderWidth: 0.7,
    });

    if (opts.boxStyle === 'grid' || opts.boxStyle === 'lined') {
      for (let ly = CELL; ly < boxH; ly += CELL) {
        page.drawLine({
          start: { x: MARGIN,      y: PH - y - ly },
          end:   { x: MARGIN + UW, y: PH - y - ly },
          thickness: 0.45,
          color: rgb(0.78, 0.78, 0.78),
        });
      }
    }

    if (opts.boxStyle === 'grid') {
      for (let lx = CELL; lx < UW; lx += CELL) {
        page.drawLine({
          start: { x: MARGIN + lx, y: PH - y },
          end:   { x: MARGIN + lx, y: PH - y - boxH },
          thickness: 0.3,
          color: rgb(0.83, 0.83, 0.83),
        });
      }
    }
  }

  // ── Title ──────────────────────────────────────────────
  if (opts.showTitle) {
    page.drawText(toWinAnsi(opts.title), {
      x: MARGIN, y: PH - y - TITLE_SZ,
      size: TITLE_SZ, font: fontB,
      color: rgb(0.08, 0.08, 0.08),
      maxWidth: UW,
    });
    y += TITLE_SZ + 14;
  }

  // ── Add original page images if available ───────────────
  if (embeddedImages.length > 0) {
    // Draw all extracted images from the original PDF after all text/questions
    for (const imgData of embeddedImages) {
      try {
        // Scale image to fit in usable width
        const maxImgWidth = UW * 0.85;
        const scale = Math.min(1, maxImgWidth / imgData.width);
        const imgWidth = imgData.width * scale;
        const imgHeight = imgData.height * scale;
        
        // Check if image fits on current page, otherwise create new page
        if (y + imgHeight + GAP > PH - MARGIN) {
          newPage();
        }
        
        // Draw image from original PDF position
        page.drawImage(imgData.image, {
          x: MARGIN,
          y: PH - y - imgHeight,
          width: imgWidth,
          height: imgHeight,
        });
        
        console.log(`[normalizar-lista] Imagem de página ${imgData.pageNum + 1} desenhada no PDF`);
        y += imgHeight + GAP;
      } catch (e) {
        console.log(`Erro ao desenhar imagem: ${e.message}`);
      }
    }
  }

  // ── Blocks ─────────────────────────────────────────────
  for (let i = 0; i < blocks.length; i++) {
    const raw   = toWinAnsi(`${i + 1}. ${blocks[i]}`);
    const lines = wrapText(font, raw, TEXT_SZ, UW);
    const boxH  = computeBoxHeight(blocks[i], opts);
    const textH = lines.length * TEXT_LH;
    const totalH = textH + GAP + LBL_H + boxH;

    // Draw text
    if (opts.samePage && totalH <= PH - 2 * MARGIN) {
      // Keep everything on one page: check space first
      if (y + totalH > PH - MARGIN) newPage();
      for (const line of lines) putText(line, TEXT_SZ);
    } else {
      // Text may span pages
      let rem = [...lines];
      while (rem.length) {
        const avail = PH - MARGIN - y;
        const maxL  = Math.max(0, Math.floor(avail / TEXT_LH));
        if (maxL === 0) { newPage(); continue; }
        for (const line of rem.splice(0, maxL)) putText(line, TEXT_SZ);
        if (rem.length) newPage();
      }
    }

    // Ensure label + box fit on current page
    if (y + GAP + LBL_H + boxH > PH - MARGIN) newPage();
    else y += GAP;

    // Label
    page.drawText('Espaço para resolução:', {
      x: MARGIN, y: PH - y - LBL_SZ,
      size: LBL_SZ, font,
      color: rgb(0.35, 0.35, 0.35),
    });
    y += LBL_H;

    // Box
    drawBox(boxH);
    y += boxH + GAP;
  }

  return await doc.save();
}

/* =============================================================
   FILE HANDLING
   ============================================================= */
function setStatus(msg, isSpinner) {
  const el = document.getElementById('gen-status');
  el.innerHTML = isSpinner
    ? `<span class="spinner"></span>${msg}`
    : msg;
}

async function handleFile(file) {
  if (!file || file.type !== 'application/pdf') return;
  state.file = file;
  setStatus('Lendo PDF…', true);
  document.getElementById('download-link').classList.add('hidden');

  try {
    state.rawText = await extractTextFromPDF(file);

    // Auto-suggest strip-solutions checkbox based on content
    const d = detectBlockStyle(state.rawText);
    document.getElementById('strip-solutions').checked = d.stripSolutions;

    // Show filename + panels
    const fn = document.getElementById('file-name');
    fn.textContent = `📄 ${file.name}`;
    fn.classList.remove('hidden');
    document.getElementById('app-panel').classList.remove('hidden');
    document.getElementById('preview-empty').textContent = 'Carregando exercícios…';

    renderPreview();
    setStatus('');
  } catch (err) {
    setStatus(`Erro ao ler PDF: ${err.message}`);
    console.error(err);
  }
}

/* =============================================================
   EVENT WIRING
   ============================================================= */

// ── Drop zone ──────────────────────────────────────────────
const dropZone  = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');

dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', ()  => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  handleFile(e.dataTransfer.files[0]);
});
dropZone.addEventListener('click',   () => fileInput.click());
dropZone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });
fileInput.addEventListener('change', () => handleFile(fileInput.files[0]));

// ── Config changes → re-render preview ─────────────────────
const debouncedPreview = debounce(renderPreview, 350);

document.querySelectorAll('input[name="pattern"]').forEach(r =>
  r.addEventListener('change', () => {
    const isCustom = r.value === 'custom' && r.checked;
    const isSimple = r.value === 'simple' && r.checked;
    document.getElementById('custom-regex-wrap').classList.toggle('hidden', !isCustom);
    document.getElementById('simple-pattern-wrap').classList.toggle('hidden', !isSimple);
    renderPreview();
  })
);

document.querySelectorAll('input[name="box-style"], input[name="box-size"]')
  .forEach(r => r.addEventListener('change', renderPreview));

document.getElementById('custom-regex')
  .addEventListener('input', debouncedPreview);

document.getElementById('simple-pattern')
  .addEventListener('input', debouncedPreview);

['strip-solutions', 'same-page', 'show-title'].forEach(id =>
  document.getElementById(id).addEventListener('change', () => {
    if (id === 'show-title')
      document.getElementById('title-wrap').style.display =
        document.getElementById('show-title').checked ? '' : 'none';
    renderPreview();
  })
);

// Sliders
function bindSlider(sliderId, labelId) {
  const s = document.getElementById(sliderId);
  const v = document.getElementById(labelId);
  s.addEventListener('input', () => { v.textContent = s.value; debouncedPreview(); });
}
bindSlider('answer-lines', 'lines-val');
bindSlider('cell-size',    'cell-val');

// ── Generate PDF ────────────────────────────────────────────
document.getElementById('generate-btn').addEventListener('click', async () => {
  const opts = getOptions();
  const btn  = document.getElementById('generate-btn');
  const link = document.getElementById('download-link');

  btn.disabled = true;
  link.classList.add('hidden');
  setStatus('Gerando PDF…', true);

  try {
    const pdfBytes = await generatePDF(state.blocks, opts);
    const blob = new Blob([pdfBytes], { type: 'application/pdf' });
    const url  = URL.createObjectURL(blob);
    const stem = (state.file?.name ?? 'lista').replace(/\.pdf$/i, '');
    link.href     = url;
    link.download = `${stem}_resolucao.pdf`;
    link.classList.remove('hidden');
    setStatus('');
  } catch (err) {
    setStatus(`Erro: ${err.message}`);
    console.error(err);
  } finally {
    btn.disabled = state.blocks.length === 0;
  }
});

/* =============================================================
   UTILS
   ============================================================= */
function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
