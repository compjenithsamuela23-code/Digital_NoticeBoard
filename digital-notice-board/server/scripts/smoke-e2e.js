const { randomUUID } = require('crypto');

const BASE_URL = String(process.env.SMOKE_BASE_URL || 'http://localhost:5001').replace(/\/+$/, '');
const ADMIN_USERNAME = String(process.env.SMOKE_ADMIN_USERNAME || 'admin@noticeboard.com')
  .trim()
  .toLowerCase();
const ADMIN_PASSWORD = String(process.env.SMOKE_ADMIN_PASSWORD || 'admin123').trim();

const ANNOUNCEMENT_ACTIONS = new Set(['created', 'updated', 'deleted', 'expired']);

function buildUrl(pathname) {
  const path = String(pathname || '').startsWith('/') ? pathname : `/${pathname}`;
  return `${BASE_URL}${path}`;
}

function summarizePayload(payload) {
  if (!payload) return '';
  if (typeof payload === 'string') return payload.slice(0, 220);
  if (typeof payload === 'object') {
    if (typeof payload.error === 'string') return payload.error;
    if (typeof payload.message === 'string') return payload.message;
  }
  try {
    return JSON.stringify(payload).slice(0, 220);
  } catch {
    return String(payload).slice(0, 220);
  }
}

