import axios from 'axios';

function getAuthHeaders(token) {
  return {
    'Content-Type': 'application/json',
    'X-DOMO-DEVELOPER-TOKEN': token,
  };
}

/**
 * Resolves raw relationship rows into human-readable join definitions
 * using table and column metadata.
 *
 * Returns array of:
 * { fromTable, fromColumn, toTable, toColumn, isActive, crossFilter }
 */
export function resolveRelationships(relationships) {
  // INFO.VIEW.RELATIONSHIPS() already has names directly — no ID lookup needed
  const resolved = [];

  for (const rel of relationships) {
    const fromTable = rel['[FromTable]'] ?? rel.FromTable;
    const toTable = rel['[ToTable]'] ?? rel.ToTable;
    const fromColumn = rel['[FromColumn]'] ?? rel.FromColumn;
    const toColumn = rel['[ToColumn]'] ?? rel.ToColumn;
    const isActive = rel['[IsActive]'] ?? rel.IsActive;
    const crossFilter = rel['[CrossFilteringBehavior]'] ?? rel.CrossFilteringBehavior;

    // Skip LocalDateTable and DateTableTemplate — internal Power BI tables
    const skipPatterns = [
      'LocalDateTable_',
      'DateTableTemplate_',
      'LocalDateTable ',
    ];
    const shouldSkip = (name) =>
      !name || skipPatterns.some(p => name.startsWith(p));

    if (shouldSkip(fromTable) || shouldSkip(toTable)) {
      console.log(`[DATAFLOW] Skipping internal table relationship: ${fromTable} -> ${toTable}`);
      continue;
    }

    if (!fromTable || !toTable || !fromColumn || !toColumn) {
      console.warn(`[DATAFLOW] Missing fields in relationship row:`, JSON.stringify(rel));
      continue;
    }

    resolved.push({
      fromTable: fromTable.trim(),
      fromColumn: fromColumn.trim(),
      toTable: toTable.trim(),
      toColumn: toColumn.trim(),
      isActive,
      crossFilter,
      fromCardinality: rel['[FromCardinality]'] ?? rel.FromCardinality ?? 'Many',
    });
  }

  console.log(`[DATAFLOW] Resolved ${resolved.length}/${relationships.length} relationships`);
  return resolved;
}

export async function fetchDomoDatasetSchema(domain, token, datasetId) {
  try {
    const headers = getAuthHeaders(token);
    const url = `https://${domain}/api/query/v1/datasources/${datasetId}/schema/indexed?includeHidden=false`;
    console.log(`[DATA MODEL] Fetching schema: ${url}`);
    const response = await axios.get(url, { headers, timeout: 30000 });
    const columns = response.data?.tables?.[0]?.columns || [];
    console.log(`[DATA MODEL] Schema fetched for ${datasetId}: ${columns.length} columns`);
    return columns;
  } catch (err) {
    console.error(`[DATA MODEL] Schema fetch FAILED for ${datasetId}: HTTP ${err.response?.status} - ${err.message}`);
    return null;
  }
}

/**
 * Creates a Domo Data Model by defining relationships between datasets.
 * This mirrors Power BI's Model View — linking datasets via join columns.
 */
