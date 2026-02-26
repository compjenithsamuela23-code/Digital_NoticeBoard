import React, { useEffect, useMemo, useState } from 'react';
import { assetUrl } from '../config/api';
import * as mammoth from 'mammoth/mammoth.browser';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

if (GlobalWorkerOptions.workerSrc !== pdfWorker) {
  GlobalWorkerOptions.workerSrc = pdfWorker;
}

const TEXT_PREVIEW_EXTENSIONS = new Set([
  'txt',
  'csv',
  'md',
  'markdown',
  'html',
  'htm',
  'xhtml',
  'css',
  'js',
  'jsx',
  'ts',
  'tsx',
  'py',
  'java',
  'c',
  'cpp',
  'h',
  'hpp',
  'sh',
  'bat',
  'ps1',
  'json',
  'xml',
  'log',
  'rtf',
  'yaml',
  'yml',
  'ini',
  'conf',
  'sql',
  'toml',
  'properties',
  'tex',
  'srt',
  'vtt'
]);
const WORD_PREVIEW_EXTENSIONS = new Set(['docx']);
const SHEET_PREVIEW_EXTENSIONS = new Set(['xls', 'xlsx']);
const PRESENTATION_PREVIEW_EXTENSIONS = new Set(['pptx', 'ppsx']);
const ODF_PREVIEW_EXTENSIONS = new Set(['odt', 'ods', 'odp']);
const ZIP_PREVIEW_EXTENSIONS = new Set(['zip']);
const LEGACY_OFFICE_PREVIEW_EXTENSIONS = new Set(['doc', 'ppt', 'pps']);
const OFFICE_ONLINE_PREVIEW_EXTENSIONS = new Set([
  'doc',
  'docx',
  'ppt',
  'pptx',
  'pps',
  'ppsx',
  'xls',
  'xlsx'
]);
const ARCHIVE_BINARY_EXTENSIONS = new Set(['rar', '7z']);
const PDF_MIME_TYPES = new Set(['application/pdf']);
const WORD_MIME_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
]);
const SHEET_MIME_TYPES = new Set([
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
]);
const PRESENTATION_MIME_TYPES = new Set([
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.presentationml.slideshow'
]);
const ODF_MIME_TYPES = new Set([
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation'
]);
const ZIP_MIME_TYPES = new Set([
  'application/zip',
  'application/x-zip-compressed',
  'application/x-zip'
]);
const TEXT_MIME_HINTS = ['text/', 'application/json', 'application/xml', 'application/yaml', 'application/x-yaml', 'application/javascript', 'application/sql'];
const MAX_PREVIEW_CHARS = 30000;
const MAX_BINARY_PREVIEW_BYTES = 5 * 1024 * 1024;
const MAX_INLINE_PARSE_BYTES = 20 * 1024 * 1024;
const MAX_SLIDESHOW_PARSE_BYTES = 50 * 1024 * 1024;
const TEXT_SLIDE_MAX_CHARS = 2600;
const TEXT_SLIDE_MAX_LINES = 26;
const DEFAULT_SLIDESHOW_INTERVAL_MS = 6000;

function getExtension(value) {
  const file = String(value || '').split('/').pop() || '';
  const clean = file.split('?')[0].split('#')[0];
  const index = clean.lastIndexOf('.');
  if (index === -1 || index === clean.length - 1) return '';
  return clean.slice(index + 1).toLowerCase();
}

function getFileNameFromPath(value) {
  const file = String(value || '').split('/').pop() || '';
  const clean = file.split('?')[0].split('#')[0];
  return decodeURIComponent(clean || 'Attached file');
}

function normalizeMimeType(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw.includes('/')) return '';
  return raw.split(';')[0].trim();
}

