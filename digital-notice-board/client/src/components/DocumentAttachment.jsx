import React, { useEffect, useMemo, useState } from 'react';
import { assetUrl } from '../config/api';
import * as mammoth from 'mammoth/mammoth.browser';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';

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

const DocumentAttachment = ({
  filePath,
  fileUrl,
  fileName,
  mimeType,
  fileSizeBytes,
  title = 'Document Attachment',
  className = '',
  preview = true
}) => {
  const [textContent, setTextContent] = useState('');
  const [textLoading, setTextLoading] = useState(false);
  const [textError, setTextError] = useState('');
  const [htmlPreview, setHtmlPreview] = useState('');
  const [sheetPreviews, setSheetPreviews] = useState([]);

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
    if (sourceUrl.includes('#')) return sourceUrl;
    return `${sourceUrl}#toolbar=0&navpanes=0&scrollbar=0&view=FitH`;
  }, [previewMode, sourceUrl]);

  useEffect(() => {
    let active = true;
    if (!sourceUrl || previewMode === 'none' || previewMode === 'pdf' || previewMode === 'office-online') {
      setTextContent('');
      setTextError('');
      setTextLoading(false);
      setHtmlPreview('');
      setSheetPreviews([]);
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

      if (
        parsedFileSizeBytes &&
        parsedFileSizeBytes > MAX_INLINE_PARSE_BYTES &&
        previewMode !== 'pdf' &&
        previewMode !== 'office-online'
      ) {
        setTextLoading(false);
        setTextError(
          `File is too large for inline parsing (${formatFileSize(
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

        if (previewMode === 'text') {
          const content = await response.text();
          if (!active) return;
          setTextContent(truncateText(content));
          return;
        }

        const arrayBuffer = await response.arrayBuffer();
        if (!active) return;

        if (previewMode === 'word') {
          const result = await mammoth.convertToHtml({ arrayBuffer });
          if (!active) return;
          setHtmlPreview(wrapHtmlPreview(result.value || '<p>No readable text found in this file.</p>'));
          return;
        }

        if (previewMode === 'sheet') {
          const workbook = XLSX.read(arrayBuffer, { type: 'array' });
          const sheetDocs = buildSheetPreviewsFromWorkbook(workbook);
          if (!active) return;
          if (sheetDocs.length === 0) {
            setTextError('No readable sheets found in this file.');
          } else {
            setSheetPreviews(sheetDocs);
          }
          return;
        }

        if (previewMode === 'presentation') {
          const slides = await extractPptxSlides(arrayBuffer);
          if (!active) return;
          if (slides.length === 0) {
            setTextError('No readable slide text found in this presentation.');
          } else {
            const formatted = slides
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
            setTextContent(truncateText(odfText));
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
            setTextContent(truncateText(listing));
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
                setHtmlPreview(wrapHtmlPreview(result.value || '<p>No readable text found in this file.</p>'));
                return;
              }

              if (hasXlsxLayout) {
                const workbook = XLSX.read(arrayBuffer, { type: 'array' });
                const sheetDocs = buildSheetPreviewsFromWorkbook(workbook);
                if (!active) return;
                if (sheetDocs.length > 0) {
                  setSheetPreviews(sheetDocs);
                  return;
                }
              }

              if (hasPptxLayout) {
                const slides = await extractPptxSlides(arrayBuffer);
                if (!active) return;
                if (slides.length > 0) {
                  const formatted = slides
                    .slice(0, 200)
                    .map((text, index) => `Slide ${index + 1}\n${text}`)
                    .join('\n\n');
                  setTextContent(truncateText(formatted));
                  return;
                }
              }

              if (hasOdfLayout) {
                const odfText = await extractOdfText(arrayBuffer);
                if (!active) return;
                if (odfText) {
                  setTextContent(truncateText(odfText));
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
                  setTextContent(truncateText(chunks.join('\n\n')));
                  return;
                }
              }

              if (entries.length > 0) {
                const listing = entries.slice(0, 500).map((item, index) => `${index + 1}. ${item}`).join('\n');
                setTextContent(truncateText(listing));
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
              setTextContent(truncateText(decoded));
              return;
            }
          }

          const extracted = extractPrintableStringsFromBinary(arrayBuffer);
          if (!active) return;
          if (!extracted) {
            setTextError('No readable text could be extracted in browser for this document.');
          } else {
            setTextContent(truncateText(extracted));
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
  }, [normalizedMimeType, parsedFileSizeBytes, previewMode, sourceUrl]);

  if (!sourceUrl) return null;

  const showTextPreview =
    (previewMode === 'text' ||
      previewMode === 'presentation' ||
      previewMode === 'odf' ||
      previewMode === 'zip' ||
      previewMode === 'binary-text') &&
    (textLoading || Boolean(textError) || Boolean(textContent));

  return (
    <div className={`document-preview ${className}`.trim()}>
      <div className="document-preview__header">
        <p className="document-preview__name">{resolvedName}</p>
        <p className="document-preview__meta">{metaLabel}</p>
      </div>

      {previewMode === 'pdf' ? (
        <iframe className="document-preview__frame" src={pdfPreviewUrl} title={title} />
      ) : null}

      {previewMode === 'office-online' ? (
        <iframe className="document-preview__frame" src={officeViewerUrl} title={title} />
      ) : null}

      {htmlPreview ? (
        <iframe className="document-preview__frame" srcDoc={htmlPreview} title={title} />
      ) : null}

      {sheetPreviews.length > 0 ? (
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

      <div className="inline-actions">
        <a className="btn btn--ghost btn--tiny" href={sourceUrl} target="_blank" rel="noreferrer">
          Open Document
        </a>
        <a className="btn btn--ghost btn--tiny" href={sourceUrl} download={resolvedName}>
          Download
        </a>
      </div>
    </div>
  );
};

export default DocumentAttachment;