export async function createDomoDataModel(modelName, resolvedRels, tableToDatasetId, tableToColumns = {}) {
  const domain = (process.env.DOMO_CLIENT_DOMAIN || '').trim();
  const token = (process.env.DOMO_CLIENT_TOKEN || '').trim();

  if (!domain || !token) {
    throw new Error('Domo domain or developer token environment variables are not set.');
  }

  const headers = getAuthHeaders(token);

  const validRels = resolvedRels.filter(r =>
    tableToDatasetId[r.fromTable] && tableToDatasetId[r.toTable]
  );

  if (validRels.length === 0) {
    throw new Error('No valid relationships found between migrated Domo datasets.');
  }

  // Deduplicate bidirectional pairs — keep only one direction
  const seen = new Set();
  const dedupedRels = validRels.filter(r => {
    const key1 = `${r.fromTable}||${r.toTable}`;
    const key2 = `${r.toTable}||${r.fromTable}`;
    if (seen.has(key1) || seen.has(key2)) return false;
    seen.add(key1);
    return true;
  });

  // Collect unique tables
  const involvedTables = new Set();
  for (const r of dedupedRels) {
    involvedTables.add(r.fromTable);
    involvedTables.add(r.toTable);
  }

  // Build objects — exact structure from Postman response
  const objects = {};
  for (const tableName of involvedTables) {
    const datasetId = tableToDatasetId[tableName];
    if (datasetId) {
      objects[tableName] = {
        type: 'DATASET',
        datasource: datasetId,
        include: [],
        exclude: [],
      };
    }
  }

  // Build relationships — exact structure from Postman response
  const relationships = dedupedRels.map((r, i) => ({
    left: r.fromTable,
    right: r.toTable,
    cardinality: r.fromCardinality === 'One' ? 'one_to_many' : 'many_to_one',
    leftKeys: [{ '@type': 'COLUMN', v: 1, columnName: r.fromColumn }],
    rightKeys: [{ '@type': 'COLUMN', v: 1, columnName: r.toColumn }],
    joinType: r.crossFilter === 'BothDirections' ? 'LEFT' : 'INNER',
    primary: i === 0,   // only first is primary
  }));

  // In createDomoDataModel, replace the tableSchemas loop:
  console.log(`[DATA MODEL] Fetching schemas for ${involvedTables.size} datasets...`);
  const tableSchemas = [];

  for (const tableName of involvedTables) {
    const datasetId = tableToDatasetId[tableName];
    if (!datasetId) {
      console.error(`[DATA MODEL] SKIP '${tableName}' — no datasetId in map`);
      continue;  // only skip if truly no dataset ID
    }

    let columns = [];
    const localColumns = tableToColumns[tableName] || [];

    if (localColumns.length > 0) {
      const domoTypeMap = {
        'LONG': 'DECIMAL', 'DOUBLE': 'DECIMAL',
        'DATE': 'DATETIME', 'DATETIME': 'DATETIME', 'STRING': 'STRING',
      };
      columns = localColumns.map(col => ({
        type: domoTypeMap[col.type] || 'STRING',
        name: col.name,
        id: col.name,
        visible: true,
        order: 0,
      }));
      console.log(`[DATA MODEL] '${tableName}' — ${columns.length} local cols`);
    } else {
      // Fetch from Domo — retry up to 3 times
      for (let attempt = 1; attempt <= 3; attempt++) {
        await new Promise(r => setTimeout(r, 3000));
        const fetched = await fetchDomoDatasetSchema(domain, token, datasetId);
        if (fetched && fetched.length > 0) {
          columns = fetched;
          console.log(`[DATA MODEL] '${tableName}' — ${columns.length} fetched cols (attempt ${attempt})`);
          break;
        }
        console.warn(`[DATA MODEL] '${tableName}' attempt ${attempt}/3 — 0 cols`);
      }
      // ALWAYS push even if columns is still [] — missing table entry = 400 error
      console.log(`[DATA MODEL] '${tableName}' — pushing with ${columns.length} cols (datasetId=${datasetId})`);
    }

    // ALWAYS push — never skip
    tableSchemas.push({ datasource: datasetId, name: tableName, columns });
  }

  // Final check — count must match
  console.log(`[DATA MODEL] tables=${tableSchemas.length}, objects=${Object.keys(objects).length}`);
  if (tableSchemas.length !== Object.keys(objects).length) {
    console.error(`[DATA MODEL] COUNT MISMATCH — this will cause 400`);
    // Force-add any missing tables with empty columns
    for (const [name, obj] of Object.entries(objects)) {
      const exists = tableSchemas.find(t => t.datasource === obj.datasource);
      if (!exists) {
        console.error(`[DATA MODEL] Force-adding missing table '${name}' (${obj.datasource})`);
        tableSchemas.push({ datasource: obj.datasource, name, columns: [] });
      }
    }
  }

  console.log('[DATA MODEL] Object datasources:',
    Object.entries(objects).map(([name, obj]) => `${name}=${obj.datasource}`).join(', '));
  console.log('[DATA MODEL] Table datasources:',
    tableSchemas.map(t => `${t.name}=${t.datasource}`).join(', '));

  // Exact payload structure from Postman working response
  const payload = {
    dataSourceName: modelName,
    dataSourceDescription: '',
    lastUpdated: null,
    canEdit: false,
    cloudId: '',
    schema: {
      name: 'model',
      tables: tableSchemas,
      model: {
        objects,
        relationships,
      }
    }
  };

  console.log(`[DATA MODEL] Creating semantic model: "${modelName}"`);
  console.log(`[DATA MODEL] Tables: ${Object.keys(objects).length}, Relationships: ${relationships.length}`);
  console.log(`[DATA MODEL] Full payload:`, JSON.stringify(payload, null, 2));

  try {
    const response = await axios.post(
      `https://${domain}/api/query/v1/semantic-models`,
      payload,
      { headers, timeout: 60000 }
    );

    // Response has dataSourceId at root level
    const modelId = response.data?.dataSourceId || response.data?.id;
    if (!modelId) {
      throw new Error(`No ID in response: ${JSON.stringify(response.data)}`);
    }

    console.log(`[DATA MODEL] Created successfully. ID: ${modelId}`);
    return {
      modelId,
      modelUrl: `https://${domain}/datamodels/${modelId}`,
      joinCount: relationships.length,
      resolvedRelationships: dedupedRels,
    };

  } catch (error) {
    const status = error.response?.status ?? 'N/A';
    const body = error.response ? JSON.stringify(error.response.data) : error.message;
    throw new Error(`Failed to create Domo semantic model: HTTP ${status} - ${body}`);
  }
}