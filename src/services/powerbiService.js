import axios from 'axios';
import { env } from '../config/env.js';
import { getAccessToken } from './authService.js';

/**
 * Executes an HTTP request function with retry logic and exponential backoff.
 * Retries on network errors, rate limiting (429), and server errors (>= 500).
 */
async function requestWithRetry(requestFn, maxRetries = 3) {
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

      // Exponential backoff: 1s, 2s, 4s...
      const backoffDelay = 1000 * Math.pow(2, attempt);
      console.warn(`[POWERBI SERVICE] Request failed (${error.message}). Retrying in ${backoffDelay}ms (Attempt ${attempt}/${maxRetries})...`);
      await new Promise(resolve => setTimeout(resolve, backoffDelay));
    }
  }
}

/**
 * Helper to build common headers.
 */
async function getAuthHeaders() {
  const token = await getAccessToken();
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json'
  };
}

/**
 * Get all workspaces (groups) that the service principal has access to.
 */
export async function getWorkspaces() {
  return requestWithRetry(async () => {
    const headers = await getAuthHeaders();
    const response = await axios.get(`${env.powerBiApiUrl}/v1.0/myorg/groups`, { headers });
    return response.data;
  });
}

/**
 * Get datasets within a specific workspace.
 */
export async function getDatasets(groupId) {
  return requestWithRetry(async () => {
    const headers = await getAuthHeaders();
    const response = await axios.get(`${env.powerBiApiUrl}/v1.0/myorg/groups/${groupId}/datasets`, { headers });
    return response.data;
  });
}

/**
 * Get reports within a specific workspace.
 */
export async function getReports(groupId) {
  return requestWithRetry(async () => {
    const headers = await getAuthHeaders();
    const response = await axios.get(`${env.powerBiApiUrl}/v1.0/myorg/groups/${groupId}/reports`, { headers });
    return response.data;
  });
}

/**
 * Get dashboards within a specific workspace.
 */
export async function getDashboards(groupId) {
  return requestWithRetry(async () => {
    const headers = await getAuthHeaders();
    const response = await axios.get(`${env.powerBiApiUrl}/v1.0/myorg/groups/${groupId}/dashboards`, { headers });
    return response.data;
  });
}

/**
 * Executes DAX queries against a dataset.
 * The body structure required by Power BI is { queries: [{ query: '...' }], serializerSettings: { includeNulls: boolean } }
 */
export async function executeQuery(datasetId, daxQuery, serializerSettings = { includeNulls: true }) {
  return requestWithRetry(async () => {
    const headers = await getAuthHeaders();
    const payload = {
      queries: [
        {
          query: daxQuery || "EVALUATE 'TableName'"
        }
      ],
      serializerSettings: serializerSettings
    };

    const response = await axios.post(
      `${env.powerBiApiUrl}/v1.0/myorg/datasets/${datasetId}/executeQueries`,
      payload,
      { headers }
    );
    return response.data;
  });
}

/**
 * Get tiles within a specific dashboard inside a workspace.
 */
export async function getDashboardTiles(groupId, dashboardId) {
  return requestWithRetry(async () => {
    const headers = await getAuthHeaders();
    const response = await axios.get(
      `${env.powerBiApiUrl}/v1.0/myorg/groups/${groupId}/dashboards/${dashboardId}/tiles`,
      { headers }
    );
    return response.data;
  });
}

/**
 * Discover all tables in the dataset.
 * Uses DMV INFO.VIEW.TABLES() and falls back to SELECT FROM $SYSTEM.DBSCHEMA_TABLES.
 */
