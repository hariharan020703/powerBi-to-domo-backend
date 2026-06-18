import axios from 'axios';

function getAuthHeaders(token) {
  return {
    'Content-Type': 'application/json',
    'X-DOMO-DEVELOPER-TOKEN': token,
  };
}

// ─── Unique ID Generator ──────────────────────────────────────────────────────
let _tileCounter = 0;
function nextTileId(prefix) {
  return `${prefix}-${++_tileCounter}`;
}
function resetTileCounter() {
  _tileCounter = 0;
}

// ─── GUI Helpers ──────────────────────────────────────────────────────────────

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
 * Build a JoinAction tile.
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

// ─── Step Mapper ──────────────────────────────────────────────────────────────

/**
 * Maps a parsed ETL step (actionType + properties) into a valid Domo action object.
 * Every action includes: type, id, name, settings, gui
 */
function mapStepToDomoAction(step, tileId, x, y) {
  const base = {
    id: tileId,
    name: step.stepName || step.description || `Step ${tileId}`,
    gui: makeActionGui(x, y),
  };

  switch (step.actionType) {
    case 'FILTER':
      return {
        ...base,
        type: 'FilterAction',
        settings: {
          filterCondition: step.properties.condition || '',
        },
      };

    case 'SELECT_COLUMNS':
      return {
        ...base,
        type: 'SelectColumnsAction',
        settings: {
          columns: step.properties.columns || [],
        },
      };

    case 'REMOVE_COLUMNS':
      return {
        ...base,
        type: 'RemoveColumnsAction',
        settings: {
          columns: step.properties.columns || [],
        },
      };

    case 'RENAME_COLUMNS':
      return {
        ...base,
        type: 'RenameColumnsAction',
        settings: {
          renames: step.properties.renames || [],
        },
      };

    case 'SET_COLUMN_TYPE':
      return {
        ...base,
        type: 'SetColumnTypeAction',
        settings: {
          columnTypes: step.properties.columns || [],
        },
      };

    case 'ADD_FORMULA':
      return {
        ...base,
        type: 'AddFormulaAction',
        settings: {
          columnName: step.properties.columnName || '',
          formula: step.properties.formula || '',
        },
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
        type: 'GroupByAction',
        settings: {
          groupByColumns: step.properties.groupByColumns || [],
          aggregations: step.properties.aggregations || [],
        },
      };

    case 'SORT':
      return {
        ...base,
        type: 'SortAction',
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
        type: 'JoinAction',
        settings: {
          joinType: step.properties.joinType || 'INNER',
          leftKey: Array.isArray(step.properties.leftKey) ? step.properties.leftKey : [step.properties.leftKey || ''],
          rightKey: Array.isArray(step.properties.rightKey) ? step.properties.rightKey : [step.properties.rightKey || ''],
        },
      };

    case 'APPEND_ROWS':
      return {
        ...base,
        type: 'AppendAction',
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

    case 'NUMBER_FORMAT':
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
  const domain = (process.env.DOMO_CLIENT_DOMAIN || '').trim();
  const token = (process.env.DOMO_CLIENT_TOKEN || '').trim();

  if (!domain || !token) {
    throw new Error('Domo domain or developer token environment variables are not set.');
  }

  if (dataflowDefinition.skipped) {
    console.log(`[MAGIC ETL] Skipping table '${dataflowDefinition.tableName}': ${dataflowDefinition.skipReason}`);
    return null;
  }

  const headers = getAuthHeaders(token);
  resetTileCounter();

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
    const domoAction = mapStepToDomoAction(step, tileId, x, y);
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
    buildOutputAction(outputTileId, dataflowDefinition.outputDatasetName, outputX, 100)
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

/**
 * Creates a Magic ETL dataflow in Domo representing the Model View (joined relationships).
 *
 * @param {string} reportName - Power BI report name
 * @param {Array}  resolvedRels - Resolved relationships from resolveRelationships()
 * @param {object} tableToDatasetId - Map of tableName -> domoDatasetId
 * @returns {Promise<object>} Created dataflow info
 */
export async function createModelViewMagicEtl(reportName, resolvedRels, tableToDatasetId) {
  const domain = (process.env.DOMO_CLIENT_DOMAIN || '').trim();
  const token = (process.env.DOMO_CLIENT_TOKEN || '').trim();

  if (!domain || !token) {
    throw new Error('Domo domain or developer token environment variables are not set.');
  }

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
  resetTileCounter();

  // ── 1. Input Tiles (LoadFromVault) ──
  const actions = [];
  const tableToTileId = {};

  uniqueTables.forEach((tableName, index) => {
    const tileId = nextTileId('input');
    tableToTileId[tableName] = tileId;
    actions.push(
      buildLoadAction(tileId, tableName, tableToDatasetId[tableName], 100, 100 + index * 120)
    );
  });

  // ── 2. Join Tiles (MergeJoin) ──
  const joinedTables = new Set();
  const remainingRels = [...validRels];
  let joinIndex = 0;
  let activeStreamId = null;
  const joinXStart = 300;
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

      if (joinedTables.size === 0) {
        joinName = `Join ${fromTable} & ${toTable}`;
        joinedTables.add(fromTable);
        joinedTables.add(toTable);
      } else if (joinedTables.has(fromTable)) {
        joinName = `Join ${toTable} to Model`;
        joinedTables.add(toTable);
      } else {
        joinName = `Join ${fromTable} to Model`;
        joinedTables.add(fromTable);
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

      // ── CHANGED: use activeStreamId for chained joins ──
      const isFirstJoin = activeStreamId === null;
      const step1Id = isFirstJoin ? tableToTileId[fromTable] : activeStreamId;
      const step2Id = isFirstJoin
        ? tableToTileId[toTable]
        : joinedTables.has(fromTable)
          ? tableToTileId[toTable]
          : tableToTileId[fromTable];

      actions.push(
        buildJoinAction(joinTileId, joinName, joinType, rel.fromColumn, rel.toColumn, jx, jy, step1Id, step2Id)
      );

      activeStreamId = joinTileId;
      joinIndex++;

    } else {
      // Disconnected graph fallback
      const rel = remainingRels.shift();
      const fromTable = rel.fromTable;
      const toTable = rel.toTable;

      const subJoinTileId = nextTileId('join-sub');
      const sjx = joinXStart + joinIndex * joinXStep;
      actions.push(
        buildJoinAction(
          subJoinTileId,
          `Join ${fromTable} & ${toTable} (Sub-branch)`,
          'INNER',
          rel.fromColumn,
          rel.toColumn,
          sjx,
          350,
          tableToTileId[fromTable],  // ← step1Id
          tableToTileId[toTable]     // ← step2Id
        )
      );
      joinIndex++;

      const mergeJoinTileId = nextTileId('join-merge');
      const mjx = joinXStart + joinIndex * joinXStep;
      actions.push(
        buildJoinAction(
          mergeJoinTileId,
          'Merge Disjoint Branches',
          'LEFT',
          rel.fromColumn,
          rel.fromColumn,
          mjx,
          250,
          activeStreamId,   // ← step1Id (main stream)
          subJoinTileId     // ← step2Id (sub-branch)
        )
      );

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
    buildOutputAction(outputTileId, outputDatasetName, outputX, 200, activeStreamId) // ← activeStreamId added
  );

  // ── 4. Build inputs / outputs ──
  const inputs = uniqueTables.map(tableName => ({
    dataSourceId: tableToDatasetId[tableName],   // ← was datasetId
    dataSourceName: tableName,                    // ← was datasetName
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

  console.log(`[MAGIC ETL MODEL VIEW] Creating dataflow '${dataflowName}' with ${actions.length} action(s)...`);
  console.log(`[MAGIC ETL MODEL VIEW] Payload:`, JSON.stringify(payload, null, 2));

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
}
