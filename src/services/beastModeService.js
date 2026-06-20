/**
 * Beast Mode Service — Domo API Client
 *
 * Creates Beast Mode calculated fields in Domo via the reverse-engineered
 * Function Template API (/api/query/v1/functions/template).
 *
 * Uses the same requestWithRetry and getAuthHeaders patterns as
 * domoDatasetService.js and magicEtlService.js.
 */

import axios from 'axios';
import { sanitizeBeastModeFormula } from './beastModeCompat.js';

// ─── Auth & Retry ──────────────────────────────────────────────────────────────

function getAuthHeaders(token) {
  return {
    'Content-Type': 'application/json',
    'X-DOMO-Developer-Token': token,
  };
}

/**
 * Executes an HTTP request function with retry logic and exponential backoff.
 * Retries on network errors, rate limiting (429), and server errors (>= 500).
 */
async function requestWithRetry(requestFn, maxRetries = 5) {
  let attempt = 0;
  while (true) {
    try {
      return await requestFn();
    } catch (error) {
      attempt++;
      const status = error.response ? error.response.status : null;
      const isRetryable = !status || status === 429 || status >= 500;

      if (attempt > maxRetries || !isRetryable) {
        throw error;
      }

      const backoffDelay = 2000 * Math.pow(2, attempt);
      console.warn(
        `[BEAST MODE SERVICE] Request failed (${error.message}). Retrying in ${backoffDelay}ms (Attempt ${attempt}/${maxRetries})...`
      );
      await new Promise(resolve => setTimeout(resolve, backoffDelay));
    }
  }
}

// ─── Owner ID Resolution ───────────────────────────────────────────────────────

let _cachedOwnerId = null;

/**
 * Fetches the current authenticated user's numeric Domo ID using the developer token.
 * Caches the result for the lifetime of the process so only one API call is made.
 *
 * @param {string} domain - Domo instance domain
 * @param {string} token - Domo developer token
 * @returns {Promise<number>} Numeric Domo user ID
 */
export async function fetchCurrentUserId(domain, token) {
  if (_cachedOwnerId) return _cachedOwnerId;

  const headers = getAuthHeaders(token);

  return requestWithRetry(async () => {
    // Primary: /api/identity/v1/users/me
    try {
      const response = await axios.get(
        `https://${domain}/api/identity/v1/users/me`,
        { headers, timeout: 15000 }
      );
      const userId = response.data?.id || response.data?.userId;
      if (userId) {
        _cachedOwnerId = Number(userId);
        console.log(`[BEAST MODE SERVICE] Resolved owner ID from token: ${_cachedOwnerId}`);
        return _cachedOwnerId;
      }
    } catch (primaryErr) {
      console.warn(`[BEAST MODE SERVICE] /api/identity/v1/users/me failed: ${primaryErr.message}. Trying fallback...`);
    }

    // Fallback: /api/content/v2/users/me
    const fallbackResponse = await axios.get(
      `https://${domain}/api/content/v2/users/me`,
      { headers, timeout: 15000 }
    );
    const userId = fallbackResponse.data?.id || fallbackResponse.data?.userId;
    if (!userId) {
      throw new Error('Could not resolve owner ID from Domo token — no user ID in response');
    }
    _cachedOwnerId = Number(userId);
    console.log(`[BEAST MODE SERVICE] Resolved owner ID from token (fallback): ${_cachedOwnerId}`);
    return _cachedOwnerId;
  });
}

// ─── Payload Builder ───────────────────────────────────────────────────────────

/**
 * Builds a single Function Template payload for Beast Mode creation.
 *
 * @param {object} params
 * @param {string} params.name - Measure/calculation name
 * @param {string} params.expression - Beast Mode formula
 * @param {string} params.dataType - Output type: STRING, DECIMAL, LONG, DATE, DATETIME
 * @param {boolean} params.aggregated - Whether outermost operation is aggregate
 * @param {string[]} params.nonAggregatedColumns - Columns outside aggregates
 * @param {string} params.domoDatasetId - Target Domo dataset ID
 * @param {number} params.ownerId - Numeric Domo user ID
 * @returns {object} The function template payload
 */
