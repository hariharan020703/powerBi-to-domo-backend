import axios from 'axios';
import { runMagicEtlDataflow, pollEtlExecution, fetchDatasetColumns } from './magicEtlService.js';

// ─── Constants ──────────────────────────────────────────────────────────────
const _modelViewInFlight = new Map();

// ─── Helpers (Copied from magicEtlService.js for compatibility) ──────────────
function validateDomoEnv() {
  const missing = ['DOMO_CLIENT_DOMAIN', 'DOMO_CLIENT_TOKEN'].filter(
    k => !process.env[k]?.trim()
  );
  if (missing.length > 0) {
    throw new Error(`Missing required Domo environment variables: ${missing.join(', ')}`);
  }
}

function getAuthHeaders(token) {
  return {
    'Content-Type': 'application/json',
    'X-DOMO-DEVELOPER-TOKEN': token,
  };
}

function createTileIdGenerator() {
  let count = 0;
  return (prefix) => `${prefix}-${++count}`;
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

// ─── System Prompt ──────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are an expert data migration system specializing in converting Power BI table relationships into an optimized sequential join execution plan in Domo Magic ETL.

═══════════════════════════════════════════════════════
OPTIMIZATION RULES
═══════════════════════════════════════════════════════
1. START WITH THE HUB TABLE:
   - Identify the table with the highest number of relationships (the "hub" table) and start the join sequence with it.
2. BUILD OUTWARD:
   - Order the joins such that each subsequent join connects a new table to the already-joined stream.
3. DISCONNECTED SUBGRAPHS:
   - If there are disconnected subgraphs, start a new branch (with "isFirstJoin": true) for that subgraph.
   - Join the subgraphs together at the end of the sequence (e.g. merge the active stream and the sub-branch).
4. MAP CARDINALITY & CROSSFILTER TO DOMO JOIN TYPES:
   - If crossFilter === 'BothDirections', map to 'LEFT OUTER'.
   - If crossFilter === 'OneDirection' AND fromCardinality === 'One', map to 'LEFT OUTER'.
   - If crossFilter === 'OneDirection' AND fromCardinality === 'Many', map to 'INNER'.

═══════════════════════════════════════════════════════
REQUIRED JSON SCHEMA OUTPUT
═══════════════════════════════════════════════════════
Return a JSON object containing a "joinSequence" array. Example:
{
  "joinSequence": [
    {
      "joinName": "Join Orders & Customers",
      "joinType": "LEFT OUTER",
      "leftTable": "Orders",
      "rightTable": "Customers",
      "leftKey": "CustomerID",
      "rightKey": "CustomerID",
      "isFirstJoin": true
    },
    {
      "joinName": "Join Orders & Products",
      "joinType": "INNER",
      "leftTable": "Orders",
      "rightTable": "Products",
      "leftKey": "ProductID",
      "rightKey": "ProductID",
      "isFirstJoin": false
    }
  ]
}

Only return raw JSON. Do not include markdown code blocks or explanations.`;

// ─── Main Service Function ──────────────────────────────────────────────────
export async function convertRelationshipsToJoinPlan(resolvedRelationships, tableToDatasetId) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.error('[REL SERVICE] GROQ_API_KEY is not defined in environment variables.');
    throw new Error('Missing GROQ_API_KEY environment variable');
  }

  const userMessage = `Generate an ordered join execution plan for these resolved relationships.
  
Resolved Relationships:
${JSON.stringify(resolvedRelationships, null, 2)}

Table to Domo Dataset ID Map:
${JSON.stringify(tableToDatasetId, null, 2)}`;

  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`[REL SERVICE] Groq conversion attempt ${attempt}/3 for relationships...`);

      const response = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          model: process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userMessage }
          ],
          response_format: { type: 'json_object' },
          temperature: 0.1
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          timeout: 60000
        }
      );

      const responseContent = response.data?.choices?.[0]?.message?.content;
      if (!responseContent) {
        throw new Error('Received empty content from Groq API.');
      }

      let parsedJson;
      try {
        parsedJson = JSON.parse(responseContent);
      } catch (jsonErr) {
        throw new Error(`Your response was not valid JSON. Return ONLY a JSON object. Error: ${jsonErr.message}`);
      }

      if (!parsedJson || !Array.isArray(parsedJson.joinSequence)) {
        throw new Error('Grok response must contain a "joinSequence" array.');
      }

      // Check structures
      parsedJson.joinSequence.forEach((step, idx) => {
        if (!step.leftTable || !step.rightTable || !step.leftKey || !step.rightKey) {
          throw new Error(`Join sequence step at index ${idx} is missing required fields (leftTable, rightTable, leftKey, rightKey).`);
        }
      });

      console.log(`[REL SERVICE] Groq successfully returned join plan with ${parsedJson.joinSequence.length} steps.`);
      return parsedJson;

    } catch (err) {
      lastError = err.message;
      const status = err.response?.status;
      const responseData = err.response?.data;
      const responseMsg = responseData?.error?.message || '';
      console.warn(`[REL SERVICE] Attempt ${attempt}/3 failed (HTTP status: ${status}): ${lastError}. Details: ${responseMsg}`);

      if (attempt < 3) {
        let delay = Math.pow(2, attempt) * 1000;
        if (status === 429) {
          if (attempt === 1) delay = 5000;
          else if (attempt === 2) delay = 15000;
        }
        console.log(`[REL SERVICE] Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  console.error(`[REL SERVICE] All 3 attempts exhausted. Throwing error.`);
  throw new Error(`Groq relationship join plan conversion failed after 3 attempts. Last error: ${lastError}`);
}

// ─── Custom createModelViewMagicEtl ──────────────────────────────────────────
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

    // ── 2. Join Tiles (MergeJoin) via Groq join sequence plan ──
    const plan = await convertRelationshipsToJoinPlan(validRels, tableToDatasetId);
    if (!plan || !Array.isArray(plan.joinSequence) || plan.joinSequence.length === 0) {
      throw new Error('Grok failed to generate a valid join plan.');
    }

    const streamColumns = {};
    uniqueTables.forEach(tableName => {
      const tileId = tableToTileId[tableName];
      streamColumns[tileId] = new Set(tableToColumns[tableName] || []);
    });

    let activeStreamId = null;
    let joinIndex = 0;
    const joinXStart = 450;
    const joinXStep = 200;
    const renamesPerformed = [];

    for (const step of plan.joinSequence) {
      const { joinName, joinType, leftTable, rightTable, leftKey, rightKey } = step;

      const leftTileId = tableToTileId[leftTable];
      const rightTileId = tableToTileId[rightTable];

      if (!leftTileId) {
        throw new Error(`Left table "${leftTable}" in join step is not in the dataflow or has not been loaded.`);
      }
      if (!rightTileId) {
        throw new Error(`Right table "${rightTable}" in join step is not in the dataflow or has not been loaded.`);
      }

      const joinTileId = nextTileId('join');
      const jx = joinXStart + joinIndex * joinXStep;
      const jy = 150 + joinIndex * 50;

      // Conflict detection per RULE 3A
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

      let step2Id = rightTileId;
      let resolvedRightKey = rightKey;
      if (conflicts.length > 0) {
        const dedupTileId = nextTileId('dedup');
        const renamingFields = conflicts.map(col => ({
          name: col,
          rename: col + '_right'
        }));

        actions.push({
          type: 'SelectValues',
          id: dedupTileId,
          name: `Rename conflicting columns in ${rightTable}`,
          dependsOn: [rightTileId],
          gui: { x: jx - 50, y: jy + 100 },
          fields: renamingFields,
          removeByDefault: false
        });

        conflicts.forEach(col => {
          renamesPerformed.push({ original: col, renamed: col + '_right' });
        });

        const renamedRightCols = new Set();
        for (const col of rightCols) {
          if (conflicts.includes(col)) {
            renamedRightCols.add(col + '_right');
          } else {
            renamedRightCols.add(col);
          }
        }
        streamColumns[dedupTileId] = renamedRightCols;
        step2Id = dedupTileId;

        // Map right join keys if they are resolved as conflicts
        const updatedRightKey = (Array.isArray(rightKey) ? rightKey : [rightKey]).map(key => {
          const keyTrimmed = key.trim();
          const keyLower = keyTrimmed.toLowerCase();
          const conflictCol = conflicts.find(c => c.toLowerCase() === keyLower);
          if (conflictCol) {
            return conflictCol + '_right';
          }
          return keyTrimmed;
        });
        resolvedRightKey = Array.isArray(rightKey) ? updatedRightKey : updatedRightKey[0];
      }

      actions.push(
        buildJoinAction(
          joinTileId,
          joinName || `Join ${leftTable} & ${rightTable}`,
          joinType || 'INNER',
          leftKey,
          resolvedRightKey,
          jx,
          jy,
          leftTileId,
          step2Id
        )
      );

      const rightColsForJoin = streamColumns[step2Id] || new Set();
      streamColumns[joinTileId] = new Set([...leftCols, ...rightColsForJoin]);

      // Crucial: Update active tile for both tables (and any tables that were already joined with them!)
      for (const table of uniqueTables) {
        if (tableToTileId[table] === leftTileId || tableToTileId[table] === rightTileId) {
          tableToTileId[table] = joinTileId;
        }
      }

      activeStreamId = joinTileId;
      joinIndex++;
    }

    // Cleanup tile per RULE 7C equivalent for _right suffix
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

    // ── 6. Validate before submission ──
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

      // Run and poll the dataflow
      // console.log(`[MAGIC ETL MODEL VIEW] Running and polling dataflow ${dataflowId}...`);
      // const { executionId } = await runMagicEtlDataflow(dataflowId);
      // const execResult = await pollEtlExecution(dataflowId, executionId);
      // if (!execResult.succeeded) {
      //   throw new Error(`Model View ETL execution failed: ${execResult.error}`);
      // }

      // Fetch details to extract outputDatasetId
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
