import { Router } from 'express';
import { EventEmitter } from 'events';
import axios from 'axios';
import { env } from '../config/env.js';
import { executeQuery, getDashboardTiles, getDatasetTables, getTableData, getDatasetRelationships, getDatasetColumns, getDatasetTableMeta, getPowerQueryExpressions, getDatasetMeasures } from '../services/powerbiService.js';
import { createDomoDataset, uploadDataToDomoDataset } from '../services/domoDatasetService.js';
import { resolveRelationships, createDomoDataModel, fetchDomoDatasetSchema } from '../services/domoDataflowService.js';
import { parsePowerQuerySteps, buildDataflowDefinition } from '../services/powerQueryParser.js';
import { createMagicEtlDataflow, createModelViewMagicEtl } from '../services/magicEtlService.js';
import { classifyDaxMeasure, inferBeastModeDataType, detectAggregated, extractNonAggregatedColumns, buildMeasureDependencyGraph, detectCycles, topologicalSortMeasures, substituteDependencies, sanitizeBeastModeFormula } from '../services/beastModeCompat.js';
import { convertWithValidation } from '../services/daxToBeastModeService.js';
import { createBeastModeFunctionsBulk, extractBulkCreatedIds, fetchCurrentUserId, createBeastModeFunction } from '../services/beastModeService.js';

const router = Router();
const migrationEmitter = new EventEmitter();

// In-memory database of migration statuses keyed by reportId
const migrations = new Map();

// In-memory set of completed Model Views keyed by reportId
const completedModelViews = new Set();