function formatFileSize(bytesValue) {
  const bytes = Number.parseInt(bytesValue, 10);
  if (Number.isNaN(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = bytes / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const precision = size >= 100 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(precision)} ${units[unitIndex]}`;
}

function isLikelyTextMime(mimeType) {
  if (!mimeType) return false;
  return TEXT_MIME_HINTS.some((item) => mimeType.startsWith(item) || mimeType === item);
}

function isPublicHttpUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || ''));
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;

    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
      return false;
    }

    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
      const [a, b] = host.split('.').map((item) => Number.parseInt(item, 10));
      if (a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

function truncateText(value, max = MAX_PREVIEW_CHARS) {
  const text = String(value || '');
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[Preview truncated]`;
}

function wrapHtmlPreview(innerHtml) {
  return `<!doctype html><html><head><meta charset="utf-8"/><style>
    body{font-family:Segoe UI,Inter,sans-serif;margin:0;padding:14px;line-height:1.5;color:#111827;background:#ffffff;}
    table{border-collapse:collapse;width:100%;font-size:13px;}
    th,td{border:1px solid #d1d5db;padding:6px;vertical-align:top;word-break:break-word;}
    img{max-width:100%;height:auto;}
    h1,h2,h3,h4{margin:0 0 10px;}
    p{margin:0 0 10px;}
  </style></head><body>${innerHtml || '<p>No readable content found.</p>'}</body></html>`;
}

function extractPrintableStringsFromBinary(
  arrayBuffer,
  { minSequenceLength = 4, maxSequences = 1200 } = {}
) {
  const bytes = new Uint8Array(arrayBuffer.slice(0, MAX_BINARY_PREVIEW_BYTES));
  const lines = [];
  let buffer = '';

  const pushBuffer = () => {
    const value = buffer.trim();
    if (value.length >= minSequenceLength) {
      lines.push(value);
    }
    buffer = '';
  };

  for (let index = 0; index < bytes.length; index += 1) {
    const code = bytes[index];
    const isPrintableAscii = code >= 32 && code <= 126;
    const isWhitespace = code === 9 || code === 10 || code === 13;

    if (isPrintableAscii) {
      buffer += String.fromCharCode(code);
      continue;
    }

    if (isWhitespace) {
      if (buffer.length > 0) {
        buffer += '\n';
      }
      continue;
    }

    pushBuffer();
    if (lines.length >= maxSequences) {
      break;
    }
  }

  pushBuffer();
  if (lines.length === 0) {
    return '';
  }
  return lines.join('\n');
}

function looksLikeZipArchive(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer.slice(0, 4));
  if (bytes.length < 4) return false;
  return bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07);
}

function extractPptxOrderNumber(pathname) {
  const match = String(pathname || '').match(/slide(\d+)\.xml$/i);
  return match ? Number.parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
}

async function extractPptxSlides(arrayBuffer) {
  const zip = await JSZip.loadAsync(arrayBuffer);
  const slidePaths = Object.keys(zip.files)
    .filter((item) => /^ppt\/slides\/slide\d+\.xml$/i.test(item))
    .sort((a, b) => extractPptxOrderNumber(a) - extractPptxOrderNumber(b));

  const slides = [];
  for (const slidePath of slidePaths) {
    const xml = await zip.file(slidePath).async('string');
    const document = new DOMParser().parseFromString(xml, 'application/xml');
    const textNodes = Array.from(document.getElementsByTagName('a:t'));
    const text = textNodes
      .map((node) => String(node.textContent || '').trim())
      .filter(Boolean)
      .join(' ');
    if (text) {
      slides.push(text);
    }
  }
  return slides;
}

async function extractOdfText(arrayBuffer) {
  const zip = await JSZip.loadAsync(arrayBuffer);
  const contentFile = zip.file('content.xml');
  if (!contentFile) return '';

  const xml = await contentFile.async('string');
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  const tags = ['text:p', 'text:h', 'table:table-cell'];
  const lines = [];

  tags.forEach((tagName) => {
    const nodes = Array.from(document.getElementsByTagName(tagName));
    nodes.forEach((node) => {
      const value = String(node.textContent || '').trim();
      if (value) {
        lines.push(value);
      }
    });
  });

  if (lines.length > 0) {
    return lines.join('\n');
  }

  return String(document.documentElement?.textContent || '').replace(/\s+\n/g, '\n').trim();
}

async function extractZipEntries(arrayBuffer) {
  const zip = await JSZip.loadAsync(arrayBuffer);
  return Object.values(zip.files)
    .filter((entry) => entry && !entry.dir)
    .map((entry) => entry.name)
    .slice(0, 500);
}

function buildSheetPreviewsFromWorkbook(workbook) {
  return (workbook.SheetNames || []).slice(0, 12).map((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    const html = XLSX.utils.sheet_to_html(sheet || {});
    return { name: sheetName, srcDoc: wrapHtmlPreview(html) };
  });
}

