import axios from 'axios';
import { env } from '../config/env.js';
import { getAccessToken } from './authService.js';

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

    // console.log('DAX QUERY:', daxQuery);

    const response = await axios.post(
      `${env.powerBiApiUrl}/v1.0/myorg/datasets/${datasetId}/executeQueries`,
      payload,
      { headers }
    );
    // console.log(
    //   'DAX RESPONSE:',
    //   JSON.stringify(response.data, null, 2)
    // );
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
    // console.log(`[POWERBI SERVICE] Fetching user tables for dataset ${datasetId} via INFO.VIEW.TABLES()...`);
    const response = await executeQuery(datasetId, daxQuery);
    const rows = response?.results?.[0]?.tables?.[0]?.rows || [];
    // console.log('[DEBUG] INFO.VIEW.TABLES() raw rows:', JSON.stringify(rows[0], null, 2));
    if (rows.length === 0) {
      throw new Error("INFO.VIEW.TABLES() returned 0 rows");
    }

    const tableNames = rows
      .map(row => {
        const nameKey = Object.keys(row).find(k =>
          k.toLowerCase().includes('name') && !k.toLowerCase().includes('description')
        );
        // console.log(`[DEBUG] Discovered Table row:`, JSON.stringify(row));
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

/**
 * Extracts Power Query M expressions for all tables in a dataset.
 *
 * Uses the Power BI Admin Workspace Scanning API:
 *   1. POST /admin/workspaces/getInfo?datasetExpressions=true
 *   2. Poll /admin/workspaces/scanStatus/{scanId}
 *   3. GET /admin/workspaces/scanResult/{scanId}
 *
 * This is the only reliable method — TMSCHEMA_PARTITIONS and INFO.VIEW.PARTITIONS()
 * are not supported by the executeQueries REST endpoint.
 *
 * @param {string} workspaceId - Power BI workspace (group) ID
 * @param {string} datasetId   - Power BI dataset ID
 * @returns {Promise<Array<{ tableName: string, mExpression: string }>>}
 */
export async function getPowerQueryExpressions(workspaceId, datasetId) {
  console.log(`[DEBUG] Fetching M expressions for dataset ${datasetId} via Admin Scanning API`);
  const skipPatterns = [
    'LocalDateTable_', 'DateTableTemplate_', 'localdatetable_', 'datetabletemplate_'
  ];
  const shouldSkip = (name) => {
    if (!name) return true;
    if (name.startsWith('_') || name.startsWith('$') || name.startsWith('__')) return true;
    const lower = name.toLowerCase();
    return skipPatterns.some(p => lower.startsWith(p));
  };

  // ── Pre-flight: warn if this looks like My Workspace ────────────────────
  // My Workspace IDs are not UUID format — they're typically the user's own
  // personal workspace. Service principals cannot access My Workspace at all.
  // If workspaceId is missing, that's a sign the caller is passing My Workspace.
  if (!workspaceId) {
    console.warn(
      `[POWERBI SERVICE] getPowerQueryExpressions called with no workspaceId. ` +
      `This likely means the dataset is in "My Workspace" which service principals ` +
      `cannot access via the Admin Scanning API. M expressions will not be available.`
    );
    return [];
  }

  try {
    console.log(`[POWERBI SERVICE] Extracting Power Query M expressions via Admin Scanning API...`);
    console.log(`[POWERBI SERVICE]   Workspace: ${workspaceId}, Dataset: ${datasetId}`);

    const headers = await getAuthHeaders();

    // ── Step 1: Trigger scan ─────────────────────────────────────────────
    const scanUrl = `${env.powerBiApiUrl}/v1.0/myorg/admin/workspaces/getInfo` +
      `?datasetExpressions=true&datasetSchema=true&datasourceDetails=false` +
      `&getArtifactUsers=false&lineage=false`;

    console.log(`[POWERBI SERVICE] Triggering workspace scan for workspace ${workspaceId}...`);
    const scanResponse = await axios.post(
      scanUrl,
      { workspaces: [workspaceId] },
      { headers, timeout: 30000 }
    );
    const scanId = scanResponse.data?.id;

    if (!scanId) {
      console.error(
        `[POWERBI SERVICE] Scan trigger returned no scanId. Full response:`,
        JSON.stringify(scanResponse.data, null, 2)
      );
      return [];
    }
    console.log(`[POWERBI SERVICE] Scan triggered. ID: ${scanId}. Polling...`);

    // ── Step 2: Poll until Succeeded ────────────────────────────────────
    let scanStatus = null;
    for (let attempt = 1; attempt <= 30; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      const statusUrl = `${env.powerBiApiUrl}/v1.0/myorg/admin/workspaces/scanStatus/${scanId}`;
      const statusResponse = await axios.get(statusUrl, { headers, timeout: 15000 });
      scanStatus = statusResponse.data?.status;
      console.log(`[POWERBI SERVICE] Scan poll ${attempt}/30: status = ${scanStatus}`);
      if (scanStatus === 'Succeeded') break;
      if (scanStatus === 'Failed' || scanStatus === 'Error') {
        console.error(`[POWERBI SERVICE] Workspace scan failed: ${scanStatus}`);
        return [];
      }
    }

    if (scanStatus !== 'Succeeded') {
      console.error(`[POWERBI SERVICE] Scan timed out. Last status: ${scanStatus}`);
      return [];
    }

    // ── Step 3: Get result ────────────────────────────────────────────────
    const resultUrl = `${env.powerBiApiUrl}/v1.0/myorg/admin/workspaces/scanResult/${scanId}`;
    const resultResponse = await axios.get(resultUrl, { headers, timeout: 30000 });
    const workspaces = resultResponse.data?.workspaces || [];

    for (const ws of workspaces) {
      const datasets = ws.datasets || [];
      const target = datasets.find(d => d.id?.toLowerCase() === datasetId?.toLowerCase());
      if (target) {
        console.log('[M EXPR DIAGNOSTIC] Full target dataset JSON:');
        console.log(JSON.stringify(target, null, 2));
        break;
      }
    }

    console.log(`[POWERBI SERVICE] Scan result: ${workspaces.length} workspace(s) returned.`);

    // ── DIAGNOSTIC: log full structure of first dataset found ────────────
    // This helps identify the exact field path for expressions on your tenant
    if (workspaces.length > 0) {
      const firstWs = workspaces[0];
      const allDatasets = firstWs.datasets || [];
      console.log(`[POWERBI SERVICE] Workspace '${firstWs.name}' has ${allDatasets.length} dataset(s).`);
      console.log(`[POWERBI SERVICE] Dataset IDs in scan result: ${allDatasets.map(d => d.id).join(', ')}`);

      if (allDatasets.length > 0) {
        const firstDs = allDatasets[0];
        const firstTable = firstDs.tables?.[0];
        console.log(
          `[POWERBI SERVICE] DIAGNOSTIC — First dataset structure sample:\n` +
          JSON.stringify({
            datasetId: firstDs.id,
            datasetName: firstDs.name,
            tableCount: firstDs.tables?.length ?? 0,
            firstTableName: firstTable?.name,
            // Show all keys on the table object so we can see where expressions live
            firstTableKeys: firstTable ? Object.keys(firstTable) : [],
            // Show source shape
            firstTableSource: firstTable?.source,
            // Show partitions shape if present
            firstTablePartitions: firstTable?.partitions?.slice(0, 1),
            // Show measures count
            measureCount: firstDs.measures?.length ?? 0,
            // Show expressions array if present at dataset level
            expressionsCount: firstDs.expressions?.length ?? 0,
            expressionsSample: firstDs.expressions?.slice(0, 2),
          }, null, 2)
        );
      }
    }

    if (workspaces.length === 0) {
      console.warn(`[POWERBI SERVICE] Scan result contains no workspaces.`);
      return [];
    }

    // ── Step 4: Extract expressions ──────────────────────────────────────
    const expressions = [];

    for (const ws of workspaces) {
      const datasets = ws.datasets || [];
      const targetDataset = datasets.find(
        ds => ds.id?.toLowerCase() === datasetId?.toLowerCase()
      );

      if (!targetDataset) {
        console.warn(
          `[POWERBI SERVICE] Dataset ${datasetId} NOT found in scan results for workspace ${ws.name}. ` +
          `Available dataset IDs: ${datasets.map(d => d.id).join(', ')}`
        );
        continue;
      }

      console.log(
        `[POWERBI SERVICE] Found target dataset '${targetDataset.name}' in scan results. ` +
        `Tables: ${targetDataset.tables?.length ?? 0}`
      );

      const tables = targetDataset.tables || [];
      let tablesWithExpression = 0;
      let tablesSkipped = 0;
      let tablesNoExpression = 0;

      for (const table of tables) {
        const tableName = table.name;

        if (shouldSkip(tableName)) {
          tablesSkipped++;
          continue;
        }

        // Try multiple field paths — Power BI API shape varies by tenant/version
        let mExpression = null;

        // Path 1: table.source.expression (most common)
        if (table.source?.expression) {
          const raw = table.source.expression;
          mExpression = Array.isArray(raw) ? raw.join('\n') : String(raw);
        }

        // Path 2: table.source[0].expression (array of source objects)
        if (!mExpression && Array.isArray(table.source) && table.source[0]?.expression) {
          const raw = table.source[0].expression;
          mExpression = Array.isArray(raw) ? raw.join('\n') : String(raw);
        }

        // Path 3: table.partitions[0].source.expression
        if (!mExpression && table.partitions?.[0]?.source?.expression) {
          const raw = table.partitions[0].source.expression;
          mExpression = Array.isArray(raw) ? raw.join('\n') : String(raw);
        }

        // Path 4: table.partitions[0].source[0].expression
        if (!mExpression && Array.isArray(table.partitions?.[0]?.source) && table.partitions[0].source[0]?.expression) {
          const raw = table.partitions[0].source[0].expression;
          mExpression = Array.isArray(raw) ? raw.join('\n') : String(raw);
        }

        if (!mExpression || mExpression.trim().length === 0) {
          tablesNoExpression++;
          console.log(
            `[POWERBI SERVICE] Table '${tableName}' — no expression found. ` +
            `Keys on table object: ${Object.keys(table).join(', ')}`
          );
          continue;
        }

        tablesWithExpression++;
        expressions.push({ tableName: tableName.trim(), mExpression: mExpression.trim() });
        console.log(`[POWERBI SERVICE] ✓ Table '${tableName}' — M expression found (${mExpression.length} chars)`);
      }

      console.log(
        `[POWERBI SERVICE] Expression extraction summary for '${targetDataset.name}': ` +
        `${tablesWithExpression} with expression, ${tablesNoExpression} without, ${tablesSkipped} skipped (system tables)`
      );

      // If no expressions found at table level, check dataset-level expressions array
      const datasetExpressions = targetDataset.expressions || [];
      if (datasetExpressions.length > 0) {
        console.log(`[POWERBI SERVICE] Found ${datasetExpressions.length} dataset-level expression(s).`);
        for (const expr of datasetExpressions) {
          const name = expr.name;
          const raw = expr.expression;
          const mExpression = Array.isArray(raw) ? raw.join('\n') : String(raw || '');
          if (shouldSkip(name) || !mExpression.trim()) continue;
          if (!expressions.find(e => e.tableName === name)) {
            expressions.push({ tableName: name.trim(), mExpression: mExpression.trim() });
            console.log(`[POWERBI SERVICE] ✓ Dataset expression '${name}' (${mExpression.length} chars)`);
          }
        }
      }

      // ── Root cause diagnosis ──────────────────────────────────────────
      if (expressions.length === 0) {
        console.warn(
          `[POWERBI SERVICE] ⚠ ZERO expressions extracted. Possible causes:\n` +
          `  1. Dataset is in "My Workspace" — service principals blocked from expressions.\n` +
          `     Fix: Move dataset to a shared workspace.\n` +
          `  2. Service principal lacks "Tenant Admin" or "Read all tenant metadata" permission.\n` +
          `     Fix: In Azure AD → Enterprise App → API permissions, add "Tenant.Read.All"\n` +
          `     OR in Power BI Admin Portal → Tenant Settings → enable\n` +
          `     "Service principals can access read-only admin APIs".\n` +
          `  3. Dataset uses DirectQuery or Live Connection — no M expressions stored.\n` +
          `     Check: StorageMode in INFO.VIEW.TABLES() — should be "Import".\n` +
          `  4. datasetExpressions=true not supported on this tenant plan.\n` +
          `     Check: Power BI Premium or Premium Per User is required for Admin APIs.`
        );
      }
    }

    console.log(`[POWERBI SERVICE] Total M expressions extracted: ${expressions.length}`);
    return expressions;

  } catch (err) {
    const status = err.response?.status;
    const body = err.response
      ? (err.response.data?.message || JSON.stringify(err.response.data))
      : err.message;

    // Specific error diagnosis
    if (status === 403) {
      console.error(
        `[POWERBI SERVICE] Admin Scanning API returned 403 FORBIDDEN.\n` +
        `Fix: In Power BI Admin Portal → Tenant Settings → enable:\n` +
        `  "Service principals can use read-only Power BI admin APIs"\n` +
        `  "Enhance admin APIs responses with detailed metadata"\n` +
        `  "Enhance admin APIs responses with DAX and mashup expressions"`
      );
    } else if (status === 401) {
      console.error(`[POWERBI SERVICE] Admin Scanning API returned 401 — token invalid or expired.`);
    } else {
      console.error(`[POWERBI SERVICE] Admin Scanning API failed (HTTP ${status || 'N/A'}): ${body}`);
    }

    throw new Error(`Admin Scanning API failed (HTTP ${status || 'N/A'}): ${body}`);
  }
}

/**
 * Fetches DAX measures for a dataset using DMVs.
 * First tries TMSCHEMA_MEASURES, then falls back to MDSCHEMA_MEASURES.
 * Logs measures, expressions, and missing expressions.
 * Returns a normalized structure: [{ name, expression }].
 *
 * @param {string} datasetId - Power BI dataset ID
 * @returns {Promise<Array<{ name: string, expression: string }>>}
 */
export async function getDatasetMeasures(datasetId) {
  console.log(`[POWERBI SERVICE] Querying measures for dataset ${datasetId}...`);
  let measures = [];
  let sourceUsed = '';

  try {
    const query = 'SELECT [NAME], [EXPRESSION] FROM $SYSTEM.TMSCHEMA_MEASURES';
    const response = await executeQuery(datasetId, query);
    const rows = response?.results?.[0]?.tables?.[0]?.rows || [];
    measures = rows.map(r => ({
      name: r.NAME || r['[NAME]'] || '',
      expression: r.EXPRESSION || r['[EXPRESSION]'] || ''
    }));
    sourceUsed = 'TMSCHEMA_MEASURES';
  } catch (tmsErr) {
    console.warn(`[POWERBI SERVICE] TMSCHEMA_MEASURES DMV failed: ${tmsErr.message}. Trying MDSCHEMA_MEASURES fallback...`);
    try {
      const query = 'SELECT [MEASURE_NAME], [EXPRESSION] FROM $SYSTEM.MDSCHEMA_MEASURES';
      const response = await executeQuery(datasetId, query);
      const rows = response?.results?.[0]?.tables?.[0]?.rows || [];
      measures = rows.map(r => ({
        name: r.MEASURE_NAME || r['[MEASURE_NAME]'] || '',
        expression: r.EXPRESSION || r['[EXPRESSION]'] || ''
      }));
      sourceUsed = 'MDSCHEMA_MEASURES';
    } catch (mdsErr) {
      console.error(`[POWERBI SERVICE] Both TMSCHEMA_MEASURES and MDSCHEMA_MEASURES DMVs failed: ${mdsErr.message}`);
      return [];
    }
  }

  // Filter out any measures without a valid name
  measures = measures.filter(m => m.name && m.name.trim() !== '');

  console.log(`[POWERBI SERVICE] Total measures found via ${sourceUsed}: ${measures.length}`);
  let missingExpressionsCount = 0;
  measures.forEach(m => {
    const hasExpr = m.expression && m.expression.trim().length > 0;
    if (!hasExpr) {
      missingExpressionsCount++;
    }
    console.log(`  [MEASURE] Name: ${m.name} | Expression: ${hasExpr ? m.expression : '(missing)'}`);
  });

  if (missingExpressionsCount > 0) {
    console.log(`[POWERBI SERVICE] ${missingExpressionsCount} measure(s) are missing expressions.`);
  }

  return measures;
}