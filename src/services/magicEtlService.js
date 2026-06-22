import axios from 'axios';

function getAuthHeaders(token) {
  return {
    'Content-Type': 'application/json',
    'X-DOMO-DEVELOPER-TOKEN': token,
  };
}

// ─── Unique ID Generator ──────────────────────────────────────────────────────

/**
 * Creates a tile ID generator scoped to a single dataflow creation call.
 * Prevents ID collisions when multiple migrations run concurrently.
 *
 * @returns {function(string): string} A function that takes a prefix and returns a unique tile ID
 */
function createTileIdGenerator() {
  let count = 0;
  return (prefix) => `${prefix}-${++count}`;
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
      console.warn(`[MAGIC ETL SERVICE] Request failed (${error.message}). Retrying in ${backoffDelay}ms (Attempt ${attempt}/${maxRetries})...`);
      await new Promise(resolve => setTimeout(resolve, backoffDelay));
    }
  }
}

async function fetchDatasetColumns(domain, token, datasetId) {
  const headers = {
    'X-DOMO-DEVELOPER-TOKEN': token,
    'Content-Type': 'application/json'
  };

  return requestWithRetry(async () => {
    try {
      const v3Url = `https://${domain}/api/data/v3/datasources/${datasetId}`;
      console.log(`[SCHEMA] Fetching v3 schema: ${v3Url}`);
      const v3Response = await axios.get(v3Url, { headers, timeout: 15000 });
      const cols = v3Response.data?.schema?.columns || v3Response.data?.columns;
      if (cols && cols.length > 0) {
        return cols.map(c => c.name || c.columnName);
      }
      return [];
    } catch (v3Err) {
      const status = v3Err.response?.status;
      console.warn(`[SCHEMA] v3 schema fetch failed with status ${status}: ${v3Err.message}`);
      if (status === 404) {
        try {
          const v1Url = `https://${domain}/api/data/v1/datasources/${datasetId}/schemas/latest?includeHidden=false`;
          console.log(`[SCHEMA] Falling back to v1 schema: ${v1Url}`);
          const v1Response = await axios.get(v1Url, { headers, timeout: 15000 });
          const cols = v1Response.data?.columns || v1Response.data?.schema?.columns || [];
          return cols.map(c => c.name || c.columnName);
        } catch (v1Err) {
          console.error(`[SCHEMA] v1 schema fetch also failed:`, v1Err.message);
          throw v1Err;
        }
      }
      throw v3Err;
    }
  });
}

/**
 * Creates the gui object for an individual action tile.
 * Every action must have: x, y, color, colorSource, sampleJson.
 */
function makeActionGui(x, y) {
  return {
    x,
    y,
    color: null,
    colorSource: null,
    sampleJson: null,
  };
}

/**
 * Build a LoadFromVault action (input tile).
 */
function buildLoadAction(id, name, dataSourceId, x, y) {
  return {
    type: 'LoadFromVault',
    id,
    name,
    dataSourceId,
    gui: { x, y }
  };
}

/**
 * Build a PublishToVault action (output tile).
 */
function buildOutputAction(id, name, x, y, dependsOnId) {
  return {
    type: 'PublishToVault',
    id,
    name,
    dependsOn: [dependsOnId],
    settings: {},
    gui: { x, y },
    versionChainType: 'REPLACE',
    schemaSource: 'DATAFLOW',
    partitioned: false,
  };
}

/**
 * Helper to compute excludeColumns2 case-insensitively.
 * Excludes any column in rightCols if it exists in leftCols (duplicate check) or is one of the rightKeys.
 */
function getExcludeColumns(leftCols, rightCols, rightKeys) {
  const leftColSet = new Set(
    (leftCols || [])
      .filter(Boolean)
      .map(c => String(c).trim().toLowerCase())
  );

  const rKeys = (Array.isArray(rightKeys) ? rightKeys : [rightKeys])
    .filter(Boolean)
    .map(k => String(k).trim().toLowerCase());

  const toExclude = [];

  for (const col of (rightCols || [])) {
    if (!col) continue;

    const colLower = String(col).trim().toLowerCase();

    if (leftColSet.has(colLower) || rKeys.includes(colLower)) {
      toExclude.push(col);
    }
  }

  return toExclude;
}

/**
 * Build a JoinAction tile.
 *
 * @param {string} id - Tile ID
 * @param {string} name - Human-readable join name
 * @param {string} joinType - JOIN type: LEFT, INNER, FULL
 * @param {string|string[]} leftKey - Left join key column(s)
 * @param {string|string[]} rightKey - Right join key column(s)
 * @param {number} x - GUI x position
 * @param {number} y - GUI y position
 * @param {string} step1Id - Left input tile ID
 * @param {string} step2Id - Right input tile ID
 * @returns {object} MergeJoin action object
 */
function buildJoinAction(id, name, joinType, leftKey, rightKey, x, y, step1Id, step2Id) {
  // Map joinType to Domo format
  const domoJoinType = joinType === 'LEFT' ? 'LEFT OUTER'
    : joinType === 'INNER' ? 'INNER'
      : joinType === 'FULL' ? 'FULL OUTER'
        : 'LEFT OUTER';

  return {
    type: 'MergeJoin',
    id,
    name,
    dependsOn: [step1Id, step2Id],
    settings: {},
    gui: { x, y },
    joinType: domoJoinType,
    relationshipType: 'MANY_TO_MANY',
    step1: step1Id,
    step2: step2Id,
    keys1: Array.isArray(leftKey) ? leftKey : [leftKey],
    keys2: Array.isArray(rightKey) ? rightKey : [rightKey],
  };
}



/**
 * Maps Power Query M type names to Domo ETL type names.
 *
 * @param {string} mType - M type string (e.g. 'type number', 'Int64.Type')
 * @returns {string} Domo ETL type: LONG, DOUBLE, DATE, DATETIME, or STRING
 */
function mapMTypeToEtlType(mType) {
  const t = String(mType || '').toLowerCase().replace(/\s+/g, '');
  if (t === 'int64.type' || t === 'integer' || t === 'long') return 'LONG';
  if (t === 'typenumber' || t === 'double' || t === 'decimal') return 'DOUBLE';
  if (t === 'typedate') return 'DATE';
  if (t === 'typedatetime' || t === 'datetime') return 'DATETIME';
  return 'STRING';
}

// ─── Step Mapper ──────────────────────────────────────────────────────────────

/**
 * Maps a parsed ETL step (actionType + properties) into a valid Domo action object.
 * Every action includes: type, id, name, dependsOn, settings, gui
 *
 * @param {object} step - Parsed step with actionType and properties
 * @param {string} tileId - Unique tile ID
 * @param {number} x - GUI x position
 * @param {number} y - GUI y position
 * @param {string|null} previousTileId - ID of the previous tile in the chain (for dependsOn)
 * @returns {object} Domo action object
 */
function mapStepToDomoAction(step, tileId, x, y, previousTileId) {
  const base = {
    id: tileId,
    name: step.stepName || step.description || `Step ${tileId}`,
    dependsOn: previousTileId ? [previousTileId] : [],
    gui: makeActionGui(x, y),
  };

  switch (step.actionType) {
    case 'FILTER':
      return {
        ...base,
        type: 'FilterRows',
        settings: {
          filterCondition: step.properties.condition || '',
        },
      };

    case 'SELECT_COLUMNS':
      return {
        ...base,
        type: 'SelectValues',
        fields: (step.properties.columns || []).map(c => ({
          name: c
        })),
        removeByDefault: true,
      };

    case 'REMOVE_COLUMNS':
      return {
        ...base,
        type: 'SelectValues',
        fields: (step.properties.columns || []).map(c => ({
          name: c,
          remove: true
        })),
        removeByDefault: false,
      };

    case 'RENAME_COLUMNS':
      return {
        ...base,
        type: 'SelectValues',
        fields: (step.properties.renames || []).map(r => ({
          name: r.from,
          rename: r.to
        })),
        removeByDefault: false,
      };

    case 'SET_COLUMN_TYPE':
      return {
        ...base,
        type: 'SelectValues',
        fields: (step.properties.columns || []).map(c => ({
          name: c.name,
          type: mapMTypeToEtlType(c.toType)
        })),
        removeByDefault: false,
      };

    case 'ADD_FORMULA':
      return {
        ...base,
        type: 'ExpressionEvaluator',
        expressions: [
          {
            fieldName: step.properties.columnName || '',
            expression: step.properties.formula || '',
          }
        ]
      };

    case 'ADD_CONSTANT':
      return {
        ...base,
        type: 'AddConstantAction',
        settings: {
          columnName: step.properties.columnName || '',
          value: step.properties.value ?? '',
          dataType: step.properties.dataType || 'STRING',
        },
      };

    case 'GROUP_BY':
      return {
        ...base,
        type: 'GroupBy',
        settings: {
          groupByColumns: step.properties.groupByColumns || [],
          aggregations: step.properties.aggregations || [],
        },
      };

    case 'SORT':
      return {
        ...base,
        type: 'Order',
        settings: {
          sortColumns: step.properties.sortColumns || [],
        },
      };

    case 'REMOVE_DUPLICATES':
      return {
        ...base,
        type: 'RemoveDuplicatesAction',
        settings: {
          keyColumns: step.properties.keyColumns || [],
        },
      };

    case 'TOP_N_ROWS':
      return {
        ...base,
        type: 'TopRowsAction',
        settings: {
          n: step.properties.n || 10,
          order: step.properties.order || 'DESC',
          orderByColumn: step.properties.orderByColumn || '',
        },
      };

    case 'JOIN_DATA':
      return {
        ...base,
        type: 'MergeJoin',
        settings: {},
        joinType: step.properties.joinType === 'LEFT' ? 'LEFT OUTER'
          : step.properties.joinType === 'INNER' ? 'INNER'
            : step.properties.joinType === 'FULL' ? 'FULL OUTER'
              : 'LEFT OUTER',
        relationshipType: 'MANY_TO_MANY',
        step1: base.dependsOn[0] || '',
        step2: step.properties.rightDataset || '',
        keys1: Array.isArray(step.properties.leftKey) ? step.properties.leftKey : [step.properties.leftKey || ''],
        keys2: Array.isArray(step.properties.rightKey) ? step.properties.rightKey : [step.properties.rightKey || ''],
      };

    case 'APPEND_ROWS':
      return {
        ...base,
        type: 'UnionAll',
        settings: {
          datasetsToAppend: step.properties.datasetsToAppend || [],
        },
      };

    case 'PIVOT':
      return {
        ...base,
        type: 'PivotAction',
        settings: {
          pivotColumn: step.properties.pivotColumn || '',
          valueColumn: step.properties.valueColumn || '',
          aggregation: step.properties.aggregation || 'SUM',
        },
      };

    case 'UNPIVOT':
      return {
        ...base,
        type: 'UnpivotAction',
        settings: {
          attributeColumns: step.properties.attributeColumns || [],
          attributeColumnName: step.properties.attributeColumnName || 'Attribute',
          valueColumnName: step.properties.valueColumnName || 'Value',
        },
      };

    case 'DUPLICATE_COLUMN':
      return {
        ...base,
        type: 'DuplicateColumnAction',
        settings: {
          sourceColumn: step.properties.sourceColumn || '',
          newColumnName: step.properties.newColumnName || '',
        },
      };

    case 'SPLIT_COLUMN':
      return {
        ...base,
        type: 'SplitColumnAction',
        settings: {
          sourceColumn: step.properties.sourceColumn || '',
          delimiter: step.properties.delimiter || ',',
          outputColumns: step.properties.outputColumns || [],
        },
      };

    case 'COLUMN_COMBINE':
      return {
        ...base,
        type: 'CombineColumnsAction',
        settings: {
          sourceColumns: step.properties.sourceColumns || [],
          outputColumn: step.properties.outputColumn || '',
          separator: step.properties.separator || '',
        },
      };

    case 'TEXT_FORMULA':
      return {
        ...base,
        type: 'TextFormulaAction',
        settings: {
          columnName: step.properties.columnName || '',
          operation: step.properties.operation || '',
          sourceColumn: step.properties.sourceColumn || '',
        },
      };

    case 'FIND_REPLACE':
      return {
        ...base,
        type: 'FindReplaceAction',
        settings: {
          column: step.properties.column || '',
          findValue: step.properties.findValue || '',
          replaceValue: step.properties.replaceValue || '',
          matchCase: step.properties.matchCase ?? false,
        },
      };

    case 'DATE_OPERATIONS':
      return {
        ...base,
        type: 'DateOperationAction',
        settings: {
          columnName: step.properties.columnName || '',
          operation: step.properties.operation || '',
          sourceColumn: step.properties.sourceColumn || '',
          unit: step.properties.unit || '',
        },
      };

    case 'NUMBER_FORMULA':
      return {
        ...base,
        type: 'NumberFormatAction',
        settings: {
          columnName: step.properties.columnName || '',
          operation: step.properties.operation || '',
          sourceColumn: step.properties.sourceColumn || '',
          precision: step.properties.precision ?? 2,
        },
      };

    case 'RANK_WINDOW':
      return {
        ...base,
        type: 'RankWindowAction',
        settings: {
          partitionColumns: step.properties.partitionColumns || [],
          orderColumn: step.properties.orderColumn || '',
          rankType: step.properties.rankType || 'RANK',
        },
      };

    case 'MANUAL_BUILD':
    default:
      return {
        ...base,
        type: 'ManualAction',
        settings: {
          manualDescription: step.properties?.description || step.description || 'Manual step - requires manual configuration in Domo.',
        },
      };
  }
}

// ─── Payload Wrapper ──────────────────────────────────────────────────────────

/**
 * Wraps the actions array into a complete, valid Domo Magic ETL dataflow payload.
 * Includes ALL mandatory root-level fields and gui.canvases.default.elements
 * entries for every tile.
 */
function buildMagicEtlPayload(name, actions, inputs, outputs) {
  return {
    name,
    databaseType: 'MAGIC',
    magic: true,
    editable: true,
    actions,
    inputs: [],
    outputs: []
  };
}

/**
 * Validates the payload before submission. Throws if invalid.
 *
 * @param {object} payload - The Magic ETL dataflow payload to validate
 * @throws {Error} If validation fails
 */
function validatePayload(payload) {
  const errors = [];

  if (payload.databaseType !== 'MAGIC') errors.push('databaseType must be "MAGIC"');
  if (payload.magic !== true) errors.push('magic must be true');
  if (payload.editable !== true) errors.push('editable must be true');
  if (!payload.actions || payload.actions.length === 0) errors.push('actions array is empty');

  const ids = new Set();
  for (const action of (payload.actions || [])) {
    if (ids.has(action.id)) errors.push(`Duplicate action id: ${action.id}`);
    ids.add(action.id);
    if (action.gui?.x === undefined || action.gui?.y === undefined) {
      errors.push(`Action '${action.id}' is missing gui coordinates`);
    }
  }

  // Validate dependsOn references
  const actionIdSet = new Set(payload.actions.map(a => a.id));
  for (const action of payload.actions) {
    for (const dep of (action.dependsOn || [])) {
      if (!actionIdSet.has(dep)) {
        errors.push(`Action '${action.id}' has dependsOn referencing unknown id '${dep}'`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`[MAGIC ETL VALIDATION] Payload failed validation:\n  - ${errors.join('\n  - ')}`);
  }
}

// ─── createMagicEtlDataflow ───────────────────────────────────────────────────

/**
 * Creates a Magic ETL dataflow in Domo for a single table's Power Query transforms.
 *
 * @param {object} dataflowDefinition - Output from buildDataflowDefinition()
 * @returns {{ dataflowId: string, dataflowUrl: string }} Created dataflow info
 */
export async function createMagicEtlDataflow(dataflowDefinition) {
  validateDomoEnv();
  const domain = (process.env.DOMO_CLIENT_DOMAIN || '').trim();
  const token = (process.env.DOMO_CLIENT_TOKEN || '').trim();

  if (dataflowDefinition.skipped) {
    console.log(`[MAGIC ETL] Skipping table '${dataflowDefinition.tableName}': ${dataflowDefinition.skipReason}`);
    return null;
  }

  const headers = getAuthHeaders(token);
  const nextTileId = createTileIdGenerator();

  // ── 1. Input Tile (LoadFromVault) ──
  const inputTileId = nextTileId('input');
  const actions = [
    buildLoadAction(
      inputTileId,
      dataflowDefinition.tableName,
      dataflowDefinition.domoInputDatasetId,
      100, 100
    )
  ];

  // ── 2. Transform Tiles ──
  let previousTileId = inputTileId;
  const xStart = 300;
  const xStep = 200;

  const manualSteps = [];
  const autoSteps = [];

  dataflowDefinition.steps.forEach((step, i) => {
    const tileId = nextTileId('transform');
    const x = xStart + i * xStep;
    const y = 100;
    const domoAction = mapStepToDomoAction(step, tileId, x, y, previousTileId);
    actions.push(domoAction);

    if (domoAction.type === 'ManualAction') {
      manualSteps.push(domoAction);
    } else {
      autoSteps.push(domoAction);
    }

    previousTileId = tileId;
  });

  // ── 3. Output Tile (PublishToVault) ──
  const outputTileId = nextTileId('output');
  const outputX = xStart + dataflowDefinition.steps.length * xStep;
  actions.push(
    buildOutputAction(outputTileId, dataflowDefinition.outputDatasetName, outputX, 100, previousTileId)
  );

  if (manualSteps.length > 0) {
    console.log(`[MAGIC ETL] ${manualSteps.length} step(s) flagged as MANUAL_BUILD for '${dataflowDefinition.tableName}':`);
    manualSteps.forEach(s => console.log(`  - ${s.name}: ${s.settings.manualDescription}`));
  }

  // ── 4. Build inputs / outputs arrays ──
  const inputs = [
    {
      datasetId: dataflowDefinition.domoInputDatasetId,
      datasetName: dataflowDefinition.tableName,
    }
  ];

  const outputs = [
    {
      datasetName: dataflowDefinition.outputDatasetName,
    }
  ];

  // ── 5. Assemble full payload ──
  const payload = buildMagicEtlPayload(
    dataflowDefinition.dataflowName,
    actions,
    inputs,
    outputs
  );

  // ── 6. Validate before submission ──
  validatePayload(payload);

  console.log(`[MAGIC ETL] Creating dataflow '${dataflowDefinition.dataflowName}' with ${actions.length} action(s)...`);
  console.log(`[MAGIC ETL] Payload:`, JSON.stringify(payload, null, 2));

  // ── 7. Submit ──
  try {
    const url = `https://${domain}/api/dataprocessing/v1/dataflows`;
    console.log(`[MAGIC ETL] Submitting Magic ETL creation request to: ${url}`);
    const response = await axios.post(url, payload, { headers, timeout: 60000 });

    const dataflowId = response.data?.id || response.data?.dataFlowId || response.data?.dataflowId;
    const respOutputs = response.data?.outputs || [];
    const outputDatasetId = respOutputs[0]?.dataSourceId || respOutputs[0]?.id || respOutputs[0]?.datasetId || null;

    if (!dataflowId) {
      console.warn(`[MAGIC ETL] Dataflow may have been created but no ID in response:`, JSON.stringify(response.data));
      return {
        dataflowId: null,
        dataflowUrl: null,
        outputDatasetId: null,
        response: response.data,
        steps: dataflowDefinition.steps,
      };
    }

    const dataflowUrl = `https://${domain}/datacenter/dataflows/${dataflowId}`;
    console.log(`[MAGIC ETL] Dataflow created successfully. ID: ${dataflowId}, URL: ${dataflowUrl}, Output Dataset: ${outputDatasetId}`);

    return {
      dataflowId,
      dataflowUrl,
      outputDatasetId,
      steps: dataflowDefinition.steps,
      autoMappedSteps: autoSteps.length,
      manualBuildSteps: manualSteps.length,
    };

  } catch (error) {
    const status = error.response ? error.response.status : 'N/A';
    const body = error.response ? JSON.stringify(error.response.data) : error.message;
    console.error(`[MAGIC ETL] Failed to create dataflow: HTTP ${status} - ${body}`);

    return {
      dataflowId: null,
      dataflowUrl: null,
      outputDatasetId: null,
      error: `HTTP ${status}: ${body}`,
      steps: dataflowDefinition.steps,
      autoMappedSteps: autoSteps.length,
      manualBuildSteps: manualSteps.length,
    };
  }
}

// ─── createModelViewMagicEtl ──────────────────────────────────────────────────
const _modelViewInFlight = new Map();

/**
 * Creates a Magic ETL dataflow in Domo representing the Model View (joined relationships).
 *
 * @param {string} reportName - Power BI report name
 * @param {Array}  resolvedRels - Resolved relationships from resolveRelationships()
 * @param {object} tableToDatasetId - Map of tableName -> domoDatasetId
 * @returns {Promise<object>} Created dataflow info
 */
export async function createModelViewMagicEtl(reportName, resolvedRels, tableToDatasetId) {
  if (_modelViewInFlight.has(reportName)) {
    console.log(`[CONCURRENCY] A request for Model View ETL for reportName '${reportName}' is already in-flight. Awaiting it.`);
    return _modelViewInFlight.get(reportName);
  }

  const promise = (async () => {
    validateDomoEnv();
    const domain = (process.env.DOMO_CLIENT_DOMAIN || '').trim();
    const token = (process.env.DOMO_CLIENT_TOKEN || '').trim();

    const validRels = resolvedRels.filter(r =>
      tableToDatasetId[r.fromTable] && tableToDatasetId[r.toTable]
    );

    if (validRels.length === 0) {
      throw new Error('No valid relationships found between migrated Domo datasets.');
    }

    const involvedTables = new Set();
    for (const r of validRels) {
      involvedTables.add(r.fromTable);
      involvedTables.add(r.toTable);
    }
    const uniqueTables = Array.from(involvedTables);

    const headers = getAuthHeaders(token);
    const nextTileId = createTileIdGenerator();

    // ── 1. Input Tiles (LoadFromVault) ──
    const actions = [];
    const tableToTileId = {};
    const tableToColumns = {};

    await Promise.all(
      uniqueTables.map(async (tableName, index) => {
        const inputTileId = nextTileId('input');
        tableToTileId[tableName] = inputTileId;
        actions.push(
          buildLoadAction(inputTileId, tableName, tableToDatasetId[tableName], 100, 100 + index * 120)
        );
        tableToColumns[tableName] = await fetchDatasetColumns(domain, token, tableToDatasetId[tableName]);
      })
    );



    // ── 2. Join Tiles (MergeJoin) ──
    const joinedTables = new Set();
    const accumulatedLeftCols = new Set();
    const remainingRels = [...validRels];
    let joinIndex = 0;
    let activeStreamId = null;
    const joinXStart = 450;
    const joinXStep = 200;

    while (remainingRels.length > 0) {
      let relIndex = -1;
      if (joinedTables.size > 0) {
        relIndex = remainingRels.findIndex(r =>
          (joinedTables.has(r.fromTable) && !joinedTables.has(r.toTable)) ||
          (joinedTables.has(r.toTable) && !joinedTables.has(r.fromTable))
        );
      } else {
        relIndex = 0;
      }

      if (relIndex !== -1) {
        const rel = remainingRels[relIndex];
        remainingRels.splice(relIndex, 1);

        const fromTable = rel.fromTable;
        const toTable = rel.toTable;

        let joinName;
        let rightTable;
        let leftTableName;
        let rightTableName;
        let leftKey;
        let rightKey;

        if (joinedTables.size === 0) {
          joinName = `Join ${fromTable} & ${toTable}`;
          joinedTables.add(fromTable);
          joinedTables.add(toTable);

          // Initialize accumulatedLeftCols with fromTable columns
          (tableToColumns[fromTable] || []).forEach(c => accumulatedLeftCols.add(c));

          rightTable = toTable;
          leftTableName = fromTable;
          rightTableName = toTable;
          leftKey = rel.fromColumn;
          rightKey = rel.toColumn;
        } else {
          if (joinedTables.has(fromTable)) {
            joinName = `Join ${toTable} to Model`;
            joinedTables.add(toTable);
            rightTable = toTable;
            leftTableName = fromTable;
            rightTableName = toTable;
            leftKey = rel.fromColumn;
            rightKey = rel.toColumn;
          } else {
            joinName = `Join ${fromTable} to Model`;
            joinedTables.add(fromTable);
            rightTable = fromTable;
            leftTableName = toTable;
            rightTableName = fromTable;
            leftKey = rel.toColumn;
            rightKey = rel.fromColumn;
          }
        }

        let joinType = 'INNER';
        if (rel.crossFilter === 'BothDirections') {
          joinType = 'LEFT';
        } else if (rel.crossFilter === 'OneDirection') {
          joinType = rel.fromCardinality === 'One' ? 'LEFT' : 'INNER';
        }

        const joinTileId = nextTileId('join');
        const jx = joinXStart + joinIndex * joinXStep;
        const jy = 150 + joinIndex * 50;

        const isFirstJoin = activeStreamId === null;
        const step1Id = isFirstJoin ? tableToTileId[fromTable] : activeStreamId;
        const step2Id = tableToTileId[rightTable];

        actions.push(
          buildJoinAction(
            joinTileId,
            joinName,
            joinType,
            leftKey,
            rightKey,
            jx,
            jy,
            step1Id,
            step2Id
          )
        );

        // Accumulate right table's prefixed columns
        (tableToColumns[rightTable] || []).forEach(c => accumulatedLeftCols.add(c));

        activeStreamId = joinTileId;
        joinIndex++;

      } else {
        // Disconnected graph fallback
        const rel = remainingRels.shift();
        const fromTable = rel.fromTable;
        const toTable = rel.toTable;

        const subJoinTileId = nextTileId('join-sub');
        const sjx = joinXStart + joinIndex * joinXStep;

        const leftKey = rel.fromColumn;
        const rightKey = rel.toColumn;

        actions.push(
          buildJoinAction(
            subJoinTileId,
            `Join ${fromTable} & ${toTable} (Sub-branch)`,
            'INNER',
            leftKey,
            rightKey,
            sjx,
            350,
            tableToTileId[fromTable],
            tableToTileId[toTable]
          )
        );
        joinIndex++;

        // Compute sub-branch output columns (no prefixing, no collisions)
        const subBranchCols = [
          ...(tableToColumns[fromTable] || []),
          ...(tableToColumns[toTable] || [])
        ];

        const mergeJoinTileId = nextTileId('join-merge');
        const mjx = joinXStart + joinIndex * joinXStep;

        const leftMergeKey = rel.fromColumn;
        const rightMergeKey = rel.fromColumn;

        actions.push(
          buildJoinAction(
            mergeJoinTileId,
            'Merge Disjoint Branches',
            'LEFT',
            leftMergeKey,
            rightMergeKey,
            mjx,
            250,
            activeStreamId,
            subJoinTileId
          )
        );

        // Accumulate sub-branch columns
        subBranchCols.forEach(c => accumulatedLeftCols.add(c));

        joinedTables.add(fromTable);
        joinedTables.add(toTable);
        activeStreamId = mergeJoinTileId;
        joinIndex++;
      }
    }

    // ── 3. Output Tile (PublishToVault) ──
    const outputDatasetName = `${reportName} - Model View Output`;
    const outputTileId = nextTileId('output');
    const outputX = joinXStart + joinIndex * joinXStep;

    actions.push(
      buildOutputAction(outputTileId, outputDatasetName, outputX, 200, activeStreamId)
    );

    // ── 4. Build inputs / outputs ──
    const inputs = uniqueTables.map(tableName => ({
      dataSourceId: tableToDatasetId[tableName],
      dataSourceName: tableName,
      executeFlowWhenUpdated: false,
      onlyLoadNewVersions: false,
      recentVersionCutoffMs: 0
    }));

    const outputs = [
      {
        dataSourceName: outputDatasetName,
        versionChainType: 'REPLACE'
      }
    ];

    // ── 5. Assemble full payload ──
    const dataflowName = `${reportName} - Model View (Magic ETL)`;
    const payload = buildMagicEtlPayload(
      dataflowName,
      actions,
      inputs,
      outputs
    );

    // ── 6. Validate before submission ──
    validatePayload(payload);

    // console.log(`[MAGIC ETL MODEL VIEW] Creating dataflow '${dataflowName}' with ${actions.length} action(s)...`);
    // console.log(`[MAGIC ETL MODEL VIEW] Payload:`, JSON.stringify(payload, null, 2));

    // ── 7. Submit ──
    try {
      const url = `https://${domain}/api/dataprocessing/v1/dataflows`;
      console.log(`[MAGIC ETL MODEL VIEW] Submitting Magic ETL creation request to: ${url}`);
      const response = await axios.post(url, payload, { headers, timeout: 60000 });

      const dataflowId = response.data?.id || response.data?.dataFlowId || response.data?.dataflowId;
      const respOutputs = response.data?.outputs || [];
      const outputDatasetId = respOutputs[0]?.dataSourceId || respOutputs[0]?.id || respOutputs[0]?.datasetId || null;

      if (!dataflowId) {
        console.warn(`[MAGIC ETL MODEL VIEW] Dataflow may have been created but no ID in response:`, JSON.stringify(response.data));
        return {
          dataflowId: null,
          dataflowUrl: null,
          outputDatasetId: null,
          response: response.data,
        };
      }

      const dataflowUrl = `https://${domain}/datacenter/dataflows/${dataflowId}`;
      console.log(`[MAGIC ETL MODEL VIEW] Created successfully. ID: ${dataflowId}, URL: ${dataflowUrl}, Output Dataset: ${outputDatasetId}`);

      return {
        dataflowId,
        dataflowUrl,
        outputDatasetId,
        joinCount: joinIndex,
      };

    } catch (error) {
      const status = error.response ? error.response.status : 'N/A';
      const body = error.response ? JSON.stringify(error.response.data) : error.message;
      console.error(`[MAGIC ETL MODEL VIEW] Failed to create model view dataflow: HTTP ${status} - ${body}`);
      throw new Error(`Failed to create Magic ETL for Model View: HTTP ${status} - ${body}`);
    }
  })();

  _modelViewInFlight.set(reportName, promise);

  try {
    return await promise;
  } finally {
    _modelViewInFlight.delete(reportName);
  }
}
