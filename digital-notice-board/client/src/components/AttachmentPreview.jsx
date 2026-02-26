import React, { useMemo, useState } from 'react';
import { assetUrl } from '../config/api';
import DocumentAttachment from './DocumentAttachment';

const IMAGE_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'gif',
  'bmp',
  'tif',
  'tiff',
  'webp',
  'avif',
  'heif',
  'heic',
  'apng',
  'svg',
  'ai',
  'eps',
  'psd',
  'raw',
  'dng',
  'cr2',
  'cr3',
  'nef',
  'arw',
  'orf',
  'rw2'
]);

const VIDEO_EXTENSIONS = new Set([
  'mp4',
  'm4v',
  'm4p',
  'mov',
  'avi',
  'mkv',
  'webm',
  'ogg',
  'ogv',
  'flv',
  'f4v',
  'wmv',
  'asf',
  'ts',
  'm2ts',
  'mts',
  '3gp',
  '3g2',
  'mpg',
  'mpeg',
  'mpe',
  'vob',
  'mxf',
  'rm',
  'rmvb',
  'qt',
  'hevc',
  'h265',
  'h264',
  'r3d',
  'braw',
  'cdng',
  'prores',
  'dnxhd',
  'dnxhr',
  'dv',
  'mjpeg'
]);

const DOCUMENT_EXTENSIONS = new Set([
  'pdf',
  'doc',
  'docx',
  'ppt',
  'pptx',
  'pps',
  'ppsx',
  'xls',
  'xlsx',
  'csv',
  'txt',
  'rtf',
  'odt',
  'ods',
  'odp',
  'md',
  'json',
  'xml',
  'zip',
  'rar',
  '7z'
]);

function getFileName(value) {
  const raw = String(value || '').split('/').pop() || '';
  const clean = raw.split('?')[0].split('#')[0];
  return decodeURIComponent(clean || 'Attached file');
}

function getExtension(value) {
  const fileName = getFileName(value);
  const index = fileName.lastIndexOf('.');
  if (index === -1 || index === fileName.length - 1) return '';
  return fileName.slice(index + 1).toLowerCase();
}

function inferKind(typeHint, extension) {
  const hint = String(typeHint || '').toLowerCase();

  if (hint.includes('video') || hint.startsWith('video/')) return 'video';
  if (hint.includes('document') || hint.startsWith('application/') || hint.startsWith('text/')) {
    return 'document';
  }
  if (hint.includes('image') || hint.startsWith('image/') || hint === 'mixed') return 'image';

  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (DOCUMENT_EXTENSIONS.has(extension)) return 'document';

  return 'document';
}

const AttachmentPreview = ({
  filePath,
  fileUrl,
  fileName,
  typeHint,
  fileSizeBytes,
  className = '',
  preview = true,
  documentPreview = true,
  documentHideHeader = false,
  documentSlideshow = false,
  documentSlideshowAutoplay = true,
  documentSlideshowIntervalMs,
  onDocumentSlideCountChange,
  onDocumentSlideIndexChange,
  title = 'Attachment',
  imageAlt = 'Attachment'
}) => {
  const [failedSourceKey, setFailedSourceKey] = useState('');
  const [loadedSourceKey, setLoadedSourceKey] = useState('');

  const sourceUrl = useMemo(() => {
    if (fileUrl) return fileUrl;
    if (filePath) return assetUrl(filePath);
    return '';
  }, [filePath, fileUrl]);

  const resolvedName = useMemo(() => {
    if (fileName) return fileName;
    if (filePath) return getFileName(filePath);
    if (fileUrl) return getFileName(fileUrl);
    return 'Attached file';
  }, [fileName, filePath, fileUrl]);

  const extension = useMemo(
    () => getExtension(fileName || filePath || fileUrl),
    [fileName, filePath, fileUrl]
  );
  const kind = useMemo(() => inferKind(typeHint, extension), [typeHint, extension]);
  const sourceKey = `${sourceUrl}|${kind}`;
  const previewFailed = failedSourceKey === sourceKey;
  const isMediaLoading =
    (kind === 'image' || kind === 'video') && preview && !previewFailed && loadedSourceKey !== sourceKey;

  if (!sourceUrl) return null;

  if (kind === 'document') {
    return (
      <DocumentAttachment
        filePath={filePath}
        fileUrl={fileUrl}
        fileName={resolvedName}
        mimeType={typeHint}
        fileSizeBytes={fileSizeBytes}
        className={className}
        preview={documentPreview && preview}
        hideHeader={documentHideHeader}
        slideshow={documentSlideshow}
        slideshowAutoplay={documentSlideshowAutoplay}
        slideshowIntervalMs={documentSlideshowIntervalMs}
        onSlideCountChange={onDocumentSlideCountChange}
        onSlideIndexChange={onDocumentSlideIndexChange}
        title={title}
      />
    );
  }

  if (!previewFailed && preview && kind === 'image') {
    return (
      <div className={`media-preview ${className}`.trim()}>
        <img
          src={sourceUrl}
          alt={imageAlt}
          loading="eager"
          decoding="async"
          onLoad={() => setLoadedSourceKey(sourceKey)}
          onError={() => {
            setLoadedSourceKey(sourceKey);
            setFailedSourceKey(sourceKey);
          }}
        />
        {isMediaLoading ? <p className="media-preview__loading">Loading media...</p> : null}
      </div>
    );
  }

  if (!previewFailed && preview && kind === 'video') {
    return (
      <div className={`media-preview ${className}`.trim()}>
        <video
          src={sourceUrl}
          controls
          preload="metadata"
          playsInline
          onLoadedData={() => setLoadedSourceKey(sourceKey)}
          onError={() => {
            setLoadedSourceKey(sourceKey);
            setFailedSourceKey(sourceKey);
          }}
        />
        {isMediaLoading ? <p className="media-preview__loading">Loading media...</p> : null}
      </div>
    );
  }

  const hint =
    kind === 'image'
      ? 'This image format cannot be previewed in browser. Use Open or Download.'
      : kind === 'video'
        ? 'This video format cannot be previewed in browser. Use Open or Download.'
        : 'Preview is not available for this file format.';

  return (
    <div className={`document-preview ${className}`.trim()}>
      <div className="document-preview__header">
        <p className="document-preview__name">{resolvedName}</p>
        <p className="document-preview__meta">{extension ? extension.toUpperCase() : 'FILE'}</p>
      </div>
      <p className="document-preview__hint">{hint}</p>
      <div className="inline-actions">
        <a className="btn btn--ghost btn--tiny" href={sourceUrl} target="_blank" rel="noreferrer">
          Open
        </a>
        <a className="btn btn--ghost btn--tiny" href={sourceUrl} download={resolvedName}>
          Download
        </a>
      </div>
    </div>
  );
};

export default AttachmentPreview;
