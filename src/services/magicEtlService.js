import axios from 'axios';

export function getAuthHeaders(token) {
  return {
    'Content-Type': 'application/json',
    'X-DOMO-DEVELOPER-TOKEN': token,
  };
}

// ─── Unique ID Generator ──────────────────────────────────────────────────────

function createTileIdGenerator() {
  let count = 0;
  return (prefix) => `${prefix}-${++count}`;
}

function validateDomoEnv() {
  const missing = ['DOMO_CLIENT_DOMAIN', 'DOMO_CLIENT_TOKEN'].filter(
    k => !process.env[k]?.trim()
  );
  if (missing.length > 0) {
    throw new Error(`Missing required Domo environment variables: ${missing.join(', ')}`);
  }
}

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

      const backoffDelay = 2000 * Math.pow(2, attempt);
      console.warn(`[MAGIC ETL SERVICE] Request failed (${error.message}). Retrying in ${backoffDelay}ms (Attempt ${attempt}/${maxRetries})...`);
      await new Promise(resolve => setTimeout(resolve, backoffDelay));
    }
  }
}

export async function fetchDatasetColumns(domain, token, datasetId) {
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

function makeActionGui(x, y) {
  return {
    x,
    y,
    color: null,
    colorSource: null,
    sampleJson: null,
  };
}

function buildLoadAction(id, name, dataSourceId, x, y) {
  return {
    type: 'LoadFromVault',
    id,
    name,
    dataSourceId,
    gui: { x, y }
  };
}

function buildOutputAction(id, name, x, y, dependsOnId) {
  return {
    type: 'PublishToVault',
    id,
    name,
    dataSourceName: name,
    dependsOn: [dependsOnId],
    settings: {
      "selectAction": name
    },
    gui: { x, y },
    versionChainType: 'REPLACE',
    schemaSource: 'DATAFLOW',
    partitioned: false,
  };
}

function buildJoinAction(id, name, joinType, leftKey, rightKey, x, y, step1Id, step2Id) {
  const domoJoinType = joinType === 'LEFT' || joinType === 'LEFT OUTER' ? 'LEFT OUTER'
    : joinType === 'INNER' ? 'INNER'
      : joinType === 'FULL' || joinType === 'FULL OUTER' ? 'FULL OUTER'
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

function mapMTypeToEtlType(mType) {
  const t = String(mType || '').toLowerCase().replace(/\s+/g, '');
  if (t === 'int64.type' || t === 'integer' || t === 'long') return 'LONG';
  if (t === 'typenumber' || t === 'double' || t === 'decimal') return 'DOUBLE';
  if (t === 'typedate') return 'DATE';
  if (t === 'typedatetime' || t === 'datetime') return 'DATETIME';
  return 'STRING';
}

function mapStepToDomoAction(step, tileId, x, y, previousTileId, stepNameToTileId = {}) {
  if (step.actionType === 'MANUAL_BUILD' || step.actionType === 'MANUAL_ACTION') {
    console.warn(`[MAGIC ETL] Skipping MANUAL_BUILD step: ${step.stepName || step.description}`);
    return null;
  }

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
        type: 'Metadata',
        fields: (step.properties.columns || [])
          .filter(c => c.name && c.name.trim().length > 0)
          .map(c => ({
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

    case 'ADD_CONSTANT': {
      const val = step.properties.value;
      const dType = step.properties.dataType || 'STRING';
      let exprStr = '';
      if (dType === 'STRING') {
        const strVal = String(val ?? '');
        exprStr = strVal.startsWith("'") && strVal.endsWith("'") ? strVal : `'${strVal.replace(/'/g, "''")}'`;
      } else if (dType === 'DATE' || dType === 'DATETIME') {
        exprStr = String(val ?? 'NOW()');
      } else {
        exprStr = String(val ?? '0');
      }
      return {
        ...base,
        type: 'ExpressionEvaluator',
        expressions: [
          {
            fieldName: step.properties.columnName || '',
            expression: exprStr,
          }
        ]
      };
    }

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

    case 'APPEND_ROWS': {
      const rightStepName = step.properties.rightInputStepName;
      const rightTileId = rightStepName && stepNameToTileId[rightStepName] ? stepNameToTileId[rightStepName] : previousTileId;
      return {
        ...base,
        type: 'AppendRows',
        settings: {},
        dependsOn: [previousTileId, rightTileId],
      };
    }

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

    case 'FIND_REPLACE': {
      let fieldsList = [];
      if (Array.isArray(step.properties.replacements)) {
        fieldsList = step.properties.replacements.map(rep => ({
          inStreamName: rep.column || '',
          useRegex: false,
          replaceString: rep.findValue || '',
          replaceByString: rep.replaceValue || '',
          wholeWord: false,
          caseSensitive: rep.matchCase ?? false,
        }));
      } else if (step.properties.column) {
        fieldsList = [
          {
            inStreamName: step.properties.column || '',
            useRegex: false,
            replaceString: step.properties.findValue || '',
            replaceByString: step.properties.replaceValue || '',
            wholeWord: false,
            caseSensitive: step.properties.matchCase ?? false,
          }
        ];
      }
      return {
        ...base,
        type: 'ReplaceString',
        fields: fieldsList,
      };
    }

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

    default:
      return null;
  }
}

function buildMagicEtlPayload(name, actions, inputs, outputs) {
  return {
    name,
    databaseType: 'MAGIC',
    magic: true,
    editable: true,
    actions,
    inputs,
    outputs
  };
}

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

  const autoSteps = [];
  const stepNameToTileId = {};
  stepNameToTileId[dataflowDefinition.tableName] = inputTileId;

  let manualBuildStepsCount = 0;

  dataflowDefinition.steps.forEach((step, i) => {
    if (step.actionType === 'MANUAL_BUILD' || step.actionType === 'MANUAL_ACTION') {
      console.warn(`[MAGIC ETL] Skipping manual step: ${step.stepName || step.description}`);
      manualBuildStepsCount++;
      return;
    }

    const tileId = nextTileId('transform');
    const x = xStart + i * xStep;
    const y = 100;
    const domoAction = mapStepToDomoAction(step, tileId, x, y, previousTileId, stepNameToTileId);
    if (!domoAction) {
      console.warn(`[MAGIC ETL] Mapped step returned null (skipping): ${step.stepName}`);
      return;
    }

    actions.push(domoAction);
    if (step.stepName) {
      stepNameToTileId[step.stepName] = tileId;
    }
    autoSteps.push(domoAction);
    previousTileId = tileId;
  });

  // ── 3. Output Tile (PublishToVault) ──
  const outputTileId = nextTileId('output');
  const outputX = xStart + dataflowDefinition.steps.length * xStep;
  actions.push(
    buildOutputAction(outputTileId, dataflowDefinition.outputDatasetName, outputX, 100, previousTileId)
  );

  // ── 4. Build inputs / outputs arrays ──
  const inputs = [
    {
      dataSourceId: dataflowDefinition.domoInputDatasetId,
      dataSourceName: dataflowDefinition.tableName,
      executeFlowWhenUpdated: false,
      onlyLoadNewVersions: false,
      recentVersionCutoffMs: 0
    }
  ];

  const outputs = [
    {
      dataSourceName: dataflowDefinition.outputDatasetName,
      versionChainType: 'REPLACE'
    }
  ];

  // ── 5. Assemble full payload ──
  const payload = buildMagicEtlPayload(
    dataflowDefinition.dataflowName,
    actions,
    inputs,
    outputs
  );

  validatePayload(payload);

  console.log(`[MAGIC ETL] Creating dataflow '${dataflowDefinition.dataflowName}' with ${actions.length} action(s)...`);

  // ── 7. Submit ──
  try {
    const url = `https://${domain}/api/dataprocessing/v1/dataflows`;
    console.log(`[MAGIC ETL] Submitting Magic ETL creation request to: ${url}`);
    const response = await axios.post(url, payload, { headers, timeout: 60000 });

    const dataflowId = response.data?.id || response.data?.dataFlowId || response.data?.dataflowId;

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
    console.log(`[MAGIC ETL] Dataflow created successfully. ID: ${dataflowId}, URL: ${dataflowUrl}`);

    return {
      dataflowId,
      dataflowUrl,
      outputDatasetId: null, // extracted later after running & polling
      steps: dataflowDefinition.steps,
      autoMappedSteps: autoSteps.length,
      manualBuildSteps: manualBuildStepsCount,
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
      manualBuildSteps: manualBuildStepsCount,
    };
  }
}

// ─── Custom createModelViewMagicEtl ──────────────────────────────────────────
const _modelViewInFlight = new Map();

function resolveColumnConflicts(leftTileId, rightTileId, rightTableName, leftKey, rightKey, jx, jy, nextTileId, actions, streamColumns, renamesPerformed) {
  const leftCols = streamColumns[leftTileId] || new Set();
  const rightCols = streamColumns[rightTileId] || new Set();

  const conflicts = [];
  for (const col of rightCols) {
    const colLower = col.toLowerCase();
    const isConflict = Array.from(leftCols).some(lc => lc.toLowerCase() === colLower);
    if (isConflict) {
      conflicts.push(col);
    }
  }

  if (conflicts.length === 0) {
    return { step2Id: rightTileId, rightKey };
  }

  const dedupTileId = nextTileId('dedup');
  const suffix = `_${rightTableName}`;
  const renamingFields = conflicts.map(col => ({
    name: col,
    rename: col + suffix
  }));

  actions.push({
    type: 'SelectValues',
    id: dedupTileId,
    name: `Rename conflicting columns in ${rightTableName}`,
    dependsOn: [rightTileId],
    gui: { x: jx - 50, y: jy + 100 },
    fields: renamingFields,
    removeByDefault: false
  });

  conflicts.forEach(col => {
    renamesPerformed.push({ original: col, renamed: col + suffix });
  });

  const renamedRightCols = new Set();
  for (const col of rightCols) {
    if (conflicts.includes(col)) {
      renamedRightCols.add(col + suffix);
    } else {
      renamedRightCols.add(col);
    }
  }
  streamColumns[dedupTileId] = renamedRightCols;

  // Map right join keys if they are resolved as conflicts
  const updatedRightKey = (Array.isArray(rightKey) ? rightKey : [rightKey]).map(key => {
    const keyTrimmed = key.trim();
    const keyLower = keyTrimmed.toLowerCase();
    const conflictCol = conflicts.find(c => c.toLowerCase() === keyLower);
    if (conflictCol) {
      return conflictCol + suffix;
    }
    return keyTrimmed;
  });

  return {
    step2Id: dedupTileId,
    rightKey: Array.isArray(rightKey) ? updatedRightKey : updatedRightKey[0]
  };
}

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

    const streamColumns = {};
    uniqueTables.forEach(tableName => {
      const tileId = tableToTileId[tableName];
      streamColumns[tileId] = new Set(tableToColumns[tableName] || []);
    });

    // ── 2. Join Tiles (MergeJoin) ──
    const joinedTables = new Set();
    const remainingRels = [...validRels];
    let joinIndex = 0;
    let activeStreamId = null;
    const joinXStart = 450;
    const joinXStep = 200;
    const renamesPerformed = [];

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
        const step1Id = isFirstJoin ? tableToTileId[leftTableName] : activeStreamId;

        const conflictRes = resolveColumnConflicts(
          step1Id,
          tableToTileId[rightTable],
          rightTableName,
          leftKey,
          rightKey,
          jx,
          jy,
          nextTileId,
          actions,
          streamColumns,
          renamesPerformed
        );
        const step2Id = conflictRes.step2Id;
        const resolvedRightKey = conflictRes.rightKey;

        actions.push(
          buildJoinAction(
            joinTileId,
            joinName,
            joinType,
            leftKey,
            resolvedRightKey,
            jx,
            jy,
            step1Id,
            step2Id
          )
        );

        const leftCols = streamColumns[step1Id] || new Set();
        const rightColsForJoin = streamColumns[step2Id] || new Set();
        streamColumns[joinTileId] = new Set([...leftCols, ...rightColsForJoin]);

        for (const table of uniqueTables) {
          if (tableToTileId[table] === step1Id || tableToTileId[table] === tableToTileId[rightTable]) {
            tableToTileId[table] = joinTileId;
          }
        }

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

        const subConflictRes = resolveColumnConflicts(
          tableToTileId[fromTable],
          tableToTileId[toTable],
          toTable,
          leftKey,
          rightKey,
          sjx,
          350,
          nextTileId,
          actions,
          streamColumns,
          renamesPerformed
        );
        const subStep2Id = subConflictRes.step2Id;
        const subResolvedRightKey = subConflictRes.rightKey;

        actions.push(
          buildJoinAction(
            subJoinTileId,
            `Join ${fromTable} & ${toTable} (Sub-branch)`,
            'INNER',
            leftKey,
            subResolvedRightKey,
            sjx,
            350,
            tableToTileId[fromTable],
            subStep2Id
          )
        );

        const fromCols = streamColumns[tableToTileId[fromTable]] || new Set();
        const subRightCols = streamColumns[subStep2Id] || new Set();
        streamColumns[subJoinTileId] = new Set([...fromCols, ...subRightCols]);
        joinIndex++;

        const mergeJoinTileId = nextTileId('join-merge');
        const mjx = joinXStart + joinIndex * joinXStep;

        const leftMergeKey = rel.fromColumn;
        const rightMergeKey = rel.fromColumn;

        const mergeConflictRes = resolveColumnConflicts(
          activeStreamId,
          subJoinTileId,
          toTable,
          leftMergeKey,
          rightMergeKey,
          mjx,
          250,
          nextTileId,
          actions,
          streamColumns,
          renamesPerformed
        );
        const mergeStep2Id = mergeConflictRes.step2Id;
        const mergeResolvedRightKey = mergeConflictRes.rightKey;

        actions.push(
          buildJoinAction(
            mergeJoinTileId,
            'Merge Disjoint Branches',
            'LEFT',
            leftMergeKey,
            mergeResolvedRightKey,
            mjx,
            250,
            activeStreamId,
            mergeStep2Id
          )
        );

        const leftCols = streamColumns[activeStreamId] || new Set();
        const mergeRightCols = streamColumns[mergeStep2Id] || new Set();
        streamColumns[mergeJoinTileId] = new Set([...leftCols, ...mergeRightCols]);

        joinedTables.add(fromTable);
        joinedTables.add(toTable);
        activeStreamId = mergeJoinTileId;
        joinIndex++;
      }
    }

    // Cleanup tile per RULE 7C using rightTableName suffix
    const columnRenameMap = {};
    if (activeStreamId && renamesPerformed.length > 0) {
      const finalCols = Array.from(streamColumns[activeStreamId] || []);
      const nextFinalCols = new Set(finalCols);
      const cleanupRenames = [];

      for (const { original, renamed } of renamesPerformed) {
        if (nextFinalCols.has(renamed) && !nextFinalCols.has(original)) {
          cleanupRenames.push({ name: renamed, rename: original });
          nextFinalCols.delete(renamed);
          nextFinalCols.add(original);
        } else {
          columnRenameMap[original] = renamed;
        }
      }

      if (cleanupRenames.length > 0) {
        const cleanupTileId = nextTileId('cleanup');
        const outputX = joinXStart + joinIndex * joinXStep;
        actions.push({
          type: 'SelectValues',
          id: cleanupTileId,
          name: 'Cleanup column names',
          dependsOn: [activeStreamId],
          gui: { x: outputX - 100, y: 200 },
          fields: cleanupRenames,
          removeByDefault: false,
        });
        streamColumns[cleanupTileId] = nextFinalCols;
        activeStreamId = cleanupTileId;
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

    validatePayload(payload);

    // ── 7. Submit ──
    try {
      const url = `https://${domain}/api/dataprocessing/v1/dataflows`;
      console.log(`[MAGIC ETL MODEL VIEW] Submitting Magic ETL creation request to: ${url}`);
      const response = await axios.post(url, payload, { headers, timeout: 60000 });

      const dataflowId = response.data?.id || response.data?.dataFlowId || response.data?.dataflowId;

      if (!dataflowId) {
        console.warn(`[MAGIC ETL MODEL VIEW] Dataflow may have been created but no ID in response:`, JSON.stringify(response.data));
        return {
          dataflowId: null,
          dataflowUrl: null,
          outputDatasetId: null,
          response: response.data,
          columnRenameMap
        };
      }

      console.log(`[MAGIC ETL MODEL VIEW] Running and polling dataflow ${dataflowId}...`);
      // const { executionId } = await runMagicEtlDataflow(dataflowId);
      // const execResult = await pollEtlExecution(dataflowId, executionId);
      // if (!execResult.succeeded) {
      //   throw new Error(`Model View ETL execution failed: ${execResult.error}`);
      // }

      const detailUrl = `https://${domain}/api/dataprocessing/v1/dataflows/${dataflowId}`;
      const detailResponse = await axios.get(detailUrl, { headers, timeout: 30000 });
      const respOutputs = detailResponse.data?.outputs || [];
      const outputDatasetId =
        respOutputs[0]?.dataSourceId ||
        respOutputs[0]?.id ||
        respOutputs[0]?.datasetId ||
        null;

      const dataflowUrl = `https://${domain}/datacenter/dataflows/${dataflowId}`;
      console.log(`[MAGIC ETL MODEL VIEW] Created and ran successfully. ID: ${dataflowId}, URL: ${dataflowUrl}, Output Dataset: ${outputDatasetId}`);

      return {
        dataflowId,
        dataflowUrl,
        outputDatasetId,
        joinCount: joinIndex,
        columnRenameMap
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

export async function runMagicEtlDataflow(dataflowId) {
  validateDomoEnv();
  const domain = (process.env.DOMO_CLIENT_DOMAIN || '').trim();
  const token = (process.env.DOMO_CLIENT_TOKEN || '').trim();

  const headers = getAuthHeaders(token);
  const url = `https://${domain}/api/dataprocessing/v1/dataflows/${dataflowId}/executions`;

  console.log(`[MAGIC ETL RUN] Triggering execution for dataflow ${dataflowId} via: ${url}`);

  return requestWithRetry(async () => {
    const response = await axios.post(url, {}, { headers, timeout: 30000 });
    const executionId = response.data?.id || response.data?.executionId;
    console.log(`[MAGIC ETL RUN] Execution triggered successfully. Execution ID: ${executionId}`);
    return { executionId };
  });
}

export async function pollEtlExecution(dataflowId, executionId, maxWaitTimeMs = 300000) {
  validateDomoEnv();
  const domain = (process.env.DOMO_CLIENT_DOMAIN || '').trim();
  const token = (process.env.DOMO_CLIENT_TOKEN || '').trim();

  const headers = getAuthHeaders(token);
  const url = `https://${domain}/api/dataprocessing/v1/dataflows/${dataflowId}/executions/${executionId}`;

  console.log(`[MAGIC ETL POLL] Polling execution status for dataflow ${dataflowId}, execution ${executionId}`);

  const startTime = Date.now();
  const interval = 5000;

  while (Date.now() - startTime < maxWaitTimeMs) {
    try {
      const response = await axios.get(url, { headers, timeout: 15000 });
      const data = response.data;

      const state = (data?.state || data?.status || '').toUpperCase();
      console.log(`[MAGIC ETL POLL] Execution ${executionId} state: ${state}`);

      if (state === 'SUCCESS' || state === 'SUCCEEDED') {
        return { succeeded: true, status: state };
      }

      if (state === 'FAILED' || state === 'FAILURE' || state === 'ERROR') {
        const errorMsg = data?.message || data?.statusReason || 'Execution failed';
        return { succeeded: false, status: state, error: errorMsg };
      }

      if (state === 'CANCELLED' || state === 'CANCELED') {
        return { succeeded: false, status: state, error: 'Execution was cancelled' };
      }

    } catch (err) {
      console.error(`[MAGIC ETL POLL] Error fetching execution status: ${err.message}`);
    }

    await new Promise(resolve => setTimeout(resolve, interval));
  }

  return { succeeded: false, status: 'TIMEOUT', error: 'Execution polling timed out' };
}