function buildFunctionTemplatePayload({ name, expression, dataType, aggregated, nonAggregatedColumns, domoDatasetId, ownerId }) {
  return {
    name,
    owner: ownerId,
    locked: false,
    global: false,
    expression: sanitizeBeastModeFormula(expression),
    checkSum: null,
    links: [
      {
        resource: { type: 'DATA_SOURCE', id: domoDatasetId },
        visible: true,
        active: true,
      },
    ],
    aggregated: aggregated || false,
    analytic: false,
    nonAggregatedColumns: nonAggregatedColumns || [],
    dataType: dataType || 'DECIMAL',
    status: 'VALID',
    cacheWindow: 'non_dynamic',
    columnPositions: [],
    functions: [],
    functionTemplateDependencies: [],
    archived: false,
    hidden: false,
    variable: false,
  };
}

// ─── API Methods ───────────────────────────────────────────────────────────────

/**
 * Creates a single Beast Mode function via the Function Template API.
 *
 * POST https://{domain}/api/query/v1/functions/template?strict=false
 *
 * @param {string} domain - Domo instance domain
 * @param {string} token - Domo developer token
 * @param {number} ownerId - Numeric Domo user ID
 * @param {object} measure - { name, expression, dataType, aggregated, nonAggregatedColumns, domoDatasetId }
 * @returns {Promise<object>} API response data
 */
export async function createBeastModeFunction(domain, token, ownerId, measure) {
  const headers = getAuthHeaders(token);
  const payload = buildFunctionTemplatePayload({ ...measure, ownerId });
  const url = `https://${domain}/api/query/v1/functions/template?strict=false`;

  return requestWithRetry(async () => {
    console.log(`[BEAST MODE SERVICE] Creating single Beast Mode: '${measure.name}' on dataset ${measure.domoDatasetId}`);
    const response = await axios.post(url, payload, { headers, timeout: 30000 });
    console.log(`[BEAST MODE SERVICE] Created Beast Mode '${measure.name}'. ID: ${response.data?.id || 'unknown'}`);
    return response.data;
  });
}

/**
 * Creates multiple Beast Mode functions in a single bulk API call.
 *
 * POST https://{domain}/api/query/v1/functions/bulk/template
 *
 * This is the preferred path for datasets with multiple measures — avoids N
 * sequential round trips. On bulk 400 errors, uses binary search to identify
 * and remove bad formulas, then retries bulk without them.
 *
 * @param {string} domain - Domo instance domain
 * @param {string} token - Domo developer token
 * @param {number} ownerId - Numeric Domo user ID
 * @param {object[]} measures - Array of { name, expression, dataType, aggregated, nonAggregatedColumns, domoDatasetId }
 * @returns {Promise<object>} API response data
 */
export async function createBeastModeFunctionsBulk(domain, token, ownerId, measures) {
  if (!measures || measures.length === 0) {
    console.log('[BEAST MODE SERVICE] No measures to create in bulk — skipping.');
    return { created: [] };
  }

  const headers = getAuthHeaders(token);
  const url = `https://${domain}/api/query/v1/functions/bulk/template`;

  // Attempt 1: Try full bulk
  try {
    const payload = {
      create: measures.map(m => buildFunctionTemplatePayload({ ...m, ownerId })),
      links: {},
      strict: false,
      replaceLinks: true,
      copyDependencies: true,
    };
    console.log(`[BEAST MODE SERVICE] Creating ${measures.length} Beast Mode(s) in bulk for dataset ${measures[0]?.domoDatasetId}...`);
    const response = await axios.post(url, payload, { headers, timeout: 60000 });
    const createdCount = response.data?.created?.length || response.data?.length || measures.length;
    console.log(`[BEAST MODE SERVICE] Bulk creation complete. ${createdCount} Beast Mode(s) created.`);
    return response.data;

  } catch (bulkError) {
    const status = bulkError.response?.status;
    const body = JSON.stringify(bulkError.response?.data || {});
    console.error(`[BEAST MODE SERVICE] Bulk creation failed: HTTP ${status} - ${body}`);

    // Attempt 2: If 400, binary search for bad formula(s), retry bulk without them
    if (status === 400) {
      console.log(`[BEAST MODE SERVICE] Bulk 400 — running binary search to find bad formula(s)...`);
      const badIndexes = await findBadFormulas(domain, token, ownerId, measures, headers, url);

      if (badIndexes.size > 0) {
        const badNames = measures.filter((_, i) => badIndexes.has(i)).map(m => m.name);
        console.warn(`[BEAST MODE SERVICE] Bad formula(s) identified and removed: ${badNames.join(', ')}`);

        const cleanMeasures = measures.filter((_, i) => !badIndexes.has(i));
        if (cleanMeasures.length > 0) {
          try {
            const cleanPayload = {
              create: cleanMeasures.map(m => buildFunctionTemplatePayload({ ...m, ownerId })),
              links: {},
              strict: false,
              replaceLinks: true,
              copyDependencies: true,
            };
            const retryResponse = await axios.post(url, cleanPayload, { headers, timeout: 60000 });
            console.log(`[BEAST MODE SERVICE] Bulk retry succeeded for ${cleanMeasures.length} measures.`);
            return {
              ...retryResponse.data,
              skippedDueToBadFormula: badNames,
            };
          } catch (retryErr) {
            console.error(`[BEAST MODE SERVICE] Bulk retry also failed — falling through to individual creation.`);
          }
        }
      }
    }

    // Attempt 3: Full individual fallback
    const newError = new Error(`Beast Mode bulk creation failed: HTTP ${status} - ${body}`);
    if (bulkError.response) newError.response = bulkError.response;
    throw newError;
  }
}

async function findBadFormulas(domain, token, ownerId, measures, headers, url) {
  const badIndexes = new Set();

  async function testBatch(indexes) {
    if (indexes.length === 0) return;

    if (indexes.length === 1) {
      const measure = measures[indexes[0]];
      try {
        const payload = {
          create: [buildFunctionTemplatePayload({ ...measure, ownerId })],
          links: {},
          strict: false,
          replaceLinks: true,
          copyDependencies: true,
        };
        await axios.post(url, payload, { headers, timeout: 15000 });
      } catch (err) {
        if (err.response?.status === 400) {
          badIndexes.add(indexes[0]);
          console.warn(`[BEAST MODE] Bad formula found: '${measure.name}'`);
          console.warn(`[BEAST MODE] Bad formula content: ${measure.expression}`);
        }
      }
      return;
    }

    try {
      const batch = indexes.map(i => measures[i]);
      const payload = {
        create: batch.map(m => buildFunctionTemplatePayload({ ...m, ownerId })),
        links: {},
        strict: false,
        replaceLinks: true,
        copyDependencies: true,
      };
      await axios.post(url, payload, { headers, timeout: 30000 });
      // Entire batch passed — no bad formulas here
    } catch (err) {
      if (err.response?.status === 400) {
        const mid = Math.floor(indexes.length / 2);
        await testBatch(indexes.slice(0, mid));
        await testBatch(indexes.slice(mid));
      }
    }
  }

  await testBatch(measures.map((_, i) => i));
  return badIndexes;
}

/**
 * Extracts individual Beast Mode IDs from a bulk create response.
 * The response shape may vary — this handles known variations.
 *
 * @param {object} bulkResponse - Response from createBeastModeFunctionsBulk
 * @param {string[]} measureNames - Ordered measure names (same order as the create call)
 * @returns {Map<string, string>} Map of measureName → domoFunctionId
 */
export function extractBulkCreatedIds(bulkResponse, measureNames) {
  const idMap = new Map();

  // Response may be: { created: [{ id, name, ... }] } or an array directly
  const items = bulkResponse?.created || (Array.isArray(bulkResponse) ? bulkResponse : []);

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const id = item?.id || item?.functionTemplateId || null;
    const name = item?.name || (i < measureNames.length ? measureNames[i] : `measure_${i}`);
    if (id) {
      idMap.set(name, String(id));
    }
  }

  // Fallback: if no items but we know the call succeeded, map names with null IDs
  if (idMap.size === 0 && measureNames.length > 0) {
    for (const name of measureNames) {
      idMap.set(name, null);
    }
  }

  return idMap;
}
