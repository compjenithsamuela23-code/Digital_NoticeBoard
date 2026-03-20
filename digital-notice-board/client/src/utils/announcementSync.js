function normalizeCategoryFilter(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return 'all';
  return normalized.toLowerCase() === 'all' ? 'all' : normalized.toLowerCase();
}

function normalizePriorityValue(value, fallback = 1) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isEmergencyPriorityValue(value) {
  return normalizePriorityValue(value, 1) === 0;
}

function getAnnouncementTimestamp(value) {
  const timestamp = Date.parse(String(value || '').trim());
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function getSortTimestamp(announcement) {
  return Math.max(
    getAnnouncementTimestamp(announcement?.updatedAt),
    getAnnouncementTimestamp(announcement?.createdAt)
  );
}

function hasAnnouncementLiveLinks(announcement) {
  return (
    Array.isArray(announcement?.liveStreamLinks) &&
    announcement.liveStreamLinks.some((value) => String(value || '').trim().length > 0)
  );
}

export function comparePublicAnnouncements(left, right) {
  const leftEmergency = isEmergencyPriorityValue(left?.priority) || left?.isEmergency === true;
  const rightEmergency = isEmergencyPriorityValue(right?.priority) || right?.isEmergency === true;
  if (leftEmergency !== rightEmergency) {
    return leftEmergency ? -1 : 1;
  }

  const leftHasLiveStream = hasAnnouncementLiveLinks(left);
  const rightHasLiveStream = hasAnnouncementLiveLinks(right);
  if (leftHasLiveStream !== rightHasLiveStream) {
    return leftHasLiveStream ? -1 : 1;
  }

  const leftPriority = normalizePriorityValue(left?.priority, 1);
  const rightPriority = normalizePriorityValue(right?.priority, 1);
  if (leftPriority !== rightPriority && !leftEmergency && !rightEmergency) {
    return rightPriority - leftPriority;
  }

  const leftSortTimestamp = getSortTimestamp(left);
  const rightSortTimestamp = getSortTimestamp(right);
  if (leftSortTimestamp !== rightSortTimestamp) {
    return rightSortTimestamp - leftSortTimestamp;
  }

  return String(right?.id || '').localeCompare(String(left?.id || ''));
}

export function compareWorkspaceAnnouncements(left, right) {
  const leftCreatedAt = getAnnouncementTimestamp(left?.createdAt);
  const rightCreatedAt = getAnnouncementTimestamp(right?.createdAt);
  if (leftCreatedAt !== rightCreatedAt) {
    return rightCreatedAt - leftCreatedAt;
  }

  return String(right?.id || '').localeCompare(String(left?.id || ''));
}

export function isAnnouncementVisibleForDisplayCategory(announcement, requestedCategory) {
  const normalizedRequest = normalizeCategoryFilter(requestedCategory);
  if (normalizedRequest === 'all') return true;
  if (!announcement) return false;
  if (isEmergencyPriorityValue(announcement.priority) || announcement.isEmergency === true) {
    return true;
  }

  const announcementCategory = normalizeCategoryFilter(announcement.category);
  if (announcementCategory === 'all') {
    return true;
  }

  return announcementCategory === normalizedRequest;
}

function isAnnouncementInPublicWindow(announcement, nowMs) {
  if (!announcement || announcement.isActive === false) {
    return false;
  }

  const startAtMs = getAnnouncementTimestamp(announcement.startAt);
  if (startAtMs && startAtMs > nowMs) {
    return false;
  }

  const endAtMs = getAnnouncementTimestamp(announcement.endAt);
  if (endAtMs && endAtMs <= nowMs) {
    return false;
  }

  return true;
}

function isAnnouncementInWorkspaceWindow(announcement, nowMs) {
  if (!announcement) {
    return false;
  }

  const endAtMs = getAnnouncementTimestamp(announcement.endAt);
  if (endAtMs && endAtMs <= nowMs) {
    return false;
  }

  return true;
}

function shouldIncludeAnnouncement(announcement, scope, category, nowMs) {
  if (scope === 'public') {
    return (
      isAnnouncementInPublicWindow(announcement, nowMs) &&
      isAnnouncementVisibleForDisplayCategory(announcement, category)
    );
  }

  return isAnnouncementInWorkspaceWindow(announcement, nowMs);
}

function sortAnnouncements(rows, scope) {
  const sorter = scope === 'public' ? comparePublicAnnouncements : compareWorkspaceAnnouncements;
  return [...rows].sort(sorter);
}

function upsertAnnouncements(currentRows, incomingRows, { scope, category, nowMs }) {
  const byId = new Map();

  (Array.isArray(currentRows) ? currentRows : []).forEach((announcement) => {
    const id = String(announcement?.id || '').trim();
    if (id) {
      byId.set(id, announcement);
    }
  });

  (Array.isArray(incomingRows) ? incomingRows : []).forEach((announcement) => {
    const id = String(announcement?.id || '').trim();
    if (!id) {
      return;
    }

    if (shouldIncludeAnnouncement(announcement, scope, category, nowMs)) {
      byId.set(id, announcement);
      return;
    }

    byId.delete(id);
  });

  return sortAnnouncements([...byId.values()], scope);
}

function removeAnnouncements(currentRows, idsToRemove = [], batchId = '') {
  const normalizedIds = new Set(
    (Array.isArray(idsToRemove) ? idsToRemove : []).map((value) => String(value || '').trim()).filter(Boolean)
  );
  const normalizedBatchId = String(batchId || '').trim();

  return (Array.isArray(currentRows) ? currentRows : []).filter((announcement) => {
    const announcementId = String(announcement?.id || '').trim();
    const announcementBatchId = String(announcement?.displayBatchId || '').trim();

    if (normalizedIds.has(announcementId)) {
      return false;
    }

    if (normalizedBatchId && announcementBatchId === normalizedBatchId) {
      return false;
    }

    return true;
  });
}

export function applyAnnouncementSocketEvent(rows, event, options = {}) {
  const scope = options.scope === 'public' ? 'public' : 'workspace';
  const category = options.category || 'all';
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const action = String(event?.action || '').trim().toLowerCase();

  if (!action) {
    return null;
  }

  if (action === 'create' || action === 'update') {
    return event?.announcement
      ? upsertAnnouncements(rows, [event.announcement], { scope, category, nowMs })
      : null;
  }

  if (action === 'batch_create' || action === 'batch_update') {
    return Array.isArray(event?.announcements) && event.announcements.length > 0
      ? upsertAnnouncements(rows, event.announcements, { scope, category, nowMs })
      : null;
  }

  if (action === 'delete') {
    const announcementId = String(event?.id || '').trim();
    return announcementId ? removeAnnouncements(rows, [announcementId]) : null;
  }

  if (action === 'batch_delete' || action === 'expire') {
    const nextRows = removeAnnouncements(rows, event?.ids, event?.batchId);
    return sortAnnouncements(nextRows, scope);
  }

  return null;
}
