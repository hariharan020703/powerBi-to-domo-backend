import axios from 'axios';

/**
 * Cleans a raw PowerBI column name like "[TableName].[ColumnName]" or "TableName[ColumnName]"
 * into a plain "ColumnName" string safe for CSV headers.
 */
function cleanColumnName(rawName) {
  let name = String(rawName || '').trim();
  const bracketMatch = name.match(/\[([^\]]+)\]$/);
  if (bracketMatch) {
    return bracketMatch[1];
  }
  const dotParts = name.split('.');
  if (dotParts.length > 1) {
    return dotParts[dotParts.length - 1].replace(/[\[\]']/g, '');
  }
  return name.replace(/[\[\]']/g, '');
}

/**
 * Map PowerBI types to Domo types:
 * Int64/Double/Decimal -> DECIMAL
 * DateTime -> DATETIME
 * Boolean -> STRING
 * everything else -> STRING
 */
function mapType(type) {
  const t = String(type || '').toLowerCase();
  if (t === 'int64' || t === 'double' || t === 'decimal' || t === 'long') {
    return 'DECIMAL';
  }
  if (t === 'datetime' || t === 'date') {
    return 'DATETIME';
  }
  if (t === 'boolean') {
    return 'STRING';
  }
  return 'STRING';
}

function getHeaders(token) {
  return {
    'Content-Type': 'application/json;charset=utf-8',
    Accept: 'application/json, text/plain, */*',
    'X-DOMO-DEVELOPER-TOKEN': token,
    'x-requested-with': 'XMLHttpRequest',
  };
}

/**
 * Validates that required Domo environment variables are set.
 * Throws if any are missing.
 */
function validateDomoEnv() {
  const missing = ['DOMO_CLIENT_DOMAIN', 'DOMO_CLIENT_TOKEN'].filter(
    k => !process.env[k]?.trim()
  );
  if (missing.length > 0) {
    throw new Error(`Missing required Domo environment variables: ${missing.join(', ')}`);
  }
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

      // Exponential backoff: 2s, 4s, 8s...
      const backoffDelay = 2000 * Math.pow(2, attempt);
      console.warn(`[DOMO SERVICE] Request failed (${error.message}). Retrying in ${backoffDelay}ms (Attempt ${attempt}/${maxRetries})...`);
      await new Promise(resolve => setTimeout(resolve, backoffDelay));
    }
  }
}

/**
 * Calls POST to https://{DOMO_CLIENT_DOMAIN}/api/data/v3/datasources with v2 fallback.
 * Body contains: { name: tableName, schema: { columns } }
 */
export async function createDomoDataset(tableName, columns) {
  validateDomoEnv();
  const domain = (process.env.DOMO_CLIENT_DOMAIN || '').trim();
  const token = (process.env.DOMO_CLIENT_TOKEN || '').trim();

  const headers = getHeaders(token);

  const createPayload = {
    name: tableName,
    dataSourceName: tableName,
    datasourceName: tableName,
    displayName: tableName,
    dataProviderType: 'api',
    schema: {
      columns: columns.map(c => ({
        name: c.name,
        type: mapType(c.type)
      }))
    }
  };

  return requestWithRetry(async () => {
    try {
      let response = await axios.post(
        `https://${domain}/api/data/v3/datasources`,
        createPayload,
        { headers, timeout: 90000 }
      );
      const datasetId = response.data?.dataSource?.dataSourceId || response.data?.dataSourceId || response.data?.id;
      if (!datasetId) {
        throw new Error(`Domo creation response did not contain dataset ID. Response: ${JSON.stringify(response.data)}`);
      }
      return datasetId;
    } catch (v3Err) {
      // Fallback to v2 if v3 returns 405 or 404
      const status = v3Err.response ? v3Err.response.status : null;
      if (status === 405 || status === 404) {
        let response = await axios.post(
          `https://${domain}/api/data/v2/datasources`,
          createPayload,
          { headers, timeout: 90000 }
        );
        const datasetId = response.data?.dataSource?.dataSourceId || response.data?.dataSourceId || response.data?.id;
        if (!datasetId) {
          throw new Error(`Domo creation response did not contain dataset ID. Response: ${JSON.stringify(response.data)}`);
        }
        return datasetId;
      } else {
        throw v3Err;
      }
    }
  });
}

async function pollUntilReady(domain, authHeaders, domoDatasetId, maxAttempts = 30, intervalMs = 2000) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await axios.get(
        `https://${domain}/api/data/v3/datasources/${domoDatasetId}`,
        { headers: authHeaders, timeout: 15000 }
      );
      const status = res.data?.dataSourceStatus || res.data?.status || '';
      const rowCount = res.data?.rowCount ?? -1;

      console.log(`[POLL] Attempt ${i + 1}: status=${status}, rowCount=${rowCount}`);

      if (status === 'READY' || rowCount >= 0) return res;
    } catch (pollErr) {
      console.warn(`[POLL WARNING] Attempt ${i + 1} failed: ${pollErr.message}`);
    }

    await new Promise(r => setTimeout(r, intervalMs)); // only waits if not ready
  }
  throw new Error(`Dataset ${domoDatasetId} did not become ready after ${maxAttempts} attempts.`);
}

/**
 * Converts the rows array into CSV format, then calls POST to
 * https://{DOMO_CLIENT_DOMAIN}/api/data/v3/datasources/{domoDatasetId}/data/import
 */
export async function uploadDataToDomoDataset(domoDatasetId, columns, rows) {
  validateDomoEnv();
  const domain = (process.env.DOMO_CLIENT_DOMAIN || '').trim();
  const token = (process.env.DOMO_CLIENT_TOKEN || '').trim();

  const escape = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  const header = columns.map(c => escape(c.name)).join(',');
  const dataLines = rows.map(row => {
    if (Array.isArray(row)) {
      return row.map(escape).join(',');
    }
    return columns.map(col => {
      const rawKey = Object.keys(row).find(k => cleanColumnName(k) === col.name);
      const val = rawKey !== undefined ? row[rawKey] : '';
      return escape(val);
    }).join(',');
  });

  const csvString = [header, ...dataLines].join('\n');
  const authHeaders = { 'X-DOMO-DEVELOPER-TOKEN': token };

  return requestWithRetry(async () => {
    // STEP 1: Create upload session (no body needed)
    const sessionRes = await axios.post(
      `https://${domain}/api/data/v3/datasources/${domoDatasetId}/uploads`,
      {},
      { headers: { ...authHeaders, 'Content-Type': 'application/json' }, timeout: 30000 }
    );

    const uploadId = sessionRes.data?.uploadId;
    if (!uploadId) {
      throw new Error(`No uploadId returned. Response: ${JSON.stringify(sessionRes.data)}`);
    }

    // STEP 2: Upload CSV as a raw part (this is where the actual data goes)
    await axios.put(
      `https://${domain}/api/data/v3/datasources/${domoDatasetId}/uploads/${uploadId}/parts/1`,
      csvString,
      {
        headers: {
          ...authHeaders,
          'Content-Type': 'text/csv',
        },
        timeout: 300000,
        maxBodyLength: Infinity,
        maxContentLength: Infinity
      }
    );

    // STEP 3: Commit the upload session
    await axios.put(
      `https://${domain}/api/data/v3/datasources/${domoDatasetId}/uploads/${uploadId}/commit`,
      { index: true },
      { headers: { ...authHeaders, 'Content-Type': 'application/json' }, timeout: 60000 }
    );

    // STEP 4: Verify
    await pollUntilReady(domain, authHeaders, domoDatasetId);

    return true;
  });
}