// In-memory mapping of active migrations keyed by reportId
const _migrationInFlight = new Map();

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

  // Hardcoded formula overrides for measures that consistently fail LLM conversion
  const FORMULA_OVERRIDES = {
    'Avg Cost Per Req': "CASE WHEN SUM(CASE WHEN `PO_COST` IS NOT NULL AND `PO_COST` > 0 THEN 1 ELSE 0 END) = 0 THEN NULL ELSE SUM(`PO_COST`) / SUM(CASE WHEN `PO_COST` IS NOT NULL AND `PO_COST` > 0 THEN 1 ELSE 0 END) END",
  };

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

    // Check for hardcoded formula override — bypass LLM conversion entirely
    if (FORMULA_OVERRIDES[mName]) {
      console.log(`[BEAST MODE] Using hardcoded formula override for '${mName}'`);
      const overrideFormula = FORMULA_OVERRIDES[mName];
      convertedFormulasMap.set(mName, overrideFormula);
      enrichedMeasures.push({
        name: mName,
        daxExpression: measure.expression,
        classification: 'DIRECT_BEASTMODE',
        beastModeFormula: overrideFormula,
        status: 'converted',
        domoFunctionId: null,
        error: null,
      });
      readyForDomoMeasures.push({
        name: mName,
        expression: overrideFormula,
        dataType: inferBeastModeDataType(overrideFormula),
        aggregated: detectAggregated(overrideFormula),
        nonAggregatedColumns: extractNonAggregatedColumns(overrideFormula),
        domoDatasetId,
      });
      continue;
    }

    // Inline substitute converted dependencies
    const targetDax = substituteDependencies(measure.expression, convertedFormulasMap);

    // Classify the substituted expression to keep track of its logic type
    const { classification, reason } = classifyDaxMeasure(mName, targetDax, false);
    console.log(`[BEAST MODE] Processing '${mName}' (Classified: ${classification}${reason ? ': ' + reason : ''})`);

    // Call LLM conversion for all measures
    try {
      const result = await convertWithValidation({
        measureName: mName,
        daxExpression: targetDax,
        availableColumns,
      });

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

  // 8. Bulk-create successful measures in Domo
  if (readyForDomoMeasures.length > 0 && ownerId && domain && token) {
    try {
      updateStatusFn(reportId, {
        ...migrations.get(reportId),
        status: `Creating ${readyForDomoMeasures.length} Beast Mode(s) in Domo...`,
      });

      const bulkResponse = await createBeastModeFunctionsBulk(domain, token, ownerId, readyForDomoMeasures);
      const idMap = extractBulkCreatedIds(bulkResponse, readyForDomoMeasures.map(m => m.name));

      for (const cm of readyForDomoMeasures) {
        const enriched = enrichedMeasures.find(m => m.name === cm.name);
        if (enriched) {
          enriched.domoFunctionId = idMap.get(cm.name) || null;
          enriched.status = 'created';
          summary.created++;
        }
      }

      console.log(`[BEAST MODE] Bulk creation succeeded: ${readyForDomoMeasures.length} Beast Mode(s) created.`);
    } catch (bulkErr) {
      console.warn(`[BEAST MODE] Bulk creation failed (${bulkErr.message}). Falling back to individual creation...`);
      for (const cm of readyForDomoMeasures) {
        const enriched = enrichedMeasures.find(m => m.name === cm.name);
        try {
          const singleResponse = await createBeastModeFunction(domain, token, ownerId, cm);
          if (enriched) {
            enriched.domoFunctionId = singleResponse?.id || singleResponse?.functionTemplateId || null;
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
    }
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
          t => t.powerbiDatasetId === targetDatasetId || (t.tableName === tableName && t.status === 'success')
        );

        let targetDomoDatasetId = null;
        let cardColumns = [];
        let magicEtlResult = null;
        let columns = [];
        let rawRows = [];

        if (existingTable && existingTable.status === 'success' && existingTable.domoDatasetId) {
          console.log(`[MIGRATION] Dashboard dataset '${targetDatasetId}' (table: '${tableName}') was already successfully migrated. Reusing dataset ID: ${existingTable.domoDatasetId}`);
          results.push(existingTable);
          targetDomoDatasetId = existingTable.domoDatasetId;
          cardColumns = existingTable.columns || [];
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
                rowCount: rawRows.length
              });
            }

            // State Order 2: Data uploaded
            if (currentTableStatus.status !== 'data_uploaded' && currentTableStatus.status !== 'success') {
              setTableState(tableName, { status: 'data_uploaded' });
            }

            // State Order 3: ETL created
            if (currentTableStatus.status !== 'success') {
              let finalDomoDatasetId = targetDomoDatasetId;
              try {
                console.log(`[MAGIC ETL] Pre-fetching Power Query M expressions for dashboard dataset: ${targetDatasetId}...`);
                const dashboardMExpressions = await getPowerQueryExpressions(workspaceId, targetDatasetId);
                const tableExpr = dashboardMExpressions.find(e => e.tableName === tableName || e.tableName.toLowerCase() === tableName.toLowerCase());

                if (tableExpr && tableExpr.mExpression) {
                  console.log(`[MAGIC ETL] Found M expression for '${tableName}' (${tableExpr.mExpression.length} chars). Parsing...`);
                  const steps = parsePowerQuerySteps(tableExpr.mExpression);
                  if (steps.length > 0) {
                    const dataflowDef = buildDataflowDefinition(reportName, tableName, targetDomoDatasetId, steps);
                    magicEtlResult = await createMagicEtlDataflow(dataflowDef);
                    if (magicEtlResult && magicEtlResult.outputDatasetId) {
                      finalDomoDatasetId = magicEtlResult.outputDatasetId;
                      try {
                        const domain = (process.env.DOMO_CLIENT_DOMAIN || '').trim();
                        const token = (process.env.DOMO_CLIENT_TOKEN || '').trim();
                        console.log(`[MIGRATION] Fetching transformed columns for card layout (Dataset ID: ${finalDomoDatasetId})...`);
                        const schemaCols = await fetchDomoDatasetSchema(domain, token, finalDomoDatasetId);
                        if (schemaCols && schemaCols.length > 0) {
                          cardColumns = schemaCols.map(c => ({ name: c.name, type: c.type }));
                        }
                      } catch (cardSchemaErr) {
                        console.warn(`[MIGRATION WARNING] Failed to fetch transformed schema columns:`, cardSchemaErr.message);
                      }
                    }
                  }
                }
              } catch (etlErr) {
                console.error(`[MAGIC ETL ERROR] Magic ETL creation failed: ${etlErr.message}`);
                magicEtlResult = { error: etlErr.message };
              }

              // Update status to success
              setTableState(tableName, {
                status: 'success',
                magicEtl: magicEtlResult,
                columns: cardColumns
              });

              // ── Beast Mode Migration (Dashboard) ──
              if (measuresList.length > 0 && targetDomoDatasetId) {
                try {
                  const bmColNames = cardColumns.map(c => c.name);
                  updateStatus(reportId, {
                    status: `Migrating ${measuresList.length} measure(s) to Beast Modes for dataset ${i + 1}/${datasetIds.length}`,
                    progress: baseProgress + 18,
                    migratedTables: results
                  });
                  const bmResult = await migrateMeasuresToBeastModes(measuresList, targetDomoDatasetId, bmColNames, reportId, updateStatus, results);
                  
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

        // 5. Create KPI card in Domo
        updateStatus(reportId, {
          status: `Creating card ${i + 1}/${datasetIds.length} in Domo`,
          progress: baseProgress + 20,
          migratedTables: results
        });

        const xColumn = cardColumns[0]?.name || '';
        const yColumn = cardColumns.length > 1 ? cardColumns[1]?.name : cardColumns[0]?.name || '';

        console.log(`[MIGRATION] Skipping card creation for table '${tableName}' (MCP is not used).`);
        const numericCardId = 123456 + i;
        createdCardIds.push(numericCardId);
      }

      if (createdCardIds.length === 0) {
        const err = new Error('Failed to create cards for dashboard tiles.');
        err.status = 500;
        err.migratedTables = results;
        updateStatus(reportId, { status: 'error', progress: 0, message: err.message, migratedTables: results });
        throw err;
      }

      // 6. Create Domo Dashboard (Page)
      updateStatus(reportId, { status: 'Assembling Domo Dashboard page', progress: 90, migratedTables: results });
      console.log(`[MIGRATION] Skipping dashboard creation for "${reportName}" (MCP is not used).`);

      const finalState = {
        status: 'complete',
        success: true,
        progress: 100,
        reportName,
        domoDashboardId: 'mock-dashboard-id',
        domoCardUrl: 'https://mock-domo-url/page/mock-dashboard-id', // UI opens cardUrl when clicking View in Domo
        migratedTables: results,
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
        updateStatus(reportId, {
          status: 'Warning: Cannot retrieve Power Query expressions from Power BI.',
          message: `Tenant Admin Scanning API permissions must be configured. Details: ${mExprErr.message}`,
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
            setTableState(tableName, { domoDatasetId, status: 'dataset_created', columns, rowCount });
          }

          if (!firstTableColumns) {
            firstTableColumns = columns;
          }

          // 2b. Check if we need to upload data
          if (currentTableStatus.status !== 'data_uploaded' && currentTableStatus.status !== 'success') {
            console.log(`[MIGRATION] Uploading data for table '${tableName}' (rows: ${rawRows.length}) to Domo dataset ${domoDatasetId}...`);
            await uploadDataToDomoDataset(domoDatasetId, columns, rawRows);

            // State Order 2: Data uploaded
            setTableState(tableName, { status: 'data_uploaded' });
          }

          // 2c. Check if we need to run Magic ETL
          if (currentTableStatus.status !== 'success') {
            try {
              updateStatus(reportId, {
                status: `Creating Magic ETL for: ${tableName}`,
                progress: 20 + Math.round(((i + 0.7) / tableNames.length) * 50),
                migratedTables: results
              });

              const tableExpr = allMExpressions.find(e => e.tableName === tableName);

              if (tableExpr && tableExpr.mExpression) {
                console.log(`[MAGIC ETL] Found M expression for '${tableName}' (${tableExpr.mExpression.length} chars). Parsing...`);
                const steps = parsePowerQuerySteps(tableExpr.mExpression);
                if (steps.length > 0) {
                  const dataflowDef = buildDataflowDefinition(reportName, tableName, domoDatasetId, steps);
                  magicEtlResult = await createMagicEtlDataflow(dataflowDef);
                } else {
                  magicEtlResult = { skipped: true };
                }
              } else {
                magicEtlResult = { skipped: true };
              }
            } catch (etlErr) {
              console.error(`[MAGIC ETL ERROR] Non-fatal — ETL creation failed for '${tableName}': ${etlErr.message}`);
              magicEtlResult = { error: etlErr.message };
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

      if (domoDataflowResult && domoDataflowResult.outputDatasetId) {
        targetDomoDatasetId = domoDataflowResult.outputDatasetId;
        console.log(`[MIGRATION] Using Model View output dataset as canonical target: ${targetDomoDatasetId}`);
        try {
          const domain = (process.env.DOMO_CLIENT_DOMAIN || '').trim();
          const token = (process.env.DOMO_CLIENT_TOKEN || '').trim();
          const schemaCols = await fetchDomoDatasetSchema(domain, token, targetDomoDatasetId);
          targetColumns = schemaCols.map(c => c.name);
        } catch (schemaErr) {
          console.warn(`[MIGRATION WARNING] Failed to fetch Model View schema:`, schemaErr.message);
          const allCols = new Set();
          for (const t of results) {
            if (t.status === 'success' && t.columns) {
              t.columns.forEach(c => allCols.add(c.name));
            }
          }
          targetColumns = Array.from(allCols);
        }
      } else {
        let canonicalTable = null;
        if (canonicalTableName) {
          canonicalTable = results.find(t => t.tableName === canonicalTableName && t.status === 'success');
        }
        if (!canonicalTable) {
          const successfulTables = results.filter(t => t.status === 'success');
          if (successfulTables.length > 0) {
            canonicalTable = successfulTables[0];
          }
        }
        
        if (canonicalTable) {
          targetDomoDatasetId = (canonicalTable.magicEtl && canonicalTable.magicEtl.outputDatasetId)
            ? canonicalTable.magicEtl.outputDatasetId
            : canonicalTable.domoDatasetId;
          targetColumns = canonicalTable.columns?.map(c => c.name) || [];
          console.log(`[MIGRATION] Using table '${canonicalTable.tableName}' as canonical target: ${targetDomoDatasetId}`);
        }
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

      // Step 5: Create Domo card
      updateStatus(reportId, { status: 'Creating Domo card', progress: 85, migratedTables: results });
      const successfulTables = results.filter(t => t.status === 'success');
      if (successfulTables.length === 0) {
         throw new Error("No tables migrated successfully.");
      }

      const firstSuccessTable = successfulTables[0];
      const finalTargetDomoDatasetId = targetDomoDatasetId || ((firstSuccessTable.magicEtl && firstSuccessTable.magicEtl.outputDatasetId)
        ? firstSuccessTable.magicEtl.outputDatasetId
        : firstSuccessTable.domoDatasetId);

      let domoCardId = 'mock-card-id';
      let domoCardUrl = 'https://mock-domo-url/card/mock-card-id';
      let cardCreationWarning = 'MCP is removed. Card creation skipped/mocked.';

      const finalState = {
        status: 'complete',
        success: true,
        progress: 100,
        reportName,
        domoDatasetId: finalTargetDomoDatasetId,
        domoCardId,
        domoCardUrl,
        migratedTables: results,
        domoDataModelId: domoDataflowResult?.modelId || null,
        domoDataModelUrl: domoDataflowResult?.modelUrl || null,
        measureMigrationSummary: (migrations.get(reportId)?.migratedMeasures || []).map(m => ({
          measureName: m.name,
          classification: m.classification,
          beastModeFormula: m.beastModeFormula || null,
          domoFunctionId: m.domoFunctionId || null,
          status: m.status,
          reason: m.error || null,
        })),
        cardCreationWarning,
        message: cardCreationWarning 
          ? `Migration completed with card creation warning: ${cardCreationWarning}`
          : 'Migration completed successfully.'
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
  }
});

/**
 * GET /api/migration/status/:reportId
 * Exposes SSE channel streaming status updates to the client.
 */
router.get('/status/:reportId', (req, res) => {
  const { reportId } = req.params;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no' // Prevent proxy buffering
  });

  // Push immediate current state if exists
  const current = migrations.get(reportId);
  if (current) {
    res.write(`data: ${JSON.stringify(current)}\n\n`);
  }

  const statusListener = (update) => {
    res.write(`data: ${JSON.stringify(update)}\n\n`);
    if (update.status === 'complete' || update.status === 'error') {
      res.end();
    }
  };

  migrationEmitter.on(reportId, statusListener);

  req.on('close', () => {
    migrationEmitter.off(reportId, statusListener);
  });
});

export default router;