function extractPlainTextFromHtml(rawHtml) {
  const html = String(rawHtml || '').trim();
  if (!html) return '';
  try {
    const document = new DOMParser().parseFromString(html, 'text/html');
    return String(document.body?.textContent || document.documentElement?.textContent || '')
      .replace(/\r\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  } catch {
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
}

function splitTextIntoSlides(
  value,
  { maxChars = TEXT_SLIDE_MAX_CHARS, maxLines = TEXT_SLIDE_MAX_LINES } = {}
) {
  const normalized = String(value || '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  const lines = normalized.split('\n');
  const chunks = [];
  let buffer = [];
  let charsInBuffer = 0;

  const flush = () => {
    if (buffer.length === 0) return;
    const chunk = buffer.join('\n').trim();
    if (chunk) {
      chunks.push(chunk);
    }
    buffer = [];
    charsInBuffer = 0;
  };

  lines.forEach((line) => {
    const safeLine = String(line || '');
    const nextChars = charsInBuffer + safeLine.length + 1;
    if (buffer.length > 0 && (buffer.length >= maxLines || nextChars > maxChars)) {
      flush();
    }
    buffer.push(safeLine);
    charsInBuffer += safeLine.length + 1;
  });

  flush();
  return chunks.slice(0, 300);
}

function buildTextSlideEntries(value, labelPrefix = 'Page') {
  return splitTextIntoSlides(value).map((chunk, index) => ({
    id: `${labelPrefix.toLowerCase()}-${index + 1}`,
    type: 'text',
    label: `${labelPrefix} ${index + 1}`,
    content: chunk
  }));
}

function buildPdfPageUrl(sourceUrl, pageNumber = 1) {
  const page = Math.max(1, Number.parseInt(pageNumber, 10) || 1);
  const cleanBase = String(sourceUrl || '').split('#')[0];
  return `${cleanBase}#page=${page}&toolbar=0&navpanes=0&scrollbar=0&view=FitH`;
}

function normalizeSlideshowInterval(value) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return DEFAULT_SLIDESHOW_INTERVAL_MS;
  return Math.max(1500, Math.min(parsed, 30000));
}

const DocumentAttachment = ({
  filePath,
  fileUrl,
  fileName,
  mimeType,
  fileSizeBytes,
  title = 'Document Attachment',
  className = '',
  preview = true,
  hideHeader = false,
  showActions = true,
  slideshow = false,
  slideshowAutoplay = true,
  slideshowIntervalMs = DEFAULT_SLIDESHOW_INTERVAL_MS,
  onSlideCountChange,
  onSlideIndexChange
}) => {
  const [textContent, setTextContent] = useState('');
  const [textLoading, setTextLoading] = useState(false);
  const [textError, setTextError] = useState('');
  const [htmlPreview, setHtmlPreview] = useState('');
  const [sheetPreviews, setSheetPreviews] = useState([]);
  const [slides, setSlides] = useState([]);
  const [activeSlideIndex, setActiveSlideIndex] = useState(0);
  const [isAutoplayActive, setIsAutoplayActive] = useState(Boolean(slideshowAutoplay));

  const sourceUrl = useMemo(() => {
    if (fileUrl) return fileUrl;
    if (filePath) return assetUrl(filePath);
    return '';
  }, [filePath, fileUrl]);

  const resolvedName = useMemo(() => {
    if (fileName) return fileName;
    if (filePath) return getFileNameFromPath(filePath);
    if (fileUrl) return getFileNameFromPath(fileUrl);
    return 'Attached file';
  }, [fileName, filePath, fileUrl]);

  const extension = useMemo(() => getExtension(resolvedName || filePath || fileUrl), [resolvedName, filePath, fileUrl]);
  const normalizedMimeType = useMemo(() => normalizeMimeType(mimeType), [mimeType]);
  const formattedSize = useMemo(() => formatFileSize(fileSizeBytes), [fileSizeBytes]);
  const parsedFileSizeBytes = useMemo(() => {
    const value = Number.parseInt(fileSizeBytes, 10);
    return Number.isNaN(value) || value <= 0 ? null : value;
  }, [fileSizeBytes]);
  const metaLabel = useMemo(() => {
    const primaryLabel = extension ? extension.toUpperCase() : 'FILE';
    const details = [normalizedMimeType || '', formattedSize || ''].filter(Boolean);
    return details.length > 0 ? `${primaryLabel} • ${details.join(' • ')}` : primaryLabel;
  }, [extension, formattedSize, normalizedMimeType]);
  const isSlideshowEnabled = Boolean(slideshow && preview);
  const normalizedSlideIntervalMs = useMemo(
    () => normalizeSlideshowInterval(slideshowIntervalMs),
    [slideshowIntervalMs]
  );
  const previewMode = useMemo(() => {
    if (!preview) return 'none';
    if (extension === 'pdf' || PDF_MIME_TYPES.has(normalizedMimeType)) return 'pdf';
    if (OFFICE_ONLINE_PREVIEW_EXTENSIONS.has(extension) && isPublicHttpUrl(sourceUrl)) {
      return 'office-online';
    }
    if (TEXT_PREVIEW_EXTENSIONS.has(extension) || isLikelyTextMime(normalizedMimeType)) return 'text';
    if (WORD_PREVIEW_EXTENSIONS.has(extension) || WORD_MIME_TYPES.has(normalizedMimeType)) return 'word';
    if (SHEET_PREVIEW_EXTENSIONS.has(extension) || SHEET_MIME_TYPES.has(normalizedMimeType)) return 'sheet';
    if (PRESENTATION_PREVIEW_EXTENSIONS.has(extension) || PRESENTATION_MIME_TYPES.has(normalizedMimeType)) {
      return 'presentation';
    }
    if (ODF_PREVIEW_EXTENSIONS.has(extension) || ODF_MIME_TYPES.has(normalizedMimeType)) return 'odf';
    if (ZIP_PREVIEW_EXTENSIONS.has(extension) || ZIP_MIME_TYPES.has(normalizedMimeType)) return 'zip';
    if (LEGACY_OFFICE_PREVIEW_EXTENSIONS.has(extension) && isPublicHttpUrl(sourceUrl)) return 'office-online';
    if (LEGACY_OFFICE_PREVIEW_EXTENSIONS.has(extension) || ARCHIVE_BINARY_EXTENSIONS.has(extension)) {
      return 'binary-text';
    }
    return 'binary-text';
  }, [extension, normalizedMimeType, preview, sourceUrl]);

  const officeViewerUrl = useMemo(() => {
    if (previewMode !== 'office-online') return '';
    return `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(sourceUrl)}`;
  }, [previewMode, sourceUrl]);

  const pdfPreviewUrl = useMemo(() => {
    if (previewMode !== 'pdf') return '';
    if (!sourceUrl) return '';
    return buildPdfPageUrl(sourceUrl, 1);
  }, [previewMode, sourceUrl]);

  useEffect(() => {
    setActiveSlideIndex(0);
  }, [sourceUrl, previewMode, isSlideshowEnabled]);

  useEffect(() => {
    setIsAutoplayActive(Boolean(slideshowAutoplay));
  }, [previewMode, slideshowAutoplay, sourceUrl]);

  useEffect(() => {
    if (slides.length === 0 && activeSlideIndex !== 0) {
      setActiveSlideIndex(0);
      return;
    }
    if (slides.length > 0 && activeSlideIndex > slides.length - 1) {
      setActiveSlideIndex(0);
    }
  }, [activeSlideIndex, slides.length]);

  useEffect(() => {
    if (!isSlideshowEnabled || !isAutoplayActive || slides.length <= 1 || textLoading) return;
    const timer = setInterval(() => {
      setActiveSlideIndex((previous) => (previous + 1) % slides.length);
    }, normalizedSlideIntervalMs);
    return () => clearInterval(timer);
  }, [isAutoplayActive, isSlideshowEnabled, normalizedSlideIntervalMs, slides.length, textLoading]);

  useEffect(() => {
    if (typeof onSlideCountChange !== 'function') return;
    const count = isSlideshowEnabled ? Math.max(1, slides.length) : 1;
    onSlideCountChange(count);
  }, [isSlideshowEnabled, onSlideCountChange, slides.length]);

  useEffect(() => {
    if (typeof onSlideIndexChange !== 'function') return;
    if (!isSlideshowEnabled) {
      onSlideIndexChange(1);
      return;
    }
    const index = slides.length > 0 ? Math.min(activeSlideIndex + 1, slides.length) : 1;
    onSlideIndexChange(index);
  }, [activeSlideIndex, isSlideshowEnabled, onSlideIndexChange, slides.length]);

  useEffect(() => {
    let active = true;

    const clearInlinePreview = () => {
      setTextContent('');
      setTextError('');
      setTextLoading(false);
      setHtmlPreview('');
      setSheetPreviews([]);
      setSlides([]);
    };

    if (!sourceUrl || previewMode === 'none') {
      clearInlinePreview();
      return () => {
        active = false;
      };
    }

    if (previewMode === 'office-online') {
      setTextContent('');
      setTextError('');
      setTextLoading(false);
      setHtmlPreview('');
      setSheetPreviews([]);
      if (isSlideshowEnabled && officeViewerUrl) {
        setSlides([
          {
            id: 'office-1',
            type: 'office-frame',
            src: officeViewerUrl,
            label: 'Page 1'
          }
        ]);
      } else {
        setSlides([]);
      }
      return () => {
        active = false;
      };
    }

    if (previewMode === 'pdf' && !isSlideshowEnabled) {
      setTextContent('');
      setTextError('');
      setTextLoading(false);
      setHtmlPreview('');
      setSheetPreviews([]);
      setSlides([]);
      return () => {
        active = false;
      };
    }

    const loadPreviewContent = async () => {
      setTextLoading(true);
      setTextError('');
      setTextContent('');
      setHtmlPreview('');
      setSheetPreviews([]);
      setSlides([]);

      const isPdfSlideshow = previewMode === 'pdf' && isSlideshowEnabled;
      if (parsedFileSizeBytes && parsedFileSizeBytes > MAX_INLINE_PARSE_BYTES && !isPdfSlideshow) {
        setTextLoading(false);
        setTextError(
          `File is too large for inline parsing (${formatFileSize(
            parsedFileSizeBytes
          )}). Use Open or Download for full view.`
        );
        return;
      }

      if (isPdfSlideshow && parsedFileSizeBytes && parsedFileSizeBytes > MAX_SLIDESHOW_PARSE_BYTES) {
        setTextLoading(false);
        setTextError(
          `File is too large for slide-by-slide preview (${formatFileSize(
            parsedFileSizeBytes
          )}). Use Open or Download for full view.`
        );
        return;
      }

      try {
        const response = await fetch(sourceUrl);
        if (!response.ok) {
          throw new Error(`Unable to load document (${response.status})`);
        }
        const responseMimeType = normalizeMimeType(response.headers.get('content-type')) || normalizedMimeType;

        const applyTextContent = (rawText, labelPrefix = 'Page') => {
          const normalizedText = String(rawText || '').trim();
          if (!normalizedText) return;
          setTextContent(truncateText(normalizedText));
          if (isSlideshowEnabled) {
            const textSlides = buildTextSlideEntries(normalizedText, labelPrefix);
            if (textSlides.length > 0) {
              setSlides(textSlides);
            }
          }
        };

        if (previewMode === 'text') {
          const content = await response.text();
          if (!active) return;
          applyTextContent(content, 'Page');
          return;
        }

        const arrayBuffer = await response.arrayBuffer();
        if (!active) return;

        if (previewMode === 'pdf') {
          const loadingTask = getDocument({ data: arrayBuffer });
          const pdfDocument = await loadingTask.promise;
          const pageCount = Math.max(1, Number.parseInt(pdfDocument.numPages, 10) || 1);
          if (typeof pdfDocument.destroy === 'function') {
            await pdfDocument.destroy();
          }
          if (!active) return;
          setSlides(
            Array.from({ length: pageCount }, (_, index) => ({
              id: `pdf-${index + 1}`,
              type: 'pdf-page',
              pageNumber: index + 1,
              label: `Page ${index + 1}`
            }))
          );
          return;
        }

        if (previewMode === 'word') {
          const result = await mammoth.convertToHtml({ arrayBuffer });
          if (!active) return;
          const html = result.value || '<p>No readable text found in this file.</p>';
          setHtmlPreview(wrapHtmlPreview(html));
          if (isSlideshowEnabled) {
            const textSlides = buildTextSlideEntries(extractPlainTextFromHtml(html), 'Page');
            if (textSlides.length > 0) {
              setSlides(textSlides);
            } else {
              setSlides([
                {
                  id: 'word-1',
                  type: 'html',
                  srcDoc: wrapHtmlPreview(html),
                  label: 'Page 1'
                }
              ]);
            }
          }
          return;
        }

        if (previewMode === 'sheet') {
          const workbook = XLSX.read(arrayBuffer, { type: 'array' });
          const sheetDocs = buildSheetPreviewsFromWorkbook(workbook);
          if (!active) return;
          if (sheetDocs.length === 0) {
            setTextError('No readable sheets found in this file.');
          } else if (isSlideshowEnabled) {
            setSlides(
              sheetDocs.map((sheet, index) => ({
                id: `sheet-${index + 1}`,
                type: 'sheet',
                srcDoc: sheet.srcDoc,
                name: sheet.name,
                label: `Sheet ${index + 1}: ${sheet.name}`
              }))
            );
          } else {
            setSheetPreviews(sheetDocs);
          }
          return;
        }

        if (previewMode === 'presentation') {
          const presentationSlides = await extractPptxSlides(arrayBuffer);
          if (!active) return;
          if (presentationSlides.length === 0) {
            setTextError('No readable slide text found in this presentation.');
          } else if (isSlideshowEnabled) {
            setSlides(
              presentationSlides.map((text, index) => ({
                id: `presentation-${index + 1}`,
                type: 'text',
                content: text,
                label: `Slide ${index + 1}`
              }))
            );
          } else {
            const formatted = presentationSlides
              .slice(0, 200)
              .map((text, index) => `Slide ${index + 1}\n${text}`)
              .join('\n\n');
            setTextContent(truncateText(formatted));
          }
          return;
        }

        if (previewMode === 'odf') {
          const odfText = await extractOdfText(arrayBuffer);
          if (!active) return;
          if (!odfText) {
            setTextError('No readable content found in this document.');
          } else {
            applyTextContent(odfText, 'Page');
          }
          return;
        }

        if (previewMode === 'zip') {
          const entries = await extractZipEntries(arrayBuffer);
          if (!active) return;
          if (entries.length === 0) {
            setTextError('This archive is empty.');
          } else {
            const listing = entries.map((item, index) => `${index + 1}. ${item}`).join('\n');
            applyTextContent(listing, 'Page');
          }
          return;
        }

        if (previewMode === 'binary-text') {
          const zipDetected = looksLikeZipArchive(arrayBuffer);
          if (zipDetected) {
            try {
              const zip = await JSZip.loadAsync(arrayBuffer);
              const entries = Object.values(zip.files)
                .filter((entry) => entry && !entry.dir)
                .map((entry) => entry.name);

              const hasDocxLayout = entries.some((name) => name === 'word/document.xml');
              const hasXlsxLayout = entries.some((name) => name === 'xl/workbook.xml');
              const hasPptxLayout = entries.some((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name));
              const hasOdfLayout = entries.some((name) => name === 'content.xml');

              if (hasDocxLayout) {
                const result = await mammoth.convertToHtml({ arrayBuffer });
                if (!active) return;
                const html = result.value || '<p>No readable text found in this file.</p>';
                setHtmlPreview(wrapHtmlPreview(html));
                if (isSlideshowEnabled) {
                  const textSlides = buildTextSlideEntries(extractPlainTextFromHtml(html), 'Page');
                  if (textSlides.length > 0) {
                    setSlides(textSlides);
                  }
                }
                return;
              }

              if (hasXlsxLayout) {
                const workbook = XLSX.read(arrayBuffer, { type: 'array' });
                const sheetDocs = buildSheetPreviewsFromWorkbook(workbook);
                if (!active) return;
                if (sheetDocs.length > 0) {
                  if (isSlideshowEnabled) {
                    setSlides(
                      sheetDocs.map((sheet, index) => ({
                        id: `sheet-${index + 1}`,
                        type: 'sheet',
                        srcDoc: sheet.srcDoc,
                        name: sheet.name,
                        label: `Sheet ${index + 1}: ${sheet.name}`
                      }))
                    );
                  } else {
                    setSheetPreviews(sheetDocs);
                  }
                  return;
                }
              }

              if (hasPptxLayout) {
                const presentationSlides = await extractPptxSlides(arrayBuffer);
                if (!active) return;
                if (presentationSlides.length > 0) {
                  if (isSlideshowEnabled) {
                    setSlides(
                      presentationSlides.map((text, index) => ({
                        id: `presentation-${index + 1}`,
                        type: 'text',
                        content: text,
                        label: `Slide ${index + 1}`
                      }))
                    );
                  } else {
                    const formatted = presentationSlides
                      .slice(0, 200)
                      .map((text, index) => `Slide ${index + 1}\n${text}`)
                      .join('\n\n');
                    setTextContent(truncateText(formatted));
                  }
                  return;
                }
              }

              if (hasOdfLayout) {
                const odfText = await extractOdfText(arrayBuffer);
                if (!active) return;
                if (odfText) {
                  applyTextContent(odfText, 'Page');
                  return;
                }
              }

              const readableArchiveEntries = entries
                .filter((name) =>
                  /\.(txt|md|markdown|csv|json|xml|html|htm|xhtml|yaml|yml|ini|conf|log|sql)$/i.test(name)
                )
                .slice(0, 10);
              if (readableArchiveEntries.length > 0) {
                const chunks = [];
                for (const entryName of readableArchiveEntries) {
                  const zipFile = zip.file(entryName);
                  if (!zipFile) continue;
                  const rawText = await zipFile.async('string');
                  const cleaned = String(rawText || '').trim();
                  if (!cleaned) continue;
                  chunks.push(`[${entryName}]\n${truncateText(cleaned, 5000)}`);
                }

                if (!active) return;
                if (chunks.length > 0) {
                  applyTextContent(chunks.join('\n\n'), 'Page');
                  return;
                }
              }

              if (entries.length > 0) {
                const listing = entries.slice(0, 500).map((item, index) => `${index + 1}. ${item}`).join('\n');
                applyTextContent(listing, 'Page');
                return;
              }
            } catch {
              // Continue to generic extraction below.
            }
          }

          if (isLikelyTextMime(responseMimeType)) {
            const decoded = new TextDecoder().decode(arrayBuffer.slice(0, MAX_BINARY_PREVIEW_BYTES));
            if (!active) return;
            if (String(decoded || '').trim()) {
              applyTextContent(decoded, 'Page');
              return;
            }
          }

          const extracted = extractPrintableStringsFromBinary(arrayBuffer);
          if (!active) return;
          if (!extracted) {
            setTextError('No readable text could be extracted in browser for this document.');
          } else {
            applyTextContent(extracted, 'Page');
          }
          return;
        }
      } catch (error) {
        if (!active) return;
        setTextError(error.message || 'Unable to preview this document.');
      } finally {
        if (active) {
          setTextLoading(false);
        }
      }
    };

    loadPreviewContent();
    return () => {
      active = false;
    };
  }, [
    isSlideshowEnabled,
    normalizedMimeType,
    officeViewerUrl,
    parsedFileSizeBytes,
    previewMode,
    sourceUrl
  ]);

  if (!sourceUrl) return null;

  const hasSlides = isSlideshowEnabled && slides.length > 0;
  const clampedSlideIndex = hasSlides ? Math.min(activeSlideIndex, slides.length - 1) : 0;
  const activeSlide = hasSlides ? slides[clampedSlideIndex] : null;
  const slideshowStatusLabel =
    hasSlides && activeSlide
      ? `${activeSlide.label || `Page ${clampedSlideIndex + 1}`} • ${clampedSlideIndex + 1} of ${slides.length}`
      : textLoading
        ? 'Preparing pages...'
        : textError
          ? 'Slide preview unavailable'
          : 'Single page';

  const slideIndicatorIndexes = (() => {
    if (!hasSlides) return [];
    if (slides.length <= 12) {
      return Array.from({ length: slides.length }, (_, index) => index);
    }

    const start = Math.max(0, Math.min(clampedSlideIndex - 5, slides.length - 12));
    return Array.from({ length: 12 }, (_, offset) => start + offset);
  })();

  const goToSlide = (index) => {
    if (!hasSlides) return;
    const target = Math.max(0, Math.min(Number.parseInt(index, 10) || 0, slides.length - 1));
    setActiveSlideIndex(target);
  };

  const goToNextSlide = () => {
    if (!hasSlides || slides.length <= 1) return;
    setActiveSlideIndex((previous) => (previous + 1) % slides.length);
  };

  const goToPreviousSlide = () => {
    if (!hasSlides || slides.length <= 1) return;
    setActiveSlideIndex((previous) => (previous - 1 + slides.length) % slides.length);
  };

  const renderSlideFrame = (slide) => {
    if (!slide) return null;

    if (slide.type === 'pdf-page') {
      return (
        <iframe
          className="document-preview__frame"
          src={buildPdfPageUrl(sourceUrl, slide.pageNumber)}
          title={`${title} - ${slide.label || 'Page'}`}
        />
      );
    }

    if (slide.type === 'office-frame') {
      return <iframe className="document-preview__frame" src={slide.src} title={`${title} - ${slide.label || 'Document'}`} />;
    }

    if (slide.type === 'sheet' || slide.type === 'html') {
      return (
        <iframe
          className="document-preview__frame"
          srcDoc={slide.srcDoc || ''}
          title={`${title} - ${slide.label || 'Slide'}`}
        />
      );
    }

    return <pre className="document-preview__text document-preview__text--slide">{slide.content || ''}</pre>;
  };

  const showTextPreview =
    (previewMode === 'text' ||
      previewMode === 'presentation' ||
      previewMode === 'odf' ||
      previewMode === 'zip' ||
      previewMode === 'binary-text') &&
    !isSlideshowEnabled &&
    (textLoading || Boolean(textError) || Boolean(textContent));

  return (
    <div className={`document-preview ${className}`.trim()}>
      {!hideHeader ? (
        <div className="document-preview__header">
          <p className="document-preview__name">{resolvedName}</p>
          <p className="document-preview__meta">{metaLabel}</p>
          {isSlideshowEnabled ? (
            <p className="document-preview__meta document-preview__meta--slideshow">{slideshowStatusLabel}</p>
          ) : null}
        </div>
      ) : null}

      {isSlideshowEnabled ? (
        <div className="document-preview__slideshow">
          {textLoading && !activeSlide ? (
            <p className="document-preview__hint">Loading document pages...</p>
          ) : null}

          {textError && !activeSlide ? <p className="document-preview__hint">{textError}</p> : null}

          {activeSlide ? renderSlideFrame(activeSlide) : null}

          {hasSlides ? (
            <div className="document-preview__slideshow-controls">
              <button
                type="button"
                className="btn btn--ghost btn--tiny"
                onClick={goToPreviousSlide}
                disabled={slides.length <= 1}
              >
                Prev
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--tiny"
                onClick={() => setIsAutoplayActive((value) => !value)}
                disabled={slides.length <= 1}
              >
                {isAutoplayActive ? 'Pause' : 'Play'}
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--tiny"
                onClick={goToNextSlide}
                disabled={slides.length <= 1}
              >
                Next
              </button>
            </div>
          ) : null}

          {slideIndicatorIndexes.length > 1 ? (
            <div className="document-preview__dots" role="tablist" aria-label="Document pages">
              {slideIndicatorIndexes.map((index) => (
                <button
                  key={`slide-dot-${index + 1}`}
                  type="button"
                  className={`document-preview__dot ${index === clampedSlideIndex ? 'is-active' : ''}`.trim()}
                  onClick={() => goToSlide(index)}
                  aria-label={`Go to page ${index + 1}`}
                  aria-current={index === clampedSlideIndex ? 'true' : 'false'}
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {!isSlideshowEnabled && previewMode === 'pdf' ? (
        <iframe className="document-preview__frame" src={pdfPreviewUrl} title={title} />
      ) : null}

      {!isSlideshowEnabled && previewMode === 'office-online' ? (
        <iframe className="document-preview__frame" src={officeViewerUrl} title={title} />
      ) : null}

      {!isSlideshowEnabled && htmlPreview ? (
        <iframe className="document-preview__frame" srcDoc={htmlPreview} title={title} />
      ) : null}

      {!isSlideshowEnabled && sheetPreviews.length > 0 ? (
        <div className="document-preview__sheet-list">
          {sheetPreviews.map((sheet) => (
            <div className="document-preview__sheet" key={sheet.name}>
              <p className="document-preview__meta">{sheet.name}</p>
              <iframe
                className="document-preview__frame"
                srcDoc={sheet.srcDoc}
                title={`${title} - ${sheet.name}`}
              />
            </div>
          ))}
        </div>
      ) : null}

      {showTextPreview ? (
        textLoading ? (
          <p className="document-preview__hint">Loading document preview...</p>
        ) : textError ? (
          <p className="document-preview__hint">{textError}</p>
        ) : (
          <pre className="document-preview__text">{textContent}</pre>
        )
      ) : null}

      {previewMode === 'unsupported' && preview ? (
        <p className="document-preview__hint">
          Inline preview is not available for this format in browser. Use Open or Download.
        </p>
      ) : null}

      {showActions ? (
        <div className="inline-actions">
          <a className="btn btn--ghost btn--tiny" href={sourceUrl} target="_blank" rel="noreferrer">
            Open Document
          </a>
          <a className="btn btn--ghost btn--tiny" href={sourceUrl} download={resolvedName}>
            Download
          </a>
        </div>
      ) : null}
    </div>
  );
};

export default DocumentAttachment;