export async function getDatasetTables(datasetId) {
  try {
    const daxQuery = "EVALUATE INFO.VIEW.TABLES()";
    console.log(`[POWERBI SERVICE] Fetching user tables for dataset ${datasetId} via INFO.VIEW.TABLES()...`);
    const response = await executeQuery(datasetId, daxQuery);
    const rows = response?.results?.[0]?.tables?.[0]?.rows || [];
    console.log('[DEBUG] INFO.VIEW.TABLES() raw rows:', JSON.stringify(rows[0], null, 2));
    if (rows.length === 0) {
      throw new Error("INFO.VIEW.TABLES() returned 0 rows");
    }

    const tableNames = rows
      .map(row => {
        const nameKey = Object.keys(row).find(k =>
          k.toLowerCase().includes('name') && !k.toLowerCase().includes('description')
        );
        console.log(`[DEBUG] Discovered Table row:`, JSON.stringify(row));
        return nameKey ? String(row[nameKey]) : null;
      })
      .filter(name => {
        if (!name) return false;
        const nameLower = name.toLowerCase();
        if (name.startsWith('_')) return false;
        if (name.includes('LocalDateTable') || name.includes('DateTableTemplate')) return false;
        if (nameLower.startsWith('localdatetable_') || nameLower.startsWith('datetabletemplate_')) return false;
        if (name.startsWith('$') || name.includes('$') || name.startsWith('__')) return false;
        return true;
      });

    return tableNames;
  } catch (error) {
    console.warn(`[POWERBI SERVICE] INFO.VIEW.TABLES() query failed for dataset ${datasetId}: ${error.message}. Trying $SYSTEM.DBSCHEMA_TABLES fallback...`);
    try {
      const discoverQuery = 'SELECT [TABLE_NAME] FROM $SYSTEM.DBSCHEMA_TABLES';
      const discoveryResult = await executeQuery(datasetId, discoverQuery);
      const rows = discoveryResult?.results?.[0]?.tables?.[0]?.rows || [];

      const userTables = rows
        .map(r => r.TABLE_NAME)
        .filter(name => {
          if (!name) return false;
          const nameLower = name.toLowerCase();
          if (name.startsWith('_')) return false;
          if (name.includes('LocalDateTable') || name.includes('DateTableTemplate')) return false;
          if (nameLower.startsWith('localdatetable_') || nameLower.startsWith('datetabletemplate_')) return false;
          if (name.startsWith('$') || name.includes('$') || name.startsWith('__')) return false;
          return true;
        });

      if (userTables.length === 0) {
        throw new Error('No user tables found in dataset.');
      }

      return [userTables[0]];
    } catch (fallbackErr) {
      console.error(`[POWERBI SERVICE] Fallback table discovery failed for dataset ${datasetId}:`, fallbackErr.message);
      return [];
    }
  }
}

/**
 * Fetch columns and rows for a specific table in the dataset.
 */
export async function getTableData(datasetId, tableName) {
  console.log(`[POWERBI SERVICE] Querying data for table '${tableName}' in dataset ${datasetId}...`);
  return await executeQuery(datasetId, `EVALUATE '${tableName}'`);
}

export async function getDatasetRelationships(datasetId) {
  try {
    // Use INFO.VIEW instead of $SYSTEM DMV
    const query = `EVALUATE INFO.VIEW.RELATIONSHIPS()`;
    const result = await executeQuery(datasetId, query);
    const rows = result?.results?.[0]?.tables?.[0]?.rows || [];
    console.log(`[POWERBI SERVICE] Found ${rows.length} relationships for dataset ${datasetId}`);
    return rows;
  } catch (err) {
    console.warn(`[POWERBI SERVICE] INFO.VIEW.RELATIONSHIPS() failed: ${err.message}`);
    return [];
  }
}

export async function getDatasetColumns(datasetId) {
  try {
    const query = `EVALUATE INFO.VIEW.COLUMNS()`;
    const result = await executeQuery(datasetId, query);
    const rows = result?.results?.[0]?.tables?.[0]?.rows || [];
    return rows;
  } catch (err) {
    console.warn(`[POWERBI SERVICE] INFO.VIEW.COLUMNS() failed: ${err.message}`);
    return [];
  }
}

export async function getDatasetTableMeta(datasetId) {
  try {
    const query = `EVALUATE INFO.VIEW.TABLES()`;
    const result = await executeQuery(datasetId, query);
    const rows = result?.results?.[0]?.tables?.[0]?.rows || [];
    return rows;
  } catch (err) {
    console.warn(`[POWERBI SERVICE] INFO.VIEW.TABLES() failed: ${err.message}`);
    return [];
  }
}