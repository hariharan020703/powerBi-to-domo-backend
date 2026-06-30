import axios from 'axios';
import { getAutomatedDomoCookie, resetDomoCookieCache, getCachedCsrfToken, getCachedRequestContext } from './domoCookieService.js';

const API_TIMEOUT_MS = 30_000;
const OAUTH_TIMEOUT_MS = 20_000;

let _cachedToken = null;
let _tokenExpiresAt = 0;

async function requestWithRetry(requestFn, maxRetries = 3) {
  let attempt = 0;
  while (true) {
    try {
      return await requestFn();
    } catch (error) {
      attempt++;
      const status = error.response ? error.response.status : null;
      const isRetryable = !status || status === 429 || status >= 500;
      if (attempt > maxRetries || !isRetryable) throw error;
      const backoffDelay = 2000 * Math.pow(2, attempt - 1);
      console.warn(`[CARD SERVICE] Request failed (${error.message}). Retrying in ${backoffDelay}ms (Attempt ${attempt}/${maxRetries})...`);
      await new Promise(resolve => setTimeout(resolve, backoffDelay));
    }
  }
}

async function fetchOAuthToken() {
  const now = Date.now();
  if (_cachedToken && now < _tokenExpiresAt) {
    console.log('[CARD SERVICE] Using cached OAuth access token.');
    return _cachedToken;
  }

  const clientId = (process.env.DOMO_CLIENT_ID || '').trim();
  const clientSecret = (process.env.DOMO_CLIENT_SECRET || '').trim();

  if (!clientId || !clientSecret) {
    console.warn('[CARD SERVICE] DOMO_CLIENT_ID / DOMO_CLIENT_SECRET not set.');
    return null;
  }

  console.log('[CARD SERVICE] Fetching OAuth access token using client credentials...');
  try {
    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const tokenRes = await axios.get(
      'https://api.domo.com/oauth/token?grant_type=client_credentials&scope=data%20dashboard%20user',
      {
        headers: { Authorization: `Basic ${basicAuth}` },
        timeout: OAUTH_TIMEOUT_MS,
      }
    );
    if (tokenRes.data?.access_token) {
      _cachedToken = tokenRes.data.access_token;
      _tokenExpiresAt = now + 55 * 60 * 1000; // cache 55 min (token lasts 60)
      console.log('[CARD SERVICE] Successfully obtained OAuth access token.');
      return _cachedToken;
    }
    console.warn('[CARD SERVICE] OAuth response missing access_token field.');
    return null;
  } catch (err) {
    console.error('[CARD SERVICE] Failed to fetch OAuth access token:', err.message);
    return null;
  }
}

function buildCardBody({ cardName, domoDatasetId, columns, beastModeIds }) {
  const cols = columns || [];

  const isNumericType = (t) =>
    ['LONG', 'DOUBLE', 'DECIMAL', 'INTEGER', 'NUMERIC'].includes((t || '').toUpperCase());
  const isDateType = (t) =>
    ['DATE', 'DATETIME'].includes((t || '').toUpperCase());
  const isStringType = (t) =>
    !isNumericType(t) && !isDateType(t);

  // ── Pick category column: prefer STRING, fallback to DATE/DATETIME ─────────
  const categoryCol =
    cols.find(c => isStringType(c.type)) ||
    cols.find(c => isDateType(c.type)) ||
    cols[0] ||
    { name: 'id', type: 'STRING' };

  // ── Pick measure column: first numeric column that isn't the category ──────
  const measureCol = cols.find(c => isNumericType(c.type) && c.name !== categoryCol.name);

  // ── Build the measure subscription column ───────────────────────────────────
  let measureColumnDef;
  if (measureCol) {
    measureColumnDef = {
      column: measureCol.name,
      mapping: 'VALUE',
      aggregation: 'SUM',
    };
  } else {
    // No numeric column available — fall back to counting rows via the category column
    measureColumnDef = {
      column: categoryCol.name,
      mapping: 'VALUE',
      aggregation: 'COUNT',
    };
  }

  const categoryColumnDef = {
    column: categoryCol.name,
    mapping: 'ITEM',
    ...(isDateType(categoryCol.type) ? { calendar: true } : {}),
  };

  // ── Append beast mode calculated fields as additional measures ─────────────
  const beastModeColumns = (beastModeIds || [])
    .filter(Boolean)
    .map(id => ({
      column: id.startsWith('calculation_') ? id : `calculation_${id}`,
      mapping: 'VALUE',
      aggregation: 'SUM',
    }));

  const allColumns = [categoryColumnDef, measureColumnDef, ...beastModeColumns];

  const subscriptionBody = {
    name: 'main',
    columns: allColumns,
    filters: [],
    orderBy: [],
    groupBy: [{ column: categoryCol.name, ...(isDateType(categoryCol.type) ? { calendar: true } : {}) }],
    fiscal: false,
    projection: false,
    distinct: false,
  };

  // dateGrain is required when the category column is a date for proper bucketing
  if (isDateType(categoryCol.type)) {
    subscriptionBody.dateGrain = { column: categoryCol.name, dateTimeElement: 'DAY' };
  }

  return {
    definition: {
      subscriptions: {
        main: subscriptionBody,
      },
      formulas: { dsUpdated: [], dsDeleted: [], card: [] },
      annotations: { new: [], modified: [], deleted: [] },
      conditionalFormats: { card: [], datasource: [] },
      controls: [],
      segments: { active: [], create: [], update: [], delete: [] },
      charts: {
        main: {
          component: 'main',
          chartType: 'badge_vert_stackedbar',
          overrides: {},
          goal: null,
        },
      },
      dynamicTitle: {
        text: [{ text: cardName, type: 'TEXT' }],
      },
      dynamicDescription: {
        text: [],
        displayOnCardDetails: true,
      },
      chartVersion: '12',
      inputTable: false,
      title: cardName,
      description: 'Migrated from Power BI',
    },
    dataProvider: {
      dataSourceId: domoDatasetId,
    },
    variables: true,
  };
}

export async function createDomoCard(domain, token, { cardName, domoDatasetId, columns, beastModeIds, ownerId }) {
  const cookie = await getAutomatedDomoCookie();

  if (!cookie) {
    const msg = '[CARD SERVICE] Could not obtain Domo session cookie automatically.';
    console.error(msg);
    return { cardId: null, cardUrl: null, error: msg };
  }

  const csrfToken = getCachedCsrfToken();
  const requestContext = getCachedRequestContext();

  if (!csrfToken || !requestContext) {
    const msg = '[CARD SERVICE] Missing csrf-token or request-context — cannot create card.';
    console.error(msg);
    return { cardId: null, cardUrl: null, error: msg };
  }

  const cardBody = buildCardBody({ cardName, domoDatasetId, columns, beastModeIds });

  const headers = {
    'Content-Type': 'application/json',
    'Cookie': cookie,
    'x-csrf-token': csrfToken,
    'x-domo-requestcontext': requestContext,
  };

  const url = `https://${domain}/api/content/v3/cards/kpi`;
  console.log(`[CARD SERVICE] Creating card "${cardName}" via v3 instance API`);

  try {
    const response = await requestWithRetry(() =>
      axios.put(url, cardBody, { headers, timeout: API_TIMEOUT_MS })
    );

    const data = response.data;
    console.log(`[CARD SERVICE] Raw response: ${JSON.stringify(data)?.slice(0, 300)}`);
    const cardId = data?.id || data?.urn;

    if (!cardId) {
      const msg = `No card ID in response: ${JSON.stringify(data)?.slice(0, 300)}`;
      console.error(`[CARD SERVICE] ${msg}`);
      return { cardId: null, cardUrl: null, error: msg };
    }

    const cardUrl = `https://${domain}/cards/${cardId}`;
    console.log(`[CARD SERVICE] Success: Created card at ${cardUrl}`);
    return { cardId, cardUrl, error: null };

  } catch (err) {
    const status = err.response?.status;
    const detail = JSON.stringify(err.response?.data ?? err.message);
    console.error(`[CARD SERVICE] Card creation failed (HTTP ${status ?? 'N/A'}): ${detail}`);

    if (status === 401 || status === 403) {
      console.error('[CARD SERVICE] Cookie/csrf likely expired. Will re-login on next attempt.');
      resetDomoCookieCache();
    }

    return { cardId: null, cardUrl: null, error: `Card creation failed: HTTP ${status ?? 'N/A'} — ${detail}` };
  }
}


export async function createDomoPage(domain, token, { pageName, ownerId }) {
  const headers = {
    'Content-Type': 'application/json',
    'X-DOMO-DEVELOPER-TOKEN': token,
  };
  const payload = {
    title: pageName,
    type: 'page',
    visibility: { userIds: [], groupIds: [] },
    ...(ownerId != null ? { ownerId } : {}),
  };

  console.log(`[CARD SERVICE] Creating page "${pageName}"...`);
  return requestWithRetry(async () => {
    try {
      const response = await axios.post(
        `https://${domain}/api/content/v1/pages`,
        payload,
        { headers, timeout: API_TIMEOUT_MS }
      );
      const pageId = response.data?.id || response.data?.pageId;
      const pageUrl = `https://${domain}/page/${pageId}`;
      console.log(`[CARD SERVICE] Success: Created dashboard page at ${pageUrl}`);
      return { pageId, pageUrl };
    } catch (err) {
      const status = err.response?.status;
      if (status === 401 || status === 403) {
        console.error(`[CARD SERVICE] Auth error (HTTP ${status}): insufficient permissions for page creation.`);
      }
      throw err;
    }
  }).catch(err => {
    console.error(`[CARD SERVICE] Failed to create page: ${err.message}`);
    return { pageId: null, pageUrl: null, error: err.message };
  });
}

export async function addCardsToPage(domain, token, pageId, cardIds) {
  const validCardIds = (cardIds || []).filter(id => id && !String(id).startsWith('failed-'));
  if (validCardIds.length === 0) {
    console.warn(`[CARD SERVICE] addCardsToPage: no valid card IDs to add to page ${pageId}. Skipping.`);
    return false;
  }

  const cookie = await getAutomatedDomoCookie();
  const csrfToken = getCachedCsrfToken();
  const requestContext = getCachedRequestContext();

  if (!cookie || !csrfToken) {
    console.error('[CARD SERVICE] addCardsToPage: missing auth session.');
    return false;
  }

  const headers = {
    'Content-Type': 'application/json',
    'Cookie': cookie,
    'x-csrf-token': csrfToken,
    'x-domo-requestcontext': requestContext,
  };

  console.log(`[CARD SERVICE] Adding ${validCardIds.length} card(s) to page ${pageId}...`);

  let allSucceeded = true;
  for (const cardId of validCardIds) {
    try {
      const url = `https://${domain}/api/content/v1/cards/${cardId}/pages`;
      const response = await requestWithRetry(() =>
        axios.put(url, [Number(pageId)], { headers, timeout: API_TIMEOUT_MS })
      );
      console.log(`[CARD SERVICE] Card ${cardId} → page ${pageId}: HTTP ${response.status}`);
    } catch (err) {
      const status = err.response?.status;
      const detail = JSON.stringify(err.response?.data ?? err.message);
      console.error(`[CARD SERVICE] Failed to add card ${cardId} to page ${pageId}. status: ${status}. details: ${detail}`);
      allSucceeded = false;
    }
  }

  if (allSucceeded) {
    console.log(`[CARD SERVICE] Success: Added all cards to page ${pageId}`);
  }
  return allSucceeded;
}

export async function getCardDetails(domain, token, cardId) {
  const headers = {
    'Content-Type': 'application/json',
    'X-DOMO-DEVELOPER-TOKEN': token,
  };
  console.log(`[CARD SERVICE] Getting details for card ${cardId}...`);
  return requestWithRetry(async () => {
    const response = await axios.get(
      `https://${domain}/api/content/v1/cards/${cardId}`,
      { headers, timeout: API_TIMEOUT_MS }
    );
    return response.data;
  });
}

export async function debugCardCreation(domain, token, datasetId) {
  const accessToken = await fetchOAuthToken();
  if (!accessToken) return { error: 'No OAuth token available' };

  const oauthHeaders = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${accessToken}`,
  };

  const results = {};

  // ── Probe 1: List existing cards from public API to see the structure ──────
  try {
    const listRes = await axios.get('https://api.domo.com/v1/cards?limit=5', {
      headers: oauthHeaders, timeout: 15000, validateStatus: () => true,
    });
    results.publicCardList = {
      status: listRes.status,
      fullResponse: JSON.stringify(listRes.data),
    };
    console.log('[DEBUG] Public API cards list: HTTP', listRes.status);
    console.log('[DEBUG] FULL response:', JSON.stringify(listRes.data));
  } catch (e) {
    results.publicCardListError = e.message;
  }

  // ── Probe 1b: Try metadata endpoint for chart types ────────────────────────
  try {
    const metaRes = await axios.get('https://api.domo.com/v1/cards/charttype', {
      headers: oauthHeaders, timeout: 10000, validateStatus: () => true,
    }).catch(() => null);
    if (metaRes) {
      console.log('[DEBUG] charttype endpoint: HTTP', metaRes.status, JSON.stringify(metaRes.data)?.slice(0, 500));
    }
  } catch (e) { }

  // ── Probe 1c: Fetch ONE specific existing card's full structure (not list) ──
  try {
    const oneCardRes = await axios.get('https://api.domo.com/v1/cards/485997809', {
      headers: oauthHeaders, timeout: 10000, validateStatus: () => true,
    });
    console.log('[DEBUG] Single card fetch: HTTP', oneCardRes.status);
    console.log('[DEBUG] Single card FULL response:', JSON.stringify(oneCardRes.data));
    results.singleCard = { status: oneCardRes.status, data: oneCardRes.data };
  } catch (e) {
    results.singleCardError = e.message;
  }

  // ── Probe 2: Try different body formats on POST /v1/cards/chart ───────────
  const chartUrl = 'https://api.domo.com/v1/cards/chart';

  const attempts = [
    // Try A: Uppercase TABLE
    {
      name: 'uppercase_TABLE',
      body: {
        name: 'Debug API Card TABLE',
        description: 'Created via API',
        dataSetId: datasetId,
        chartType: 'TABLE',
      },
    },
    // Try B: Uppercase BASIC_TABLE
    {
      name: 'uppercase_BASIC_TABLE',
      body: {
        name: 'Debug API Card BASIC_TABLE',
        description: 'Created via API',
        dataSetId: datasetId,
        chartType: 'BASIC_TABLE',
      },
    },
    // Try C: Uppercase BADGE_BASIC_TABLE
    {
      name: 'uppercase_BADGE_BASIC_TABLE',
      body: {
        name: 'Debug API Card BADGE_BASIC_TABLE',
        description: 'Created via API',
        dataSetId: datasetId,
        chartType: 'BADGE_BASIC_TABLE',
      },
    },
    // Try D: Uppercase BADGE_TABLE
    {
      name: 'uppercase_BADGE_TABLE',
      body: {
        name: 'Debug API Card BADGE_TABLE',
        description: 'Created via API',
        dataSetId: datasetId,
        chartType: 'BADGE_TABLE',
      },
    },
    // Try E: doc_format_name but with different uppercase chartType values
    {
      name: 'uppercase_BAR',
      body: {
        name: 'Debug API Card BAR',
        description: 'Created via API',
        dataSetId: datasetId,
        chartType: 'BAR',
      },
    },
  ];

  results.chartApiAttempts = [];
  for (const attempt of attempts) {
    try {
      console.log(`[DEBUG] ${attempt.name}: POST ${chartUrl}`);
      console.log(`[DEBUG] Body: ${JSON.stringify(attempt.body).slice(0, 300)}`);
      const res = await axios.post(chartUrl, attempt.body, {
        headers: oauthHeaders, timeout: 15000, validateStatus: () => true,
      });
      const entry = {
        name: attempt.name,
        status: res.status,
        response: JSON.stringify(res.data)?.slice(0, 500),
      };
      results.chartApiAttempts.push(entry);
      console.log(`[DEBUG] ${attempt.name}: HTTP ${res.status} → ${entry.response?.slice(0, 300)}`);

      if (res.status >= 200 && res.status < 300) {
        console.log(`[DEBUG] ✅ SUCCESS with "${attempt.name}"!`);
        break;
      }
    } catch (e) {
      results.chartApiAttempts.push({ name: attempt.name, error: e.message });
    }
  }

  // ── Probe 3: Also try POST /v1/cards (not /chart) ─────────────────────────
  try {
    const body = {
      name: 'Debug Card v1',
      description: 'test',
      dataSetId: datasetId,
      chartType: 'table',
    };
    console.log('[DEBUG] Trying POST /v1/cards (not /chart)');
    const res = await axios.post('https://api.domo.com/v1/cards', body, {
      headers: oauthHeaders, timeout: 15000, validateStatus: () => true,
    });
    results.cardsEndpoint = {
      status: res.status,
      response: JSON.stringify(res.data)?.slice(0, 500),
    };
    console.log(`[DEBUG] POST /v1/cards: HTTP ${res.status} → ${JSON.stringify(res.data)?.slice(0, 300)}`);
  } catch (e) {
    results.cardsEndpoint = { error: e.message };
  }

  return results;
}