async function request(pathname, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const headers = {
    Accept: 'application/json',
    ...(options.headers || {})
  };

  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }

  let body = options.body;
  if (options.jsonBody !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.jsonBody);
  }

  const response = await fetch(buildUrl(pathname), {
    method,
    headers,
    body
  });

  const raw = await response.text();
  let payload = null;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    payload = raw;
  }

  if (!response.ok) {
    const message = summarizePayload(payload) || response.statusText || 'Request failed';
    const error = new Error(`${method} ${pathname} failed (${response.status}): ${message}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
}

async function requestExpectFailure(pathname, options = {}, expectedStatus = 400) {
  try {
    await request(pathname, options);
    throw new Error(
      `Expected ${String(options.method || 'GET').toUpperCase()} ${pathname} to fail with status ${expectedStatus}, but it succeeded.`
    );
  } catch (error) {
    if (error.status === undefined) {
      throw error;
    }
    if (Number(error.status) !== Number(expectedStatus)) {
      throw new Error(
        `Expected ${String(options.method || 'GET').toUpperCase()} ${pathname} to fail with status ${expectedStatus}, but got ${error.status}.`
      );
    }
    return error.payload;
  }
}

async function safeRequest(pathname, options = {}) {
  try {
    await request(pathname, options);
    return true;
  } catch {
    return false;
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function logStep(message) {
  console.log(`• ${message}`);
}

async function run() {
  let adminToken = '';
  let staffToken = '';
  let displayToken = '';
  const createdAnnouncementIds = [];
  let createdCategoryId = '';
  let createdDisplayUserId = '';
  let createdStaffUserId = '';

  const runId = Date.now().toString();
  const displayUsername = `display_smoke_${runId}@noticeboard.com`;
  const displayPassword = `Display!${runId.slice(-6)}`;
  const staffUsername = `staff_smoke_${runId}@noticeboard.com`;
  const staffPassword = `Staff!${runId.slice(-6)}`;
  const categoryName = `SMOKE-${runId}`;

  try {
    logStep(`Checking health endpoint at ${buildUrl('/api/health')}`);
    const health = await request('/api/health');
    assert(health && typeof health === 'object', 'Health endpoint response is invalid.');
    assert(String(health.status || '').length > 0, 'Health status is missing.');

    logStep('Checking API test endpoint');
    const test = await request('/api/test');
    assert(
      String(test?.database || '').toLowerCase().includes('supabase'),
      'API test endpoint does not report Supabase.'
    );

    logStep('Admin login');
    const adminLogin = await request('/api/auth/login', {
      method: 'POST',
      jsonBody: {
        username: ADMIN_USERNAME,
        password: ADMIN_PASSWORD
      }
    });
    adminToken = String(adminLogin?.token || '');
    assert(adminToken, 'Admin token not received.');

    logStep('Creating temporary category');
    const category = await request('/api/categories', {
      method: 'POST',
      token: adminToken,
      jsonBody: { name: categoryName }
    });
    createdCategoryId = String(category?.id || '');
    assert(createdCategoryId, 'Category creation failed.');

    logStep('Creating temporary display access user');
    const displayUser = await request('/api/display-users', {
      method: 'POST',
      token: adminToken,
      jsonBody: {
        username: displayUsername,
        password: displayPassword,
        category: createdCategoryId
      }
    });
    createdDisplayUserId = String(displayUser?.id || '');
    assert(createdDisplayUserId, 'Display user creation failed.');

    logStep('Display login and logout');
    const displayLogin = await request('/api/display-auth/login', {
      method: 'POST',
      jsonBody: {
        username: displayUsername,
        password: displayPassword,
        category: createdCategoryId
      }
    });
    displayToken = String(displayLogin?.token || '');
    assert(displayToken, 'Display login token not received.');
    await request('/api/display-auth/logout', {
      method: 'POST',
      token: displayToken,
      jsonBody: {}
    });

    logStep('Creating temporary staff user');
    const staffUser = await request('/api/staff-users', {
      method: 'POST',
      token: adminToken,
      jsonBody: {
        username: staffUsername,
        password: staffPassword
      }
    });
    createdStaffUserId = String(staffUser?.id || '');
    assert(createdStaffUserId, 'Staff user creation failed.');

    logStep('Staff login and logout');
    const staffLogin = await request('/api/staff-auth/login', {
      method: 'POST',
      jsonBody: {
        username: staffUsername,
        password: staffPassword
      }
    });
    staffToken = String(staffLogin?.token || '');
    assert(staffToken, 'Staff login token not received.');
    await request('/api/staff-auth/logout', {
      method: 'POST',
      token: staffToken,
      jsonBody: {}
    });

    logStep('Checking wrong-portal login handoff responses');
    const adminPortalWithStaff = await requestExpectFailure(
      '/api/auth/login',
      {
        method: 'POST',
        jsonBody: {
          username: staffUsername,
          password: staffPassword
        }
      },
      403
    );
    assert(
      String(adminPortalWithStaff?.accountType || '') === 'staff',
      'Admin login did not return staff accountType handoff.'
    );

    const staffPortalWithAdmin = await requestExpectFailure(
      '/api/staff-auth/login',
      {
        method: 'POST',
        jsonBody: {
          username: ADMIN_USERNAME,
          password: ADMIN_PASSWORD
        }
      },
      403
    );
    assert(
      String(staffPortalWithAdmin?.accountType || '') === 'admin',
      'Staff login did not return admin accountType handoff.'
    );

    const adminPortalWithDisplay = await requestExpectFailure(
      '/api/auth/login',
      {
        method: 'POST',
        jsonBody: {
          username: displayUsername,
          password: displayPassword
        }
      },
      403
    );
    assert(
      String(adminPortalWithDisplay?.accountType || '') === 'display',
      'Admin login did not return display accountType handoff.'
    );

    const startAt = new Date().toISOString();
    const endAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    logStep('Creating text announcement');
    const textAnnouncement = await request('/api/announcements', {
      method: 'POST',
      token: adminToken,
      jsonBody: {
        title: `Smoke Text ${runId}`,
        content: 'Smoke text announcement',
        priority: 1,
        duration: 1,
        active: true,
        category: createdCategoryId,
        startAt,
        endAt
      }
    });
    const textAnnouncementId = String(textAnnouncement?.id || '');
    assert(textAnnouncementId, 'Text announcement creation failed.');
    createdAnnouncementIds.push(textAnnouncementId);

    logStep('Creating document announcement');
    const docForm = new FormData();
    docForm.set('title', `Smoke Doc ${runId}`);
    docForm.set('content', 'Smoke document announcement');
    docForm.set('priority', '1');
    docForm.set('duration', '1');
    docForm.set('active', 'true');
    docForm.set('category', createdCategoryId);
    docForm.set('startAt', startAt);
    docForm.set('endAt', endAt);
    docForm.set('document', new Blob(['smoke document file'], { type: 'text/plain' }), 'smoke.txt');

    const docAnnouncement = await request('/api/announcements', {
      method: 'POST',
      token: adminToken,
      body: docForm
    });
    const docAnnouncementId = String(docAnnouncement?.id || '');
    assert(docAnnouncementId, 'Document announcement creation failed.');
    createdAnnouncementIds.push(docAnnouncementId);
    assert(
      String(docAnnouncement?.type || '').toLowerCase().includes('document'),
      `Document announcement type is incorrect: ${docAnnouncement?.type || 'unknown'}`
    );

    logStep('Updating announcement');
    const updateForm = new FormData();
    updateForm.set('title', `Smoke Text Updated ${runId}`);
    updateForm.set('content', 'Smoke text announcement updated');
    updateForm.set('priority', '0');
    await request(`/api/announcements/${textAnnouncementId}`, {
      method: 'PUT',
      token: adminToken,
      body: updateForm
    });

    logStep('Checking public announcements by category');
    const publicAnnouncements = await request(`/api/announcements/public?category=${createdCategoryId}`);
    assert(Array.isArray(publicAnnouncements), 'Public announcements response is not an array.');
    assert(
      publicAnnouncements.some((item) => item && item.id === textAnnouncementId),
      'Updated announcement not returned in public category feed.'
    );

    logStep('Checking live start/stop controls');
    await request('/api/start', {
      method: 'POST',
      token: adminToken,
      jsonBody: { link: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }
    });
    const liveOn = await request('/api/status');
    assert(String(liveOn?.status || '').toUpperCase() === 'ON', 'Live status did not turn ON.');

    await request('/api/stop', {
      method: 'POST',
      token: adminToken,
      jsonBody: {}
    });
    const liveOff = await request('/api/status');
    assert(String(liveOff?.status || '').toUpperCase() === 'OFF', 'Live status did not turn OFF.');

    logStep('Checking history endpoint action scope');
    const historyRows = await request('/api/history', {
      method: 'GET',
      token: adminToken
    });
    assert(Array.isArray(historyRows), 'History response is not an array.');
    const invalidHistory = historyRows.find(
      (item) => item && !ANNOUNCEMENT_ACTIONS.has(String(item.action || ''))
    );
    if (invalidHistory) {
      throw new Error(
        `History contains non-announcement action: ${String(invalidHistory.action || 'unknown')}`
      );
    }

    logStep('Cleaning temporary resources');
    for (const announcementId of createdAnnouncementIds.reverse()) {
      await safeRequest(`/api/announcements/${announcementId}`, {
        method: 'DELETE',
        token: adminToken
      });
    }
    createdAnnouncementIds.length = 0;

    if (createdDisplayUserId) {
      await safeRequest(`/api/display-users/${createdDisplayUserId}`, {
        method: 'DELETE',
        token: adminToken
      });
      createdDisplayUserId = '';
    }
    if (createdStaffUserId) {
      await safeRequest(`/api/staff-users/${createdStaffUserId}`, {
        method: 'DELETE',
        token: adminToken
      });
      createdStaffUserId = '';
    }
    if (createdCategoryId) {
      await safeRequest(`/api/categories/${createdCategoryId}`, {
        method: 'DELETE',
        token: adminToken
      });
      createdCategoryId = '';
    }

    logStep('Admin logout');
    await request('/api/auth/logout', {
      method: 'POST',
      token: adminToken,
      jsonBody: {}
    });

    console.log('\n✅ Smoke check passed: logins, options, and core dashboard APIs are working.');
  } catch (error) {
    console.error(`\n❌ Smoke check failed: ${error.message}`);

    if (adminToken) {
      for (const announcementId of createdAnnouncementIds.reverse()) {
        await safeRequest(`/api/announcements/${announcementId}`, {
          method: 'DELETE',
          token: adminToken
        });
      }
      if (createdDisplayUserId) {
        await safeRequest(`/api/display-users/${createdDisplayUserId}`, {
          method: 'DELETE',
          token: adminToken
        });
      }
      if (createdStaffUserId) {
        await safeRequest(`/api/staff-users/${createdStaffUserId}`, {
          method: 'DELETE',
          token: adminToken
        });
      }
      if (createdCategoryId) {
        await safeRequest(`/api/categories/${createdCategoryId}`, {
          method: 'DELETE',
          token: adminToken
        });
      }
      await safeRequest('/api/auth/logout', {
        method: 'POST',
        token: adminToken,
        jsonBody: {}
      });
    }

    process.exit(1);
  }
}

run();
