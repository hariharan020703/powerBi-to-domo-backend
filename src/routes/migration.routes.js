import { Router } from 'express';
import { EventEmitter } from 'events';
import axios from 'axios';
import { executeQuery, getDashboardTiles, getDatasetTables, getTableData, getDatasetRelationships, getDatasetColumns, getDatasetTableMeta, getPowerQueryExpressions, getDatasetMeasures } from '../services/powerbiService.js';
import { createDomoDataset, uploadDataToDomoDataset } from '../services/domoDatasetService.js';
import { resolveRelationships, createDomoDataModel, fetchDomoDatasetSchema } from '../services/domoDataflowService.js';
import { parsePowerQuerySteps, buildDataflowDefinition } from '../services/powerQueryParser.js';
import { createMagicEtlDataflow, createModelViewMagicEtl, runMagicEtlDataflow, pollEtlExecution } from '../services/magicEtlService.js';
import { classifyDaxMeasure, inferBeastModeDataType, detectAggregated, extractNonAggregatedColumns, buildMeasureDependencyGraph, detectCycles, topologicalSortMeasures, substituteDependencies, sanitizeBeastModeFormula } from '../services/beastModeCompat.js';
import { convertDaxToBeastModeGrok, resetDaxRateLimit } from '../services/groqDaxService.js';
import { resetPqRateLimit } from '../services/groqPowerQueryService.js';
import { createBeastModeFunctionsBulk, extractBulkCreatedIds, fetchCurrentUserId, createBeastModeFunction } from '../services/beastModeService.js';
import { createDomoCard, createDomoPage, addCardsToPage } from '../services/domoCardService.js';

const router = Router();
const migrationEmitter = new EventEmitter();

// In-memory database of migration statuses keyed by reportId
const migrations = new Map();

// In-memory set of completed Model Views keyed by reportId
const completedModelViews = new Set();

// In-memory mapping of active migrations keyed by reportId
const _migrationInFlight = new Map();

// In-memory set of cancellation tokens for migrations in progress
const cancellationTokens = new Set();

function checkCancellation(reportId, results) {
  if (cancellationTokens.has(reportId)) {
    const err = new Error('Migration cancelled by user.');
    err.status = 400;
    err.migratedTables = results;
    throw err;
  }
}

/**
 * Utility helper to update status and notify SSE listeners.
 */
function updateStatus(reportId, state) {
  const timestamp = new Date().toISOString();
  const updatedState = { ...state, timestamp };
  migrations.set(reportId, updatedState);
  migrationEmitter.emit(reportId, updatedState);
  console.log(`[MIGRATION LOG] [${timestamp}] ReportID: ${reportId} Status: ${state.status} progress: ${state.progress || 0}`);
}

/**
 * Cleans a raw PowerBI column name like "[TableName].[ColumnName]" or "TableName[ColumnName]"
 * into a plain "ColumnName" string safe for CSV headers.
 */
function cleanColumnName(rawName) {
  // Strip surrounding brackets e.g. [MyTable].[MyColumn]
  let name = String(rawName || '').trim();
  // Handle format: TableName[Column] or 'TableName'[Column]
  const bracketMatch = name.match(/\[([^\]]+)\]$/);
  if (bracketMatch) {
    return bracketMatch[1];
  }
  // Handle format with dots: TableName.ColumnName
  const dotParts = name.split('.');
  if (dotParts.length > 1) {
    return dotParts[dotParts.length - 1].replace(/[\[\]']/g, '');
  }
  return name.replace(/[\[\]']/g, '');
}

/**
 * Detects the Domo column type from a sample of row values.
 * Returns 'LONG', 'DOUBLE', 'DATETIME', 'DATE', or 'STRING'.
 */
function detectColumnType(values) {
  const nonNull = values.filter(v => v !== null && v !== undefined && v !== '');
  if (!nonNull.length) return 'STRING';

  let allLong = true;
  let allDouble = true;
  let allDate = true;
  let allDatetime = true;

  for (const v of nonNull) {
    const s = String(v).trim();
    if (allLong && !/^-?\d+$/.test(s)) allLong = false;
    if (allDouble && !/^-?\d+(\.\d+)?$/.test(s)) allDouble = false;
    if (allDate && !/^\d{4}-\d{2}-\d{2}$/.test(s)) allDate = false;
    if (allDatetime && !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s)) allDatetime = false;
  }

  if (allLong) return 'LONG';
  if (allDouble) return 'DOUBLE';
  if (allDatetime) return 'DATETIME';
  if (allDate) return 'DATE';
  return 'STRING';
}

/**
 * Converts PowerBI result rows into a clean CSV string.
 * Returns { csvString, columns } where columns = [{name, type}]
 */
function buildCsv(rawRows, rawColumnNames) {
  const cleanNames = rawColumnNames.map(cleanColumnName);

  // Collect sample values per column to detect types
  const sampleValues = cleanNames.map(() => []);
  for (const row of rawRows.slice(0, 50)) {
    const vals = Object.values(row);
    vals.forEach((v, i) => {
      if (sampleValues[i]) sampleValues[i].push(v);
    });
  }
  const types = sampleValues.map(detectColumnType);
  const columns = cleanNames.map((name, i) => ({ name, type: types[i] }));

  // Build CSV
  const escape = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  const header = cleanNames.map(escape).join(',');
  const dataLines = rawRows.map(row => Object.values(row).map(escape).join(','));
  const csvString = [header, ...dataLines].join('\n');

  return { csvString, columns };
}

// REPLACE WITH:
function getTrivialFormula(expression) {
  const trimmed = expression.trim();

  if (/^\d+(\.\d+)?$/.test(trimmed)) return trimmed;

  const countMatch = trimmed.match(/^COUNT\s*\(\s*'[^']*'\s*\[([^\]]+)\]\s*\)\s*\+\s*0$/i);
  if (countMatch) return `IFNULL(COUNT(\`${countMatch[1]}\`), 0)`;

  const countNoPlus = trimmed.match(/^COUNT\s*\(\s*'[^']*'\s*\[([^\]]+)\]\s*\)$/i);
  if (countNoPlus) return `IFNULL(COUNT(\`${countNoPlus[1]}\`), 0)`;

  const sumMatch = trimmed.match(/^SUM\s*\(\s*'[^']*'\s*\[([^\]]+)\]\s*\)\s*\+\s*0$/i);
  if (sumMatch) return `IFNULL(SUM(\`${sumMatch[1]}\`), 0)`;

  const sumNoPlus = trimmed.match(/^SUM\s*\(\s*'[^']*'\s*\[([^\]]+)\]\s*\)$/i);
  if (sumNoPlus) return `IFNULL(SUM(\`${sumNoPlus[1]}\`), 0)`;

  const avgMatch = trimmed.match(/^AVERAGE\s*\(\s*'[^']*'\s*\[([^\]]+)\]\s*\)$/i);
  if (avgMatch) return `AVG(\`${avgMatch[1]}\`)`;

  const minMatch = trimmed.match(/^MIN\s*\(\s*'[^']*'\s*\[([^\]]+)\]\s*\)$/i);
  if (minMatch) return `MIN(\`${minMatch[1]}\`)`;

  const maxMatch = trimmed.match(/^MAX\s*\(\s*'[^']*'\s*\[([^\]]+)\]\s*\)$/i);
  if (maxMatch) return `MAX(\`${maxMatch[1]}\`)`;

  return null;
}

/**
 * Orchestrates Beast Mode migration for a single dataset's measures.
 *
 * Pipeline: classify → LLM convert (DIRECT only) → bulk create → return enriched results.
 *
 * @param {Array<{name: string, expression: string}>} measures - DAX measures from getDatasetMeasures()
 * @param {string} domoDatasetId - Target Domo dataset ID
 * @param {string[]} availableColumns - Column names on the Domo dataset
 * @param {string} reportId - For SSE status updates
 * @param {function} updateStatusFn - updateStatus(reportId, state)
 * @param {Array} currentResults - Current migratedTables array (for status updates)
 * @returns {Promise<{results: Array, summary: {created: number, failed: number, manual: number, unsupported: number}}>}
 */
async function migrateMeasuresToBeastModes(measures, domoDatasetId, availableColumns, reportId, updateStatusFn, currentResults) {
  const domain = (process.env.DOMO_CLIENT_DOMAIN || '').trim();
  const token = (process.env.DOMO_CLIENT_TOKEN || '').trim();

  let ownerId = null;
  if (domain && token) {
    try {
      ownerId = await fetchCurrentUserId(domain, token);
    } catch (ownerErr) {
      console.warn(`[BEAST MODE] Could not resolve owner ID from token: ${ownerErr.message}. Beast Modes will be classified but not created.`);
    }
  }

  // 1. Deduplicate incoming measures by name in-memory
  const seenNames = new Set();
  const uniqueInputMeasures = [];
  for (const m of measures) {
    const name = m.name?.trim();
    if (!name) continue;
    if (!seenNames.has(name)) {
      seenNames.add(name);
      uniqueInputMeasures.push(m);
    } else {
      console.log(`[BEAST MODE] Ignoring duplicate measure name in input list: '${name}'`);
    }
  }

  // Retrieve already migrated measures to avoid recreating duplicates
  const previousState = migrations.get(reportId);
  const previousMeasures = previousState?.migratedMeasures || [];

  // 2. Build dependency graph
  const graph = buildMeasureDependencyGraph(uniqueInputMeasures);

  // 3. Detect cycles
  const cyclicMeasures = detectCycles(graph);

  const enrichedMeasures = [];
  const convertedFormulasMap = new Map(); // measureName -> successfully converted formula text
  const readyForDomoMeasures = []; // ready for Domo API bulk create
  const summary = { created: 0, failed: 0, manual: 0, unsupported: 0 };

  // 4. Pre-process cyclic measures: route straight to MANUAL_BUILD
  for (const mName of cyclicMeasures) {
    const measure = uniqueInputMeasures.find(m => m.name === mName);
    enrichedMeasures.push({
      name: mName,
      daxExpression: measure?.expression || '',
      classification: 'MANUAL_BUILD',
      beastModeFormula: null,
      status: 'needs_manual_review',
      domoFunctionId: null,
      error: 'Circular measure dependency',
    });
    summary.manual++;
    // Break edges in the graph
    graph.delete(mName);
    for (const deps of graph.values()) {
      deps.delete(mName);
    }
  }

  // 5. Run topological sort on the remaining non-cyclic measures
  const topoOrder = topologicalSortMeasures(uniqueInputMeasures, graph);

  // 6. Process measures in topological order
  for (const mName of topoOrder) {
    const measure = uniqueInputMeasures.find(m => m.name === mName);
    if (!measure) continue;

    // Check if it was already created/converted in a previous run
    const existingMeasure = previousMeasures.find(
      pm => pm.name === mName && (pm.status === 'created' || pm.status === 'converted' || pm.status === 'converted_not_created')
    );

    if (existingMeasure) {
      console.log(`[BEAST MODE] Reusing previously migrated state for measure '${mName}' (status: ${existingMeasure.status})`);
      enrichedMeasures.push({ ...existingMeasure });
      if (existingMeasure.beastModeFormula) {
        convertedFormulasMap.set(mName, existingMeasure.beastModeFormula);
      }
      if (existingMeasure.status === 'created') {
        summary.created++;
      } else {
        // If it was converted but not created, we can queue it for creation now
        readyForDomoMeasures.push({
          name: mName,
          expression: existingMeasure.beastModeFormula,
          dataType: inferBeastModeDataType(existingMeasure.beastModeFormula),
          aggregated: detectAggregated(existingMeasure.beastModeFormula),
          nonAggregatedColumns: extractNonAggregatedColumns(existingMeasure.beastModeFormula),
          domoDatasetId,
        });
      }
      continue;
    }

    if (!measure.expression || measure.expression.trim().length === 0) {
      enrichedMeasures.push({
        name: mName,
        daxExpression: '',
        classification: 'MANUAL_BUILD',
        beastModeFormula: null,
        status: 'needs_manual_review',
        domoFunctionId: null,
        error: 'Empty DAX expression',
      });
      summary.manual++;
      continue;
    }

    const deps = graph.get(mName) || new Set();
    let failedDep = null;
    for (const dep of deps) {
      if (!convertedFormulasMap.has(dep)) {
        failedDep = dep;
        break;
      }
    }

    if (failedDep) {
      const errMsg = `Depends on measure '${failedDep}' which could not be converted to Beast Mode`;
      enrichedMeasures.push({
        name: mName,
        daxExpression: measure.expression,
        classification: 'MANUAL_BUILD',
        beastModeFormula: null,
        status: 'needs_manual_review',
        domoFunctionId: null,
        error: errMsg,
      });
      summary.manual++;
      continue;
    }

    // Inline substitute converted dependencies
    const targetDax = substituteDependencies(measure.expression, convertedFormulasMap);

    const trivialFormula = getTrivialFormula(targetDax);
    if (trivialFormula) {
      console.log(`[BEAST MODE] Skipping LLM for trivial measure '${mName}': ${trivialFormula}`);
      convertedFormulasMap.set(mName, trivialFormula);
      enrichedMeasures.push({
        name: mName,
        daxExpression: measure.expression,
        classification: 'DIRECT_BEASTMODE',
        beastModeFormula: trivialFormula,
        status: 'converted',
        domoFunctionId: null,
        error: null,
      });
      readyForDomoMeasures.push({
        name: mName,
        expression: trivialFormula,
        dataType: inferBeastModeDataType(trivialFormula),
        aggregated: detectAggregated(trivialFormula),
        nonAggregatedColumns: extractNonAggregatedColumns(trivialFormula),
        domoDatasetId,
      });
      continue;
    }

    // Classify the substituted expression to keep track of its logic type
    const { classification, reason } = classifyDaxMeasure(mName, targetDax, false);
    console.log(`[BEAST MODE] Processing '${mName}' (Classified: ${classification}${reason ? ': ' + reason : ''})`);

    // Call LLM conversion for all measures
    try {
      const result = await convertDaxToBeastModeGrok(mName, targetDax, availableColumns);

      if (result.status === 'converted') {
        convertedFormulasMap.set(mName, result.formula);
        enrichedMeasures.push({
          name: mName,
          daxExpression: measure.expression,
          classification,
          beastModeFormula: result.formula,
          status: 'converted',
          domoFunctionId: null,
          error: null,
        });
        readyForDomoMeasures.push({
          name: mName,
          expression: result.formula,
          dataType: inferBeastModeDataType(result.formula),
          aggregated: detectAggregated(result.formula),
          nonAggregatedColumns: extractNonAggregatedColumns(result.formula),
          domoDatasetId,
        });
      } else if (result.status === 'unsupported') {
        enrichedMeasures.push({
          name: mName,
          daxExpression: measure.expression,
          classification,
          beastModeFormula: null,
          status: 'unsupported',
          domoFunctionId: null,
          error: 'LLM determined formula cannot be expressed in Beast Mode',
        });
        summary.unsupported++;
      } else {
        enrichedMeasures.push({
          name: mName,
          daxExpression: measure.expression,
          classification,
          beastModeFormula: null,
          status: 'needs_manual_review',
          domoFunctionId: null,
          error: result.error,
        });
        summary.manual++;
      }
    } catch (convErr) {
      console.error(`[BEAST MODE] Conversion error for '${mName}':`, convErr.message);
      enrichedMeasures.push({
        name: mName,
        daxExpression: measure.expression,
        classification,
        beastModeFormula: null,
        status: 'needs_manual_review',
        domoFunctionId: null,
        error: convErr.message,
      });
      summary.manual++;
    }
  }

  // 7. Sanitize formulas before sending to Domo API
  for (const m of readyForDomoMeasures) {
    m.expression = sanitizeBeastModeFormula(m.expression);
  }

  // 8. Bulk-create successful measures in Domo (Commented out bulk upload per user request; using single upload API instead)
  if (readyForDomoMeasures.length > 0 && ownerId && domain && token) {
    // try {
    //   updateStatusFn(reportId, {
    //     ...migrations.get(reportId),
    //     status: `Creating ${readyForDomoMeasures.length} Beast Mode(s) in Domo...`,
    //   });
    // 
    //   const bulkResponse = await createBeastModeFunctionsBulk(domain, token, ownerId, readyForDomoMeasures);
    //   const idMap = extractBulkCreatedIds(bulkResponse, readyForDomoMeasures.map(m => m.name));
    // 
    //   for (const cm of readyForDomoMeasures) {
    //     const enriched = enrichedMeasures.find(m => m.name === cm.name);
    //     if (enriched) {
    //       enriched.domoFunctionId = idMap.get(cm.name) || null;
    //       enriched.status = 'created';
    //       summary.created++;
    //     }
    //   }
    // 
    //   console.log(`[BEAST MODE] Bulk creation succeeded: ${readyForDomoMeasures.length} Beast Mode(s) created.`);
    // } catch (bulkErr) {
    //   console.warn(`[BEAST MODE] Bulk creation failed (${bulkErr.message}). Falling back to individual creation...`);
    for (const cm of readyForDomoMeasures) {
      const enriched = enrichedMeasures.find(m => m.name === cm.name);
      try {
        const singleResponse = await createBeastModeFunction(domain, token, ownerId, cm);
        if (enriched) {
          enriched.domoFunctionId = singleResponse?.legacyId || singleResponse?.id || singleResponse?.functionTemplateId || null;
          enriched.status = 'created';
          summary.created++;
        }
      } catch (singleErr) {
        const status = singleErr.response?.status ?? 'N/A';
        const errMsg = singleErr.response ? JSON.stringify(singleErr.response.data) : singleErr.message;
        console.error(`[BEAST MODE] Individual creation failed for '${cm.name}': HTTP ${status} - ${errMsg}`);
        if (enriched) {
          enriched.status = 'creation_failed';
          enriched.error = `Domo API error: HTTP ${status} - ${errMsg}`;
          summary.failed++;
        }
      }
    }
    // }
  } else if (readyForDomoMeasures.length > 0 && !ownerId) {
    for (const cm of readyForDomoMeasures) {
      const enriched = enrichedMeasures.find(m => m.name === cm.name);
      if (enriched) {
        enriched.status = 'converted_not_created';
        enriched.error = 'Could not resolve owner ID from Domo token — Beast Mode was converted but not created';
        summary.failed++;
      }
    }
  }

  return { results: enrichedMeasures, summary };
}

/**
 * POST /api/migration/start
 * Starts a migration run synchronously (blocks until Claude finishes, but streams logs on SSE).
 */
router.post('/start', async (req, res, next) => {
  const { reportId, reportName, datasetId, workspaceId, isDashboard } = req.body;

  resetDaxRateLimit();
  resetPqRateLimit();

  if (!reportId) {
    return res.status(400).json({
      status: 'error',
      message: 'reportId is required.'
    });
  }

  // Set timeout of 5 minutes
  req.setTimeout(300000);

  console.log(`[MIGRATION] Received start request for ${isDashboard ? 'dashboard' : 'report'} "${reportName}" (ID: ${reportId})`);

  if (_migrationInFlight.has(reportId)) {
    console.log(`[MIGRATION] Migration for report ${reportId} is already in progress. Awaiting existing run...`);
    try {
      const result = await _migrationInFlight.get(reportId);
      return res.status(200).json(result);
    } catch (err) {
      return res.status(500).json({ success: false, status: 'error', message: err.message });
    }
  }

  let results = [];
  const previousState = migrations.get(reportId);

  const setTableState = (tableName, statusObj) => {
    let existing = results.find(t => t.tableName === tableName);
    if (existing) {
      Object.assign(existing, statusObj);
    } else {
      existing = { tableName, ...statusObj };
      results.push(existing);
    }
    const currentOverall = migrations.get(reportId) || {};
    updateStatus(reportId, {
      ...currentOverall,
      migratedTables: results
    });
  };

  const migrationPromise = (async () => {

    try {
      checkCancellation(reportId, results);

      if (isDashboard) {
        // ─── DASHBOARD MIGRATION FLOW ──────────────────────────────────────────
        updateStatus(reportId, { status: 'Fetching dashboard tiles', progress: 15, migratedTables: results });

        let tilesResponse;
        try {
          tilesResponse = await getDashboardTiles(workspaceId, reportId);
        } catch (tileErr) {
          console.error(`[MIGRATION ERROR] Failed to fetch dashboard tiles:`, tileErr.message);
          const err = new Error(`Failed to fetch tiles: ${tileErr.message}`);
          err.status = 500;
          err.migratedTables = results;
          updateStatus(reportId, { status: 'error', progress: 0, message: err.message, migratedTables: results });
          throw err;
        }

        const tiles = tilesResponse?.value || [];

        const uniqueDatasets = new Map(); // datasetId -> title/report context
        for (const t of tiles) {
          if (t.datasetId) {
            uniqueDatasets.set(t.datasetId, {
              title: t.title || 'Dashboard Visual',
              reportId: t.reportId
            });
          }
        }

        if (uniqueDatasets.size === 0) {
          console.warn('[MIGRATION] No datasets found on the dashboard tiles.');
          const err = new Error('No datasets found on this dashboard.');
          err.status = 400;
          err.migratedTables = results;
          updateStatus(reportId, { status: 'error', progress: 0, message: err.message, migratedTables: results });
          throw err;
        }

        const createdCardIds = [];
        const datasetIds = Array.from(uniqueDatasets.keys());

        // Loop through unique datasets and migrate them
        for (let i = 0; i < datasetIds.length; i++) {
          checkCancellation(reportId, results);
          const targetDatasetId = datasetIds[i];
          const ctx = uniqueDatasets.get(targetDatasetId);
          const baseProgress = 20 + Math.round((i / datasetIds.length) * 60);

          updateStatus(reportId, {
            status: `Analyzing formulas/measures for dataset ${i + 1}/${datasetIds.length}`,
            progress: baseProgress,
            migratedTables: results
          });

          // 1. Analyze formulas/measures using DMV queries
          let measuresList = [];
          try {
            measuresList = await getDatasetMeasures(targetDatasetId);
          } catch (err) {
            console.error('[MEASURE ERROR]', err.message);
          }

          if (measuresList.length > 0) {
            updateStatus(reportId, {
              status: `Discovered ${measuresList.length} measures (e.g. ${measuresList[0].name})`,
              progress: baseProgress + 5,
              migratedTables: results
            });
          } else {
            console.log(`[ANALYSIS] No measures/formulas found for dataset ${targetDatasetId}.`);
          }

          // 2. Discover tables & Fetch Power BI data
          let tableName = 'Sheet1';
          try {
            const discoverQuery = 'SELECT [TABLE_NAME] FROM $SYSTEM.DBSCHEMA_TABLES';
            const discoveryResult = await executeQuery(targetDatasetId, discoverQuery);
            const rows = discoveryResult?.results?.[0]?.tables?.[0]?.rows || [];

            const userTables = rows
              .map(r => r.TABLE_NAME)
              .filter(name => {
                if (!name) return false;
                const nameLower = name.toLowerCase();
                if (nameLower.startsWith('localdatetable_') || nameLower.startsWith('datetabletemplate_')) return false;
                if (name.startsWith('$') || name.includes('$') || name.startsWith('__')) return false;
                return true;
              });
            if (userTables.length > 0) {
              tableName = userTables[0];
            }
          } catch (err) {
            console.warn(`[MIGRATION] Table discovery failed, using default 'Sheet1'`);
          }

          // Check if this dataset was already successfully migrated in a previous run
          const existingTable = previousState?.migratedTables?.find(
            t => t.powerbiDatasetId === targetDatasetId || (t.tableName === tableName && (t.status === 'success' || t.status === 'etl_created'))
          );

          let targetDomoDatasetId = null;
          let cardColumns = [];
          let magicEtlResult = null;
          let columns = [];
          let rawRows = [];
          let finalDomoDatasetId = null;

          if (existingTable && existingTable.status === 'success' && existingTable.domoDatasetId) {
            console.log(`[MIGRATION] Dashboard dataset '${targetDatasetId}' (table: '${tableName}') was already successfully migrated. Reusing dataset ID: ${existingTable.domoDatasetId}`);
            results.push(existingTable);
            targetDomoDatasetId = existingTable.domoDatasetId;
            cardColumns = existingTable.columns || [];
            magicEtlResult = existingTable.magicEtl || null;
            finalDomoDatasetId = magicEtlResult?.outputDatasetId || targetDomoDatasetId;
          } else {
            // Initialize table state in results
            let currentTableStatus = existingTable ? { ...existingTable } : { tableName, powerbiDatasetId: targetDatasetId, status: 'started' };
            if (!results.some(t => t.powerbiDatasetId === targetDatasetId)) {
              results.push(currentTableStatus);
            }

            try {
              // Fetch powerbiData if we don't have the datasetId
              if (currentTableStatus.domoDatasetId) {
                targetDomoDatasetId = currentTableStatus.domoDatasetId;
                columns = currentTableStatus.columns || [];
                cardColumns = columns;
                console.log(`[MIGRATION] Reusing dataset ID: ${targetDomoDatasetId} for dashboard table '${tableName}'`);
              } else {
                updateStatus(reportId, {
                  status: `Fetching PowerBI data for dataset ${i + 1}/${datasetIds.length}`,
                  progress: baseProgress + 10,
                  migratedTables: results
                });

                let powerbiData;
                try {
                  powerbiData = await executeQuery(targetDatasetId, `EVALUATE VALUES('${tableName}')`);
                } catch (err) {
                  powerbiData = await executeQuery(targetDatasetId, `EVALUATE VALUES('Sheet1')`);
                  tableName = 'Sheet1';
                }

                const pbTable = powerbiData?.results?.[0]?.tables?.[0];
                rawRows = pbTable?.rows || [];
                const rawColumnNames = rawRows.length > 0 ? Object.keys(rawRows[0]) : [];

                if (!rawRows.length || !rawColumnNames.length) {
                  throw new Error(`Dataset ${targetDatasetId} returned no rows.`);
                }

                const csvInfo = buildCsv(rawRows, rawColumnNames);
                columns = csvInfo.columns;
                cardColumns = columns;

                // Create Domo dataset
                updateStatus(reportId, {
                  status: `Uploading dataset ${i + 1}/${datasetIds.length} to Domo`,
                  progress: baseProgress + 15,
                  migratedTables: results
                });

                console.log(`[MIGRATION] Creating Domo dataset for table '${tableName}'...`);
                targetDomoDatasetId = await createDomoDataset(`${reportName} - ${ctx.title}`, columns);
                console.log(`[MIGRATION] Dataset created in Domo. ID: ${targetDomoDatasetId}`);

                console.log(`[MIGRATION] Uploading data for table '${tableName}' to Domo dataset ${targetDomoDatasetId}...`);
                await uploadDataToDomoDataset(targetDomoDatasetId, columns, rawRows);

                // State Order 1: Dataset created
                setTableState(tableName, {
                  powerbiDatasetId: targetDatasetId,
                  domoDatasetId: targetDomoDatasetId,
                  status: 'dataset_created',
                  columns,
                  rawColumns: columns,
                  rowCount: rawRows.length
                });
              }

              // State Order 2: Data uploaded
              if (currentTableStatus.status !== 'data_uploaded' && currentTableStatus.status !== 'success' && currentTableStatus.status !== 'etl_created') {
                setTableState(tableName, { status: 'data_uploaded' });
              }

              // State Order 3: ETL created
              if (currentTableStatus.status !== 'success') {
                let finalDomoDatasetId = targetDomoDatasetId;
                if (currentTableStatus.status === 'etl_created' && currentTableStatus.magicEtl) {
                  magicEtlResult = currentTableStatus.magicEtl;
                } else {
                  try {
                    console.log(`[MAGIC ETL] Pre-fetching Power Query M expressions for dashboard dataset: ${targetDatasetId}...`);
                    const dashboardMExpressions = await getPowerQueryExpressions(workspaceId, targetDatasetId);
                    const tableExpr = dashboardMExpressions.find(e => e.tableName === tableName || e.tableName.toLowerCase() === tableName.toLowerCase());

                    if (tableExpr && tableExpr.mExpression) {
                      console.log(`[MAGIC ETL] Found M expression for '${tableName}' (${tableExpr.mExpression.length} chars). Parsing...`);
                      const steps = parsePowerQuerySteps(tableExpr.mExpression);

                      // Store ETL step metadata for downstream reporting
                      const manualCount = steps.filter(s => s.actionType === 'MANUAL_BUILD').length;
                      setTableState(tableName, {
                        parsedStepCount: steps.length,
                        manualStepCount: manualCount,
                        parsedSteps: steps.map(s => ({ stepName: s.stepName, actionType: s.actionType, description: s.description }))
                      });

                      console.log(`[MAGIC ETL] Parsed ${steps.length} step(s) for '${tableName}'. Submitting to Domo...`);
                      const dataflowDef = buildDataflowDefinition(reportName, tableName, targetDomoDatasetId, steps);
                      magicEtlResult = await createMagicEtlDataflow(dataflowDef);
                      console.log(`[MAGIC ETL] createMagicEtlDataflow result for '${tableName}':`, JSON.stringify({
                        dataflowId: magicEtlResult?.dataflowId,
                        outputDatasetId: magicEtlResult?.outputDatasetId,
                        skipped: magicEtlResult?.skipped,
                        error: magicEtlResult?.error
                      }));
                      if (magicEtlResult && magicEtlResult.dataflowId) {
                        setTableState(tableName, { status: 'etl_created', magicEtl: magicEtlResult });
                        try {
                          // Trigger execution disabled per request
                          const { executionId } = await runMagicEtlDataflow(magicEtlResult.dataflowId);
                          const execResult = await pollEtlExecution(magicEtlResult.dataflowId, executionId);
                          if (!execResult.succeeded) {
                            console.warn(`[MAGIC ETL] Report ETL execution failed for '${tableName}': ${execResult.error}`);
                            magicEtlResult.executionStatus = execResult.status;
                            magicEtlResult.outputDatasetId = null;
                          } else {
                            magicEtlResult.executionStatus = 'SKIPPED';
                            const domain = (process.env.DOMO_CLIENT_DOMAIN || '').trim();
                            const token = (process.env.DOMO_CLIENT_TOKEN || '').trim();
                            const headers = {
                              'Content-Type': 'application/json',
                              'Authorization': `bearer ${token}`
                            };
                            const detailUrl = `https://${domain}/api/dataprocessing/v1/dataflows/${magicEtlResult.dataflowId}`;
                            const detailResponse = await axios.get(detailUrl, { headers, timeout: 30000 });
                            const respOutputs = detailResponse.data?.outputs || [];
                            const outputDatasetId =
                              respOutputs[0]?.dataSourceId ||
                              respOutputs[0]?.id ||
                              respOutputs[0]?.datasetId ||
                              null;
                            magicEtlResult.outputDatasetId = outputDatasetId;
                            console.log(`[MAGIC ETL] Fetched dataflow details. Output Dataset ID: ${outputDatasetId}`);
                          }
                        } catch (runErr) {
                          console.error(`[MAGIC ETL RUN ERROR] Non-fatal (report) for '${tableName}': ${runErr.message}`);
                          magicEtlResult.executionStatus = 'RUN_ERROR';
                          magicEtlResult.outputDatasetId = null;
                        }
                        if (magicEtlResult && magicEtlResult.dataflowId) {
                          setTableState(tableName, { status: 'etl_created', magicEtl: magicEtlResult });
                        }
                      }
                    } else {
                      magicEtlResult = { skipped: true };
                    }
                  } catch (etlErr) {
                    console.error(`[MAGIC ETL ERROR] Magic ETL creation failed: ${etlErr.message}`);
                    magicEtlResult = { error: etlErr.message };
                  }
                }

                // Card & Beast Mode calculations created on the raw dataset instead of ETL
                finalDomoDatasetId = targetDomoDatasetId;

                // Update status to success
                setTableState(tableName, {
                  status: 'success',
                  magicEtl: magicEtlResult,
                  columns: cardColumns
                });

                // ── Beast Mode Migration (Dashboard) ──
                if (measuresList.length > 0 && finalDomoDatasetId) {
                  try {
                    const bmColNames = cardColumns.map(c => c.name);
                    updateStatus(reportId, {
                      status: `Migrating ${measuresList.length} measure(s) to Beast Modes for dataset ${i + 1}/${datasetIds.length}`,
                      progress: baseProgress + 18,
                      migratedTables: results
                    });
                    const bmResult = await migrateMeasuresToBeastModes(measuresList, finalDomoDatasetId, bmColNames, reportId, updateStatus, results);

                    const currentOverall = migrations.get(reportId) || {};
                    const existingMeasures = currentOverall.migratedMeasures || [];
                    const newMeasures = [...existingMeasures, ...bmResult.results];

                    updateStatus(reportId, {
                      ...currentOverall,
                      migratedMeasures: newMeasures,
                      migratedTables: results
                    });

                    const s = bmResult.summary;
                    updateStatus(reportId, {
                      ...migrations.get(reportId),
                      status: `Created ${s.created}/${measuresList.length} Beast Modes for dataset ${i + 1} (${s.manual + s.unsupported + s.failed} need manual review)`,
                      progress: baseProgress + 19
                    });
                  } catch (bmErr) {
                    console.error(`[BEAST MODE ERROR] Dashboard Beast Mode migration failed (non-fatal): ${bmErr.message}`);
                    const currentOverall = migrations.get(reportId) || {};
                    const existingMeasures = currentOverall.migratedMeasures || [];
                    const errorMeasures = measuresList.map(m => ({ name: m.name, daxExpression: m.expression, classification: 'MANUAL_BUILD', status: 'error', error: bmErr.message }));
                    updateStatus(reportId, {
                      ...currentOverall,
                      migratedMeasures: [...existingMeasures, ...errorMeasures],
                      migratedTables: results
                    });
                  }
                }
              }
            } catch (tableErr) {
              console.error(`[MIGRATION ERROR] Failed to migrate dashboard dataset table '${tableName}':`, tableErr);
              setTableState(tableName, {
                status: 'failed',
                error: tableErr.message
              });
              continue; // Skip creating card for this table
            }
          }

          try {
            const domain = (process.env.DOMO_CLIENT_DOMAIN || '').trim();
            const token = (process.env.DOMO_CLIENT_TOKEN || '').trim();
            updateStatus(reportId, {
              ...migrations.get(reportId),
              status: `Creating Domo card ${i + 1}/${datasetIds.length}`,
              progress: baseProgress + 20,
              migratedTables: results
            });

            let dashCardOwnerId = null;
            try {
              dashCardOwnerId = await fetchCurrentUserId(domain, token);
            } catch (e) { console.warn('[CARD] Owner resolve failed:', e.message); }

            const dashMigratedMeasures = migrations.get(reportId)?.migratedMeasures || [];
            const dashBeastModeIds = dashMigratedMeasures
              .filter(m => m.domoFunctionId && m.status === 'created')
              .map(m => m.domoFunctionId);

            const dashCardResult = await createDomoCard(domain, token, {
              cardName: `${reportName} - ${ctx.title}`,
              domoDatasetId: finalDomoDatasetId,
              columns: cardColumns || [],
              beastModeIds: dashBeastModeIds,
              ownerId: dashCardOwnerId,
              chartType: 'badge_vert_bar',
            });

            createdCardIds.push(dashCardResult.cardId);
            setTableState(tableName, {
              domoCardId: dashCardResult.cardId,
              domoCardUrl: dashCardResult.cardUrl
            });
            console.log(`[CARD] Dashboard card created: ${dashCardResult.cardUrl}`);

          } catch (dashCardErr) {
            console.error(`[CARD ERROR] Dashboard card creation failed for '${tableName}':`, dashCardErr.message);
            createdCardIds.push(`failed-${i}`);
          }
        }

        if (createdCardIds.length === 0) {
          const err = new Error('Failed to create cards for dashboard tiles.');
          err.status = 500;
          err.migratedTables = results;
          updateStatus(reportId, { status: 'error', progress: 0, message: err.message, migratedTables: results });
          throw err;
        }

        // After the dataset loop, create a real dashboard page for the dashboard flow too
        let dashPageId = null;
        let dashPageUrl = null;
        const realCardIds = createdCardIds.filter(id => !String(id).startsWith('failed-'));

        if (realCardIds.length > 0) {
          try {
            const domain = (process.env.DOMO_CLIENT_DOMAIN || '').trim();
            const token = (process.env.DOMO_CLIENT_TOKEN || '').trim();
            let dashPageOwnerId = null;
            try { dashPageOwnerId = await fetchCurrentUserId(domain, token); } catch (e) { }

            const dashPage = await createDomoPage(domain, token, {
              pageName: `${reportName} Dashboard`,
              ownerId: dashPageOwnerId
            });
            dashPageId = dashPage.pageId;
            dashPageUrl = dashPage.pageUrl;
            await addCardsToPage(domain, token, dashPageId, realCardIds);
          } catch (dashPageErr) {
            console.error('[CARD ERROR] Dashboard page creation failed:', dashPageErr.message);
          }
        }

        const finalState = {
          status: 'complete',
          success: true,
          progress: 100,
          reportName,
          domoDashboardId: dashPageId,
          domoCardUrl: dashPageUrl || results[0]?.domoCardUrl,
          migratedTables: results,
          mExpressionFetchFailed: migrations.get(reportId)?.mExpressionFetchFailed || false,
          mExpressionFetchError: migrations.get(reportId)?.mExpressionFetchError || null,
          etlStepSummary: results.map(t => ({
            tableName: t.tableName,
            parsedStepCount: t.parsedStepCount || 0,
            manualStepCount: t.manualStepCount || 0,
            parsedSteps: t.parsedSteps || [],
          })),
          measureMigrationSummary: (migrations.get(reportId)?.migratedMeasures || []).map(m => ({
            measureName: m.name,
            classification: m.classification,
            beastModeFormula: m.beastModeFormula || null,
            domoFunctionId: m.domoFunctionId || null,
            status: m.status,
            reason: m.error || null,
          })),
          message: 'Dashboard migration completed successfully.'
        };

        updateStatus(reportId, finalState);
        return finalState;

      } else {
        // ─── REPORT MIGRATION FLOW ─────────────────────────────────────────────
        if (!datasetId) {
          const err = new Error('datasetId is required for report migration.');
          err.status = 400;
          err.migratedTables = results;
          throw err;
        }

        updateStatus(reportId, { status: 'Fetching PowerBI data', progress: 10, migratedTables: results });

        // Step 1: Discover tables
        let tableNames = [];
        try {
          tableNames = await getDatasetTables(datasetId);
        } catch (discErr) {
          console.error(`[MIGRATION ERROR] Failed to discover tables:`, discErr);
        }

        if (!tableNames || tableNames.length === 0) {
          const errorMsg = 'No tables discovered or fallback discovery failed.';
          const err = new Error(errorMsg);
          err.status = 500;
          err.migratedTables = results;
          updateStatus(reportId, { status: 'error', progress: 0, message: errorMsg, migratedTables: results });
          throw err;
        }

        updateStatus(reportId, {
          status: 'Discovering tables',
          progress: 15,
          tables: tableNames,
          migratedTables: results
        });

        let firstTableColumns = null;

        // Pre-fetch all Power Query M expressions (one API call for the entire workspace)
        let allMExpressions = [];
        try {
          console.log(`[MAGIC ETL] Pre-fetching Power Query M expressions for workspace ${workspaceId}...`);
          allMExpressions = await getPowerQueryExpressions(workspaceId, datasetId);
          console.log(`[MAGIC ETL] Found ${allMExpressions.length} M expressions across all tables.`);
        } catch (mExprErr) {
          console.warn(`[MAGIC ETL] Failed to fetch M expressions (non-fatal): ${mExprErr.message}`);
          allMExpressions = [];
          updateStatus(reportId, {
            ...migrations.get(reportId),
            status: 'warning',
            mExpressionFetchFailed: true,
            mExpressionFetchError: mExprErr.message,
            progress: 18,
            migratedTables: results
          });
        }

        // Fetch columns metadata for fallback schema resolution of empty tables
        let allDatasetColumns = [];
        try {
          console.log(`[MIGRATION] Fetching columns metadata for dataset ${datasetId}...`);
          allDatasetColumns = await getDatasetColumns(datasetId);
          console.log(`[MIGRATION] Found ${allDatasetColumns.length} columns in dataset metadata.`);
        } catch (colErr) {
          console.warn(`[MIGRATION WARNING] Failed to fetch columns metadata (non-fatal): ${colErr.message}`);
        }

        // Fetch measures once per dataset before table migration begins
        const datasetMeasures = await getDatasetMeasures(datasetId);
        const measures = datasetMeasures;
        console.log("[MEASURES FOUND]", measures.length);

        for (let i = 0; i < tableNames.length; i++) {
          checkCancellation(reportId, results);
          const tableName = tableNames[i];

          // Check if table was already successfully uploaded/migrated in a previous run for this report
          const existingTable = previousState?.migratedTables?.find(
            t => t.tableName === tableName
          );

          let domoDatasetId = null;
          let rowCount = 0;
          let columns = [];
          let magicEtlResult = null;

          if (existingTable && existingTable.status === 'success' && existingTable.domoDatasetId) {
            console.log(`[MIGRATION] Table '${tableName}' was already successfully migrated. Reusing dataset ID: ${existingTable.domoDatasetId}`);
            results.push(existingTable);
            if (!firstTableColumns) {
              firstTableColumns = existingTable.columns || [];
            }
            continue;
          }

          // Initialize table entry in results
          let currentTableStatus = existingTable ? { ...existingTable } : { tableName, status: 'started' };
          if (!results.some(t => t.tableName === tableName)) {
            results.push(currentTableStatus);
          }

          try {
            console.log(`[MIGRATION] Processing table: ${tableName}`);

            let rawRows = [];
            let rawColumnNames = [];

            // 2a. Check if we need to fetch schema/create dataset
            if (currentTableStatus.domoDatasetId) {
              domoDatasetId = currentTableStatus.domoDatasetId;
              rowCount = currentTableStatus.rowCount || 0;
              columns = currentTableStatus.columns || [];
              console.log(`[MIGRATION] Reusing dataset ID: ${domoDatasetId} for table '${tableName}'`);
            } else {
              // Fetch table data from PowerBI
              const powerbiData = await getTableData(datasetId, tableName);
              const pbTable = powerbiData?.results?.[0]?.tables?.[0];
              rawRows = pbTable?.rows || [];
              rawColumnNames = rawRows.length > 0 ? Object.keys(rawRows[0]) : [];

              if (!rawRows.length || !rawColumnNames.length) {
                console.log(`[MIGRATION] Table '${tableName}' returned no data rows. Querying INFO.VIEW.COLUMNS() to build empty schema...`);
                const tableMetadataColumns = allDatasetColumns.filter(c => {
                  const tName = c['[Table]'] || c.Table || '';
                  return tName.toLowerCase() === tableName.toLowerCase();
                });

                const filteredMetaCols = tableMetadataColumns.filter(c => {
                  const colType = c['[Type]'] || c.Type || '';
                  const colName = c['[Name]'] || c.Name || '';
                  if (colType === 'RowNumber') return false;
                  if (colName.startsWith('RowNumber-')) return false;
                  return true;
                });

                if (filteredMetaCols.length > 0) {
                  columns = filteredMetaCols.map(c => {
                    const colName = cleanColumnName(c['[Name]'] || c.Name || '');
                    const dType = (c['[DataType]'] || c.DataType || 'String').toLowerCase();
                    let domoType = 'STRING';
                    if (dType === 'integer' || dType === 'int64' || dType === 'long') {
                      domoType = 'LONG';
                    } else if (dType === 'double' || dType === 'decimal') {
                      domoType = 'DOUBLE';
                    } else if (dType === 'date') {
                      domoType = 'DATE';
                    } else if (dType === 'datetime') {
                      domoType = 'DATETIME';
                    }
                    return { name: colName, type: domoType };
                  });
                  console.log(`[MIGRATION] Resolved empty table '${tableName}' schema with ${columns.length} columns from DMV.`);
                } else {
                  console.warn(`[MIGRATION WARNING] No columns metadata found for empty table '${tableName}'. Creating a fallback dummy column.`);
                  columns = [{ name: 'Dummy', type: 'STRING' }];
                }
                rowCount = 0;
              } else {
                rowCount = rawRows.length;
                console.log(`[MIGRATION] PowerBI returned ${rowCount} rows for table '${tableName}'.`);
                const csvInfo = buildCsv(rawRows, rawColumnNames);
                columns = csvInfo.columns;
              }

              // Create Domo dataset
              console.log(`[MIGRATION] Creating Domo dataset for table '${tableName}'...`);
              domoDatasetId = await createDomoDataset(tableName, columns);
              console.log(`[MIGRATION] Dataset created in Domo. ID: ${domoDatasetId}`);

              // State Order 1: Dataset created
              setTableState(tableName, { domoDatasetId, status: 'dataset_created', columns, rawColumns: columns, rowCount });
            }

            if (!firstTableColumns) {
              firstTableColumns = columns;
            }

            // 2b. Check if we need to upload data
            if (currentTableStatus.status !== 'data_uploaded' && currentTableStatus.status !== 'success' && currentTableStatus.status !== 'etl_created') {
              console.log(`[MIGRATION] Uploading data for table '${tableName}' (rows: ${rawRows.length}) to Domo dataset ${domoDatasetId}...`);
              await uploadDataToDomoDataset(domoDatasetId, columns, rawRows);

              // State Order 2: Data uploaded
              setTableState(tableName, { status: 'data_uploaded' });
            }

            // 2c. Check if we need to run Magic ETL
            if (currentTableStatus.status !== 'success') {
              if (currentTableStatus.status === 'etl_created' && currentTableStatus.magicEtl) {
                magicEtlResult = currentTableStatus.magicEtl;
              } else {
                try {
                  updateStatus(reportId, {
                    status: `Creating Magic ETL for: ${tableName}`,
                    progress: 20 + Math.round(((i + 0.7) / tableNames.length) * 50),
                    migratedTables: results
                  });

                  const tableExpr = allMExpressions.find(e => e.tableName === tableName || e.tableName.toLowerCase() === tableName.toLowerCase());

                  if (tableExpr && tableExpr.mExpression) {
                    console.log(`[MAGIC ETL] Found M expression for '${tableName}' (${tableExpr.mExpression.length} chars). Parsing...`);
                    const steps = parsePowerQuerySteps(tableExpr.mExpression);

                    if (steps.length === 0) {
                      console.warn(`[MAGIC ETL] ⚠ parsePowerQuerySteps returned 0 steps for '${tableName}'. M expression first 200 chars: ${tableExpr.mExpression.substring(0, 200)}`);
                    }

                    // Store ETL step metadata for downstream reporting
                    const manualCount = steps.filter(s => s.actionType === 'MANUAL_BUILD').length;
                    setTableState(tableName, {
                      parsedStepCount: steps.length,
                      manualStepCount: manualCount,
                      parsedSteps: steps.map(s => ({ stepName: s.stepName, actionType: s.actionType, description: s.description }))
                    });

                    console.log(`[MAGIC ETL] Parsed ${steps.length} step(s) for '${tableName}' (${manualCount} manual). Submitting to Domo...`);
                    const dataflowDef = buildDataflowDefinition(reportName, tableName, domoDatasetId, steps);
                    magicEtlResult = await createMagicEtlDataflow(dataflowDef);
                    if (magicEtlResult === null) {
                      console.warn(`[MAGIC ETL] createMagicEtlDataflow returned null for '${tableName}' — dataflow was skipped (likely 0 parseable steps).`);
                    } else {
                      console.log(`[MAGIC ETL] createMagicEtlDataflow result for '${tableName}':`, JSON.stringify({
                        dataflowId: magicEtlResult?.dataflowId,
                        outputDatasetId: magicEtlResult?.outputDatasetId,
                        skipped: magicEtlResult?.skipped,
                        error: magicEtlResult?.error
                      }));
                    }
                    if (magicEtlResult && magicEtlResult.dataflowId) {
                      setTableState(tableName, { status: 'etl_created', magicEtl: magicEtlResult });
                      try {
                        // Trigger execution disabled per request
                        const { executionId } = await runMagicEtlDataflow(magicEtlResult.dataflowId);
                        const execResult = await pollEtlExecution(magicEtlResult.dataflowId, executionId);
                        if (!execResult.succeeded) {
                          console.warn(`[MAGIC ETL] Report ETL execution failed for '${tableName}': ${execResult.error}`);
                          magicEtlResult.executionStatus = execResult.status;
                          magicEtlResult.outputDatasetId = null;
                        } else {
                          magicEtlResult.executionStatus = 'SKIPPED';
                          const domain = (process.env.DOMO_CLIENT_DOMAIN || '').trim();
                          const token = (process.env.DOMO_CLIENT_TOKEN || '').trim();
                          const headers = {
                            'Content-Type': 'application/json',
                            'Authorization': `bearer ${token}`
                          };
                          const detailUrl = `https://${domain}/api/dataprocessing/v1/dataflows/${magicEtlResult.dataflowId}`;
                          const detailResponse = await axios.get(detailUrl, { headers, timeout: 30000 });
                          const respOutputs = detailResponse.data?.outputs || [];
                          const outputDatasetId =
                            respOutputs[0]?.dataSourceId ||
                            respOutputs[0]?.id ||
                            respOutputs[0]?.datasetId ||
                            null;
                          magicEtlResult.outputDatasetId = outputDatasetId;
                          console.log(`[MAGIC ETL] Fetched dataflow details. Output Dataset ID: ${outputDatasetId}`);
                        }
                      } catch (runErr) {
                        console.error(`[MAGIC ETL RUN ERROR] Non-fatal (report) for '${tableName}': ${runErr.message}`);
                        magicEtlResult.executionStatus = 'RUN_ERROR';
                        magicEtlResult.outputDatasetId = null;
                      }
                    }
                  } else {
                    console.warn(`[MAGIC ETL] ⚠ No M expression found for table '${tableName}'. Available expressions: [${allMExpressions.map(e => e.tableName).join(', ')}]`);
                    magicEtlResult = { skipped: true };
                  }
                } catch (etlErr) {
                  console.error(`[MAGIC ETL ERROR] Non-fatal — ETL creation failed for '${tableName}': ${etlErr.message}`);
                  magicEtlResult = { error: etlErr.message };
                }
              }

              let cardColumns = columns;
              if (magicEtlResult && magicEtlResult.outputDatasetId) {
                try {
                  const domain = (process.env.DOMO_CLIENT_DOMAIN || '').trim();
                  const token = (process.env.DOMO_CLIENT_TOKEN || '').trim();
                  console.log(`[MIGRATION] Fetching transformed columns for card layout (Dataset ID: ${magicEtlResult.outputDatasetId})...`);
                  const schemaCols = await fetchDomoDatasetSchema(domain, token, magicEtlResult.outputDatasetId);
                  if (schemaCols && schemaCols.length > 0) {
                    cardColumns = schemaCols.map(c => ({ name: c.name, type: c.type }));
                  }
                } catch (cardSchemaErr) {
                  console.warn(`[MIGRATION WARNING] Failed to fetch transformed schema columns:`, cardSchemaErr.message);
                }
              }

              // State Order 3: ETL created/success
              setTableState(tableName, {
                status: 'success',
                magicEtl: magicEtlResult,
                columns: cardColumns,
              });

              // Measures are hoisted to dataset level — store raw measures for reference
              setTableState(tableName, { measures: datasetMeasures });
            }
          } catch (tableErr) {
            console.error(`[MIGRATION ERROR] Failed to migrate table '${tableName}':`, tableErr);
            setTableState(tableName, {
              status: 'failed',
              error: tableErr.message
            });
          }

          // Emit proportional progress from 20% to 70%
          const proportion = Math.round(((i + 1) / tableNames.length) * 50);
          const currentProgress = 20 + proportion;
          updateStatus(reportId, {
            status: `Migrating table: ${tableName}`,
            progress: currentProgress,
            migratedTables: results
          });
        }

        // Step 3: Dataflow Migration
        updateStatus(reportId, { status: 'Migrating model view to Domo dataflow', progress: 72, migratedTables: results });

        let domoDataflowResult = null;
        try {
          const tableToDatasetId = {};
          for (const t of results) {
            if (t.status === 'success') {
              tableToDatasetId[t.tableName] = (t.magicEtl && t.magicEtl.outputDatasetId) ? t.magicEtl.outputDatasetId : t.domoDatasetId;
            }
          }

          let relationships = [];
          try {
            relationships = await getDatasetRelationships(datasetId);
          } catch (relErr) {
            console.warn(`[MIGRATION WARNING] Failed to fetch relationships:`, relErr.message);
            relationships = [];
          }

          if (relationships.length === 0) {
            console.log('[MIGRATION] No relationships found in Power BI model — skipping dataflow creation.');
          } else {
            const resolvedRels = resolveRelationships(relationships);

            if (resolvedRels.length > 0) {
              const currentModelId = migrations.get(reportId)?.domoDataModelId;
              const isValidModelId = currentModelId && currentModelId !== 'failed' && currentModelId !== 'undefined';
              const shouldReuse = completedModelViews.has(reportId) || isValidModelId;

              if (shouldReuse && isValidModelId) {
                console.log(`[MIGRATION] Reusing existing Model View ETL dataflow ID: ${currentModelId}`);
                domoDataflowResult = {
                  modelId: currentModelId,
                  modelUrl: migrations.get(reportId)?.domoDataModelUrl || null,
                  outputDatasetId: migrations.get(reportId)?.domoDataModelOutputDatasetId || null
                };
              } else if (shouldReuse) {
                console.log(`[MIGRATION] Model View ETL is marked completed (or in progress). Reusing.`);
                domoDataflowResult = {
                  modelId: currentModelId || null,
                  modelUrl: migrations.get(reportId)?.domoDataModelUrl || null,
                  outputDatasetId: migrations.get(reportId)?.domoDataModelOutputDatasetId || null
                };
              } else {
                console.log('[MIGRATION] Creating Magic ETL dataflow for Model View...');
                completedModelViews.add(reportId);

                try {
                  const modelViewEtlResult = await createModelViewMagicEtl(reportName, resolvedRels, tableToDatasetId);
                  domoDataflowResult = {
                    modelId: modelViewEtlResult.dataflowId,
                    modelUrl: modelViewEtlResult.dataflowUrl,
                    outputDatasetId: modelViewEtlResult.outputDatasetId
                  };

                  const currentOverall = migrations.get(reportId) || {};
                  updateStatus(reportId, {
                    ...currentOverall,
                    domoDataModelId: domoDataflowResult.modelId,
                    domoDataModelUrl: domoDataflowResult.modelUrl,
                    domoDataModelOutputDatasetId: domoDataflowResult.outputDatasetId,
                    status: 'model_view_etl_created',
                    progress: 80
                  });
                } catch (etlError) {
                  console.error(`[MIGRATION ERROR] Model View Magic ETL creation failed: ${etlError.message}`);
                  completedModelViews.delete(reportId);
                  domoDataflowResult = { modelUrl: 'failed', modelId: 'failed', error: etlError.message };

                  const currentOverall = migrations.get(reportId) || {};
                  updateStatus(reportId, {
                    ...currentOverall,
                    domoDataModelId: 'failed',
                    domoDataModelUrl: 'failed',
                    domoDataModelOutputDatasetId: 'failed',
                    migratedTables: results
                  });
                }
              }
            } else {
              console.warn('[MIGRATION] Relationships found but none could be resolved to table/column names.');
            }
          }
        } catch (dataflowErr) {
          console.error(`[MIGRATION ERROR] Dataflow creation failed (non-fatal): ${dataflowErr.message}`);
        }

        // Hoisted Beast Mode Migration (Report)
        const canonicalTableName = req.body.canonicalTableName || null;
        let targetDomoDatasetId = null;
        let targetColumns = [];

        // Priority order for targetDomoDatasetId must be:
        // 1. Model View ETL output
        // 2. Per-table Magic ETL output
        // 3. Raw upload dataset (fallback)

        const successfulTables = results.filter(t => t.status === 'success');
        let canonicalTable = canonicalTableName
          ? successfulTables.find(t => t.tableName === canonicalTableName)
          : null;
        if (!canonicalTable) canonicalTable = successfulTables[0];

        if (domoDataflowResult && domoDataflowResult.outputDatasetId && domoDataflowResult.outputDatasetId !== 'failed' && domoDataflowResult.outputDatasetId !== 'undefined') {
          targetDomoDatasetId = domoDataflowResult.outputDatasetId;
          console.log(`[MIGRATION] Using Model View output dataset ID for Beast Modes: ${targetDomoDatasetId}`);
        } else if (canonicalTable && canonicalTable.magicEtl && canonicalTable.magicEtl.outputDatasetId) {
          targetDomoDatasetId = canonicalTable.magicEtl.outputDatasetId;
          console.log(`[MIGRATION] Using Magic ETL output dataset ID for Beast Modes: ${targetDomoDatasetId}`);
        } else if (canonicalTable) {
          targetDomoDatasetId = canonicalTable.domoDatasetId;
          console.log(`[MIGRATION] Using raw dataset of table '${canonicalTable.tableName}' as canonical target for Beast Modes: ${targetDomoDatasetId}`);
        }

        if (targetDomoDatasetId) {
          const allColumnsSet = new Set();
          for (const t of results.filter(r => r.status === 'success')) {
            (t.rawColumns || t.columns || []).forEach(c => allColumnsSet.add(c.name));
          }
          targetColumns = Array.from(allColumnsSet);
          console.log(`[MIGRATION] Total columns across all tables for Beast Mode: ${targetColumns.length}`);
        }

        if (datasetMeasures.length > 0 && targetDomoDatasetId) {
          try {
            updateStatus(reportId, {
              ...migrations.get(reportId),
              status: `Migrating ${datasetMeasures.length} measure(s) to Beast Modes for dataset`,
              progress: 82,
              migratedTables: results
            });
            const bmResult = await migrateMeasuresToBeastModes(datasetMeasures, targetDomoDatasetId, targetColumns, reportId, updateStatus, results);

            updateStatus(reportId, {
              ...migrations.get(reportId),
              migratedMeasures: bmResult.results,
              migratedTables: results
            });

            const s = bmResult.summary;
            updateStatus(reportId, {
              ...migrations.get(reportId),
              status: `Created ${s.created}/${datasetMeasures.length} Beast Modes for dataset (${s.manual + s.unsupported + s.failed} need manual review)`,
              progress: 84
            });
          } catch (bmErr) {
            console.error(`[BEAST MODE ERROR] Report Beast Mode migration failed (non-fatal): ${bmErr.message}`);
            updateStatus(reportId, {
              ...migrations.get(reportId),
              migratedMeasures: datasetMeasures.map(m => ({
                name: m.name,
                daxExpression: m.expression,
                classification: 'MANUAL_BUILD',
                status: 'error',
                error: bmErr.message
              })),
              migratedTables: results
            });
          }
        } else {
          updateStatus(reportId, {
            ...migrations.get(reportId),
            migratedMeasures: datasetMeasures.map(m => ({
              name: m.name,
              daxExpression: m.expression,
              classification: 'MANUAL_BUILD',
              status: 'needs_manual_review',
              error: 'No target dataset available'
            })),
            migratedTables: results
          });
        }

        // Step 5: Create real Domo cards and dashboard page
        updateStatus(reportId, { status: 'Creating Domo cards and dashboard', progress: 85, migratedTables: results });

        if (successfulTables.length === 0) {
          throw new Error("No tables migrated successfully.");
        }

        const firstSuccessTable = successfulTables[0];
        const finalTargetDomoDatasetId = targetDomoDatasetId || (
          (firstSuccessTable.magicEtl && firstSuccessTable.magicEtl.outputDatasetId)
            ? firstSuccessTable.magicEtl.outputDatasetId
            : firstSuccessTable.domoDatasetId
        );

        const domain = (process.env.DOMO_CLIENT_DOMAIN || '').trim();
        const token = (process.env.DOMO_CLIENT_TOKEN || '').trim();

        let domoCardId = null;
        let domoCardUrl = null;
        let domoDashboardPageId = null;
        let domoDashboardPageUrl = null;
        let cardCreationWarning = null;

        try {
          // Resolve owner ID for card/page creation
          let cardOwnerId = null;
          try {
            cardOwnerId = await fetchCurrentUserId(domain, token);
          } catch (ownerErr) {
            console.warn('[CARD] Could not resolve owner ID:', ownerErr.message);
          }

          // Get the Beast Mode IDs from migrated measures for this dataset
          const migratedMeasures = migrations.get(reportId)?.migratedMeasures || [];
          const beastModeIds = migratedMeasures
            .filter(m => m.domoFunctionId && m.status === 'created')
            .map(m => m.domoFunctionId);

          // ── Try layout-driven card creation (same pipeline as /migrate-report-layout) ──
          let cardsToCreate = [];
          try {
            updateStatus(reportId, {
              ...migrations.get(reportId),
              status: 'Fetching report layout for card creation',
              progress: 85,
              migratedTables: results
            });

            const {
              exportReportToPbix,
              extractReportLayout,
              parseReportLayout,
              mapPagesToDomo,
            } = await import('../services/powerbiLayoutService.js');

            // Build tableName -> final Domo dataset ID map
            const domoDatasetIdMap = {};
            const datasetColumnsMap = {};
            const columnCaseMap = {};
            const datasetColumnTypesMap = {};

            const modelOutputDatasetId = domoDataflowResult?.outputDatasetId;
            let fetchedModelColumns = [];

            if (modelOutputDatasetId && modelOutputDatasetId !== 'failed' && modelOutputDatasetId !== 'undefined') {
              try {
                console.log(`[MIGRATION LAYOUT] Fetching merged Model View schema for dataset: ${modelOutputDatasetId}`);
                fetchedModelColumns = await fetchDomoDatasetSchema(domain, token, modelOutputDatasetId);
                console.log(`[MIGRATION LAYOUT] Successfully fetched ${fetchedModelColumns?.length || 0} columns for merged dataset.`);
              } catch (err) {
                console.warn(`[MIGRATION LAYOUT] Failed to fetch schema for merged dataset ${modelOutputDatasetId}:`, err.message);
              }
            }

            if (fetchedModelColumns && fetchedModelColumns.length > 0) {
              const colNames = fetchedModelColumns.map(c => c.name || c.columnName);
              datasetColumnsMap[modelOutputDatasetId] = colNames;
              for (const t of successfulTables) {
                domoDatasetIdMap[t.tableName] = modelOutputDatasetId;
                datasetColumnsMap[t.tableName] = colNames;
              }

              columnCaseMap[modelOutputDatasetId] = {};
              colNames.forEach(c => {
                columnCaseMap[modelOutputDatasetId][c.toLowerCase()] = c;
              });

              for (const c of fetchedModelColumns) {
                const cName = c.name || c.columnName;
                if (typeof cName === 'string') {
                  const type = (c.type || 'STRING').toUpperCase();
                  datasetColumnTypesMap[`${modelOutputDatasetId}.${cName.toLowerCase()}`] = type;
                  for (const t of successfulTables) {
                    datasetColumnTypesMap[`${t.tableName}.${cName.toLowerCase()}`] = type;
                  }
                }
              }
            } else {
              // Fallback to per-table mapping if no merged Model View dataset was created
              for (const t of successfulTables) {
                const finalId = t.domoDatasetId;
                if (!finalId) continue;
                domoDatasetIdMap[t.tableName] = finalId;
                const colNames = (t.rawColumns || t.columns || []).map(c => c.name);
                datasetColumnsMap[t.tableName] = colNames;
                datasetColumnsMap[finalId] = colNames;
                columnCaseMap[finalId] = columnCaseMap[finalId] || {};
                colNames.forEach(c => { columnCaseMap[finalId][c.toLowerCase()] = c; });

                const rawCols = t.rawColumns || t.columns || [];
                for (const c of rawCols) {
                  if (c && c.name) {
                    const type = (c.type || 'STRING').toUpperCase();
                    datasetColumnTypesMap[`${finalId}.${c.name.toLowerCase()}`] = type;
                    datasetColumnTypesMap[`${t.tableName}.${c.name.toLowerCase()}`] = type;
                  }
                }
              }
            }

            // Build measureName -> beastModeId map from what's already migrated
            const domoMeasureIdMap = {};
            for (const m of migratedMeasures) {
              if (m.domoFunctionId && m.status === 'created') {
                domoMeasureIdMap[m.name.trim().toLowerCase()] = m.domoFunctionId;
              }
            }

            const pbixBuffer = await exportReportToPbix(workspaceId, reportId);
            const layout = extractReportLayout(pbixBuffer);
            const parsedPages = parseReportLayout(layout.data);
            const mapped = mapPagesToDomo(parsedPages, domoDatasetIdMap, domoMeasureIdMap, datasetColumnsMap, columnCaseMap, datasetColumnTypesMap);
            cardsToCreate = mapped.cardsToCreate;

            updateStatus(reportId, {
              ...migrations.get(reportId),
              migrationReport: mapped.migrationReport,
              migratedTables: results
            });

            console.log(`[MIGRATION] Layout-based card plan: ${cardsToCreate.length} cards across ${parsedPages.length} pages.`);
          } catch (layoutErr) {
            console.error('[MIGRATION] Layout export/parse failed, falling back to per-table cards:', layoutErr.message);
            cardsToCreate = [];
          }

          const createdCards = [];

          if (cardsToCreate.length > 0) {
            // Group cards by page
            const cardsByPage = {};
            for (const card of cardsToCreate) {
              const key = `${card.pageOrder}__${card.page}`;
              if (!cardsByPage[key]) {
                cardsByPage[key] = {
                  pageName: card.page,
                  pageOrder: card.pageOrder,
                  cards: [],
                };
              }
              cardsByPage[key].cards.push(card);
            }

            // For each page, create Domo page then create and attach cards
            const sortedPageKeys = Object.keys(cardsByPage).sort(
              (a, b) => cardsByPage[a].pageOrder - cardsByPage[b].pageOrder
            );

            let firstPageId = null;
            let firstPageUrl = null;

            for (const pageKey of sortedPageKeys) {
              const { pageName, cards } = cardsByPage[pageKey];
              let pageId = null;

              // Create Domo page
              try {
                updateStatus(reportId, {
                  ...migrations.get(reportId),
                  status: `Creating page: ${pageName}`,
                  progress: 86,
                  migratedTables: results
                });

                const pageRes = await createDomoPage(domain, token, {
                  pageName: `${reportName || reportId} - ${pageName}`,
                  ownerId: cardOwnerId,
                });
                pageId = pageRes.pageId;
                if (!firstPageId) {
                  firstPageId = pageRes.pageId;
                  firstPageUrl = pageRes.pageUrl;
                }
                console.log(`[MIGRATION] ✅ Created page "${pageName}": ${pageRes.pageUrl}`);
              } catch (pageErr) {
                console.error(`[MIGRATION] ❌ Failed to create page "${pageName}":`, pageErr.message);
                cardCreationWarning = `Some pages failed to create: ${pageErr.message}`;
                continue;
              }

              // Create cards for this page
              const pageCardIds = [];
              for (const card of cards) {
                const datasetId = card.domoDatasetId ||
                  (domoDatasetIdMap ? Object.values(domoDatasetIdMap)[0] : null);

                if (!datasetId) {
                  console.warn(`[CARD] Skipping "${card.cardName}" — no dataset ID available.`);
                  continue;
                }

                const cardName = card.cardName ||
                  `${pageName} - ${card.powerBiVisualType} (${card.powerBiVisualId})`;

                // Validate columns — use fallback if none valid
                let finalColumns = (card.columns || []).filter(c => c && c.column && c.column.trim() !== '');

                if (finalColumns.length === 0) {
                  const isSingleValue = card.domoChartType === 'badge_single_value' || card.domoChartType === 'badge_single_value';
                  if (isSingleValue) {
                    console.warn(`[MIGRATION] Skipping KPI card "${cardName}" — visual has no accurate mapped columns/measures`);
                    continue;
                  }

                  const availableCols = datasetColumnsMap[datasetId] ||
                    datasetColumnsMap[card.domoDatasetId] || [];
                  const firstCol = availableCols[0];
                  if (firstCol) {
                    console.warn(`[MIGRATION] "${cardName}" has no columns — using COUNT(${firstCol}) as fallback`);
                    finalColumns = [
                      { column: firstCol, mapping: 'ITEM' },
                      { column: firstCol, mapping: 'VALUE', aggregation: 'COUNT' },
                    ];
                  } else {
                    console.warn(`[MIGRATION] Skipping "${cardName}" — no columns and no fallback available`);
                    continue;
                  }
                }

                // Build a custom detailed card description
                const cardBeastModes = (card.beastModeIds || [])
                  .map(id => {
                    const m = migratedMeasures.find(m => String(m.domoFunctionId) === String(id));
                    if (!m) return null;
                    const formula = m.beastModeFormula || '';
                    return {
                      ...m,
                      dataType: m.dataType || inferBeastModeDataType(formula),
                      aggregated: m.aggregated !== undefined ? m.aggregated : detectAggregated(formula)
                    };
                  })
                  .filter(Boolean);

                let cardDescription = `Migrated from Power BI Visual Type: ${card.powerBiVisualType || 'unknown'}\n`;
                cardDescription += `Power BI Page: ${card.page || 'unknown'}\n`;
                cardDescription += `Domo Dataset ID: ${datasetId}\n\n`;

                if (finalColumns && finalColumns.length > 0) {
                  cardDescription += `Columns mapped to Visual:\n`;
                  finalColumns.forEach(c => {
                    const aggStr = c.aggregation ? ` (Aggregation: ${c.aggregation})` : '';
                    cardDescription += `- ${c.column} [Mapping: ${c.mapping}${aggStr}]\n`;
                  });
                  cardDescription += `\n`;
                }

                if (cardBeastModes.length > 0) {
                  cardDescription += `Beast Mode / DAX Formulas:\n`;
                  cardBeastModes.forEach(m => {
                    cardDescription += `- Name: ${m.name}\n`;
                    if (m.daxExpression) {
                      cardDescription += `  DAX expression: ${m.daxExpression}\n`;
                    }
                    if (m.beastModeFormula) {
                      cardDescription += `  Beast Mode expression: ${m.beastModeFormula}\n`;
                    }
                  });
                }

                try {
                  updateStatus(reportId, {
                    ...migrations.get(reportId),
                    status: `Creating card: ${cardName}`,
                    progress: 88,
                    migratedTables: results
                  });

                  console.log(`[MIGRATION] Creating card "${cardName}" | chartType: ${card.domoChartType} | dataset: ${datasetId}`);

                  const cardRes = await createDomoCard(domain, token, {
                    cardName,
                    domoDatasetId: datasetId,
                    columns: finalColumns,
                    beastModeIds: card.beastModeIds || [],
                    beastModes: cardBeastModes,
                    chartType: card.domoChartType,
                    ownerId: cardOwnerId,
                    description: cardDescription,
                  });

                  if (cardRes.cardId) {
                    pageCardIds.push(cardRes.cardId);
                    createdCards.push({
                      tableName: card.page,
                      cardId: cardRes.cardId,
                      cardUrl: cardRes.cardUrl,
                    });
                    console.log(`[MIGRATION] ✅ Created card "${cardName}" (${card.powerBiVisualType} → ${card.domoChartType}): ${cardRes.cardUrl}`);
                  } else {
                    console.error(`[MIGRATION ERROR] "${cardName}": ${cardRes.error}`);
                    cardCreationWarning = `Some cards failed to create: ${cardRes.error}`;
                  }
                } catch (cardErr) {
                  console.error(`[MIGRATION ERROR] Failed to create card "${cardName}":`, cardErr.message);
                  cardCreationWarning = `Some cards failed to create: ${cardErr.message}`;
                }
              }

              // Add cards to page
              if (pageCardIds.length > 0 && pageId) {
                try {
                  await addCardsToPage(domain, token, pageId, pageCardIds);
                  console.log(`[MIGRATION] ✅ Added ${pageCardIds.length} card(s) to page "${pageName}"`);
                } catch (addErr) {
                  console.error(`[MIGRATION ERROR] Failed to add cards to page "${pageName}":`, addErr.message);
                }
              }
            }

            domoDashboardPageId = firstPageId;
            domoDashboardPageUrl = firstPageUrl;
          } else {
            // ── Fallback: one generic card per successful table (old behavior) ──
            for (const table of successfulTables) {
              const tableDatasetId = table.domoDatasetId; // Raw dataset always!
              if (!tableDatasetId) continue;

              try {
                updateStatus(reportId, {
                  ...migrations.get(reportId),
                  status: `Creating card for table: ${table.tableName}`,
                  progress: 86,
                  migratedTables: results
                });

                const cardResult = await createDomoCard(domain, token, {
                  cardName: `${reportName} - ${table.tableName}`,
                  domoDatasetId: tableDatasetId,
                  columns: table.rawColumns || table.columns || [],
                  beastModeIds,
                  ownerId: cardOwnerId
                });

                if (cardResult.cardId) {
                  createdCards.push({
                    tableName: table.tableName,
                    cardId: cardResult.cardId,
                    cardUrl: cardResult.cardUrl
                  });
                  console.log(`[CARD] Created card for '${table.tableName}': ${cardResult.cardUrl}`);
                }
              } catch (cardErr) {
                console.error(`[CARD ERROR] Failed to create card for '${table.tableName}':`, cardErr.message);
                cardCreationWarning = `Some cards failed to create: ${cardErr.message}`;
              }
            }

            // Create dashboard pages and add cards to their respective pages
            if (createdCards.length > 0) {
              try {
                updateStatus(reportId, {
                  ...migrations.get(reportId),
                  status: 'Creating Domo dashboard pages',
                  progress: 90,
                  migratedTables: results
                });

                // Group created cards by page/table name
                const cardsByPage = {};
                for (const card of createdCards) {
                  const pageName = card.tableName || 'Overview';
                  if (!cardsByPage[pageName]) {
                    cardsByPage[pageName] = [];
                  }
                  cardsByPage[pageName].push(card.cardId);
                }

                let firstPageId = null;
                let firstPageUrl = null;

                for (const [pageName, cardIds] of Object.entries(cardsByPage)) {
                  if (cardIds.length === 0) continue;

                  console.log(`[CARD] Creating page for tab/table: "${pageName}" with ${cardIds.length} cards`);
                  const pageResult = await createDomoPage(domain, token, {
                    pageName: `${reportName} - ${pageName}`,
                    ownerId: cardOwnerId
                  });

                  if (!firstPageId) {
                    firstPageId = pageResult.pageId;
                    firstPageUrl = pageResult.pageUrl;
                  }

                  await addCardsToPage(domain, token, pageResult.pageId, cardIds);
                  console.log(`[CARD] Domo page "${pageName}" created: ${pageResult.pageUrl}`);
                }

                domoDashboardPageId = firstPageId;
                domoDashboardPageUrl = firstPageUrl;

              } catch (pageErr) {
                console.error('[CARD ERROR] Failed to create dashboard page(s):', pageErr.message);
                cardCreationWarning = cardCreationWarning
                  ? cardCreationWarning + '; Dashboard page creation failed'
                  : 'Dashboard page creation failed: ' + pageErr.message;
              }
            }
          }

          // Set primary card reference from first successful card
          if (createdCards.length > 0) {
            domoCardId = createdCards[0].cardId;
            domoCardUrl = createdCards[0].cardUrl;
          }

          // Store card results in table state (group by originating table/page)
          for (const card of createdCards) {
            setTableState(card.tableName, { domoCardId: card.cardId, domoCardUrl: card.cardUrl });
          }

        } catch (allCardErr) {
          console.error('[CARD ERROR] Card creation process failed (non-fatal):', allCardErr.message);
          cardCreationWarning = 'Card creation failed: ' + allCardErr.message;
        }

        const finalState = {
          status: 'complete',
          success: true,
          progress: 100,
          reportName,
          domoDatasetId: finalTargetDomoDatasetId,
          domoCardId,
          domoCardUrl,
          domoDashboardId: domoDashboardPageId,
          domoDashboardUrl: domoDashboardPageUrl,
          migratedTables: results,
          domoDataModelId: domoDataflowResult?.modelId || null,
          domoDataModelUrl: domoDataflowResult?.modelUrl || null,
          mExpressionFetchFailed: migrations.get(reportId)?.mExpressionFetchFailed || false,
          mExpressionFetchError: migrations.get(reportId)?.mExpressionFetchError || null,
          etlStepSummary: results.map(t => ({
            tableName: t.tableName,
            parsedStepCount: t.parsedStepCount || 0,
            manualStepCount: t.manualStepCount || 0,
            parsedSteps: t.parsedSteps || [],
          })),
          measureMigrationSummary: (migrations.get(reportId)?.migratedMeasures || []).map(m => ({
            measureName: m.name,
            classification: m.classification,
            beastModeFormula: m.beastModeFormula || null,
            domoFunctionId: m.domoFunctionId || null,
            status: m.status,
            reason: m.error || null,
          })),
          cardCreationWarning: cardCreationWarning || null,
          message: cardCreationWarning
            ? `Migration completed with warning: ${cardCreationWarning}`
            : 'Migration completed successfully. Cards and dashboard created in Domo.'
        };

        updateStatus(reportId, finalState);
        return finalState;
      }
    } catch (err) {
      console.error(`[MIGRATION ERROR] Unhandled exception:`, err);
      updateStatus(reportId, { status: 'error', progress: 0, message: err.message, migratedTables: results });
      throw err;
    }
  })();

  _migrationInFlight.set(reportId, migrationPromise);

  try {
    const result = await migrationPromise;
    return res.status(200).json(result);
  } catch (err) {
    return res.status(err.status || 500).json({
      success: false,
      status: 'error',
      progress: 0,
      message: err.message || `Internal exception: ${err}`,
      migratedTables: err.migratedTables || results
    });
  } finally {
    _migrationInFlight.delete(reportId);
    cancellationTokens.delete(reportId);
  }
});

router.get('/workspaces/:workspaceId/reports/:reportId/visuals', async (req, res) => {
  const { workspaceId, reportId } = req.params;
  try {
    const { exportReportToPbix, extractReportLayout, parseReportLayout } = await import('../services/powerbiLayoutService.js');
    console.log(`[ROUTE API] Fetching layout for workspace ${workspaceId}, report ${reportId}`);
    const pbixBuffer = await exportReportToPbix(workspaceId, reportId);
    const layout = extractReportLayout(pbixBuffer);
    const pages = parseReportLayout(layout.data);

    // Extract all visuals across all pages
    const visualsList = [];
    for (const page of pages) {
      const pageName = page.displayName || page.name || 'Page';
      if (Array.isArray(page.visuals)) {
        for (const v of page.visuals) {
          // Normalize names and chart types for display
          let chartType = v.visualType || 'KPI Card';
          // Clean up chartType name e.g. "barChart" -> "Bar Chart"
          if (chartType && chartType !== 'unknown') {
            chartType = chartType
              .replace(/([A-Z])/g, ' $1')
              .replace(/^./, str => str.toUpperCase())
              .trim();
          }

          const cleanFieldName = (name) => {
            if (!name) return '';
            let s = name.split('.').pop() || name;
            return s.replace(/[\[\]']/g, '').replace(/_/g, ' ').trim();
          };

          let title = v.title;
          if (!title || title === 'Unnamed Visual Card') {
            const values = (v.fields?.values || []).map(cleanFieldName).filter(Boolean);
            const categories = (v.fields?.category || []).map(cleanFieldName).filter(Boolean);
            if (values.length > 0 && categories.length > 0) {
              title = `${values.join(' & ')} by ${categories.join(' & ')}`;
            } else if (values.length > 0) {
              title = `Total ${values.join(' & ')}`;
            } else if (categories.length > 0) {
              title = `${categories.join(' & ')} Breakdown`;
            } else {
              title = `${chartType} Visual`;
            }
          }

          visualsList.push({
            id: String(v.id || ''),
            title: title,
            type: chartType,
            page: pageName,
            status: 'Ready'
          });
        }
      }
    }

    res.json({ success: true, visuals: visualsList });
  } catch (err) {
    console.error(`[ROUTE API ERROR] Failed to extract visuals for report ${reportId}:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/status/:reportId', (req, res) => {
  const { reportId } = req.params;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // Send current status immediately if available
  const currentState = migrations.get(reportId);
  if (currentState) {
    res.write(`data: ${JSON.stringify(currentState)}\n\n`);
  }

  const listener = (updatedState) => {
    res.write(`data: ${JSON.stringify(updatedState)}\n\n`);
  };

  migrationEmitter.on(reportId, listener);

  req.on('close', () => {
    migrationEmitter.off(reportId, listener);
  });
});

router.post('/stop', (req, res) => {
  const { reportId } = req.body;
  if (!reportId) {
    return res.status(400).json({ success: false, error: 'reportId is required.' });
  }
  console.log(`[MIGRATION] Received stop request for report ${reportId}`);
  cancellationTokens.add(reportId);

  // Also clean up from in-flight
  _migrationInFlight.delete(reportId);

  // Update status immediately so UI updates
  updateStatus(reportId, { status: 'error', progress: 0, message: 'Migration cancelled by user.' });

  res.json({ success: true, message: 'Cancellation signal sent.' });
});

router.get('/inspect-report-visuals', async (req, res) => {
  try {
    const { exportReportToPbix, extractReportLayout, parseReportLayout } =
      await import('../services/powerbiLayoutService.js');

    const { workspaceId, reportId } = req.query;

    if (!workspaceId || !reportId) {
      return res.status(400).json({ error: 'workspaceId and reportId are required' });
    }

    const pbixBuffer = await exportReportToPbix(workspaceId, reportId);
    const layout = extractReportLayout(pbixBuffer);
    const pages = parseReportLayout(layout.data);

    // Build detailed inspection result
    const inspection = pages.map(page => ({
      pageName: page.name,
      pageOrder: page.order,
      visualCount: page.visuals.length,
      visuals: page.visuals.map(v => ({
        id: v.id,
        visualType: v.visualType,
        title: v.title,
        isHidden: v.isHidden,
        position: v.position,
        fields: {
          category: v.fields.category,
          values: v.fields.values,
          legend: v.fields.legend,
          rows: v.fields.rows,
          columns: v.fields.columns,
          tooltips: v.fields.tooltips,
        },
        // Show which fields are measures vs physical columns
        fieldAnalysis: {
          measureFields: [
            ...v.fields.category,
            ...v.fields.values,
            ...v.fields.legend,
          ].filter(f => f && (
            f.startsWith('_Measures.') ||
            f.startsWith('_measures.') ||
            f.startsWith('Measures.')
          )).map(f => f.split('.').slice(1).join('.')),

          physicalFields: [
            ...v.fields.category,
            ...v.fields.values,
            ...v.fields.legend,
          ].filter(f => f && !(
            f.startsWith('_Measures.') ||
            f.startsWith('_measures.') ||
            f.startsWith('Measures.')
          ) && !f.includes('Date Hierarchy') && !f.includes('.Variation.')),

          dateHierarchyFields: [
            ...v.fields.category,
            ...v.fields.values,
          ].filter(f => f && (
            f.includes('Date Hierarchy') ||
            f.includes('.Variation.')
          )),

          tableNames: [...new Set([
            ...v.fields.category,
            ...v.fields.values,
          ].filter(f => f && f.includes('.'))
            .map(f => f.split('.')[0].trim()))],
        },
      })),
    }));

    // Summary
    const allVisualTypes = {};
    for (const page of pages) {
      for (const visual of page.visuals) {
        allVisualTypes[visual.visualType] = (allVisualTypes[visual.visualType] || 0) + 1;
      }
    }

    res.json({
      format: layout.format,
      totalPages: pages.length,
      totalVisuals: pages.reduce((sum, p) => sum + p.visuals.length, 0),
      visualTypeSummary: allVisualTypes,
      pages: inspection,
    });

  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

export default router;
