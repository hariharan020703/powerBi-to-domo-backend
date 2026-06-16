import { Router } from 'express';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import axios from 'axios';
import { env } from '../config/env.js';
import { executeQuery, getDashboardTiles, getDatasetTables, getTableData, getDatasetRelationships, getDatasetColumns, getDatasetTableMeta } from '../services/powerbiService.js';
import { getMcpClient, parseCreateCardResult, parseCreateDatasetResult, parseCreateDashboardResult } from '../mcp/mcpClient.js';
import { createDomoDataset, uploadDataToDomoDataset } from '../services/domoDatasetService.js';
import { resolveRelationships, createDomoDataModel } from '../services/domoDataflowService.js';

const router = Router();
const migrationEmitter = new EventEmitter();

// In-memory database of migration statuses keyed by reportId
const migrations = new Map();

// In-memory mapping of active Python MCP bridge subprocesses keyed by sessionId
const mcpSessions = new Map();

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

  const header = cleanNames.join(',');
  const dataLines = rawRows.map(row => Object.values(row).map(escape).join(','));
  const csvString = [header, ...dataLines].join('\n');

  return { csvString, columns };
}


/**
 * POST /api/migration/start
 * Starts a migration run synchronously (blocks until Claude finishes, but streams logs on SSE).
 */
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

  try {
    let mcpClient;
    try {
      mcpClient = await getMcpClient();
    } catch (mcpConnErr) {
      console.error(`[MIGRATION ERROR] Failed to connect to Domo MCP server:`, mcpConnErr);
      updateStatus(reportId, { status: 'error', progress: 0, message: `MCP Connection failed: ${mcpConnErr.message}` });
      return res.status(500).json({ success: false, status: 'error', progress: 0, message: `MCP Connection failed: ${mcpConnErr.message}` });
    }

    if (isDashboard) {
      // ─── DASHBOARD MIGRATION FLOW ──────────────────────────────────────────
      updateStatus(reportId, { status: 'Fetching dashboard tiles', progress: 15 });
      console.log(`[MIGRATION] Fetching dashboard tiles for workspace ${workspaceId}, dashboard ${reportId}...`);

      let tilesResponse;
      try {
        tilesResponse = await getDashboardTiles(workspaceId, reportId);
      } catch (tileErr) {
        console.error(`[MIGRATION ERROR] Failed to fetch dashboard tiles:`, tileErr.message);
        updateStatus(reportId, { status: 'error', progress: 0, message: `Failed to fetch tiles: ${tileErr.message}` });
        return res.status(500).json({ success: false, status: 'error', progress: 0, message: `Failed to fetch tiles: ${tileErr.message}` });
      }

      const tiles = tilesResponse?.value || [];
      console.log(`[MIGRATION] Found ${tiles.length} tiles on the dashboard.`);

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
        updateStatus(reportId, { status: 'error', progress: 0, message: 'No datasets found on this dashboard.' });
        return res.status(400).json({ success: false, status: 'error', progress: 0, message: 'No datasets found on this dashboard.' });
      }

      console.log(`[MIGRATION] Identified ${uniqueDatasets.size} unique datasets to migrate.`);

      const createdCardIds = [];
      const datasetIds = Array.from(uniqueDatasets.keys());

      // Loop through unique datasets and migrate them
      for (let i = 0; i < datasetIds.length; i++) {
        const targetDatasetId = datasetIds[i];
        const ctx = uniqueDatasets.get(targetDatasetId);
        const baseProgress = 20 + Math.round((i / datasetIds.length) * 60);

        updateStatus(reportId, {
          status: `Analyzing formulas/measures for dataset ${i + 1}/${datasetIds.length}`,
          progress: baseProgress
        });

        // 1. Analyze formulas/measures using DMV queries
        let measuresList = [];
        try {
          console.log(`[MIGRATION] Querying MDSCHEMA_MEASURES for dataset ${targetDatasetId}...`);
          const daxMeasures = await executeQuery(targetDatasetId, 'SELECT [MEASURE_NAME], [EXPRESSION], [MEASUREGROUP_NAME] FROM $SYSTEM.MDSCHEMA_MEASURES');
          measuresList = daxMeasures?.results?.[0]?.tables?.[0]?.rows || [];
        } catch (dmvErr) {
          console.warn(`[MIGRATION] MDSCHEMA_MEASURES DMV failed for dataset ${targetDatasetId}: ${dmvErr.message}. Trying TMSCHEMA_MEASURES...`);
          try {
            const tmsMeasures = await executeQuery(targetDatasetId, 'SELECT [NAME], [EXPRESSION] FROM $SYSTEM.TMSCHEMA_MEASURES');
            const rows = tmsMeasures?.results?.[0]?.tables?.[0]?.rows || [];
            measuresList = rows.map(r => ({ MEASURE_NAME: r.NAME, EXPRESSION: r.EXPRESSION }));
          } catch (tmsErr) {
            console.warn(`[MIGRATION] TMSCHEMA_MEASURES DMV failed for dataset ${targetDatasetId}: ${tmsErr.message}`);
          }
        }

        if (measuresList.length > 0) {
          console.log(`[ANALYSIS] Discovered ${measuresList.length} measures/formulas for dataset ${targetDatasetId}:`);
          for (const m of measuresList) {
            console.log(`  [MEASURE] Name: ${m.MEASURE_NAME} | Formula: ${m.EXPRESSION || '(none)'}`);
          }
          // Log a quick summary update
          updateStatus(reportId, {
            status: `Discovered ${measuresList.length} measures (e.g. ${measuresList[0].MEASURE_NAME})`,
            progress: baseProgress + 5
          });
        } else {
          console.log(`[ANALYSIS] No measures/formulas found for dataset ${targetDatasetId}.`);
        }

        // 2. Discover tables & Fetch Power BI data
        updateStatus(reportId, {
          status: `Fetching PowerBI data for dataset ${i + 1}/${datasetIds.length}`,
          progress: baseProgress + 10
        });

        let powerbiData;
        let tableName = 'Sheet1';
        try {
          powerbiData = await executeQuery(targetDatasetId, `EVALUATE VALUES('Sheet1')`);
        } catch (err) {
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

            if (userTables.length === 0) {
              throw new Error('No user tables found.');
            }

            tableName = userTables[0];
            powerbiData = await executeQuery(targetDatasetId, `EVALUATE VALUES('${tableName}')`);
          } catch (fallbackErr) {
            console.error(`[MIGRATION ERROR] Failed to fetch data for dataset ${targetDatasetId}:`, fallbackErr.message);
            // Skip this dataset or throw? Let's skip to be robust, or throw error if it is the only one.
            continue;
          }
        }

        const pbTable = powerbiData?.results?.[0]?.tables?.[0];
        const rawRows = pbTable?.rows || [];
        const rawColumnNames = rawRows.length > 0 ? Object.keys(rawRows[0]) : [];

        if (!rawRows.length || !rawColumnNames.length) {
          console.warn(`[MIGRATION] Dataset ${targetDatasetId} returned no rows.`);
          continue;
        }

        // 3. Build CSV and detect columns
        const { csvString, columns } = buildCsv(rawRows, rawColumnNames);

        // 4. Create dataset in Domo
        updateStatus(reportId, {
          status: `Uploading dataset ${i + 1}/${datasetIds.length} to Domo`,
          progress: baseProgress + 15
        });

        let createDatasetResult;
        try {
          createDatasetResult = await mcpClient.callTool({
            name: 'create_dataset',
            arguments: {
              name: `${reportName} - ${ctx.title}`,
              schema_columns: columns,
              csv_data: csvString
            }
          });
        } catch (dsErr) {
          console.error(`[MIGRATION ERROR] create_dataset failed:`, dsErr);
          continue;
        }

        const dsText = createDatasetResult.content?.[0]?.text || '';
        const dsResult = parseCreateDatasetResult(dsText);
        if (!dsResult.success) {
          console.error(`[MIGRATION ERROR] Dataset parse failed:`, dsResult.message);
          continue;
        }

        const targetDomoDatasetId = dsResult.datasetId;

        // 5. Create KPI card in Domo
        updateStatus(reportId, {
          status: `Creating card ${i + 1}/${datasetIds.length} in Domo`,
          progress: baseProgress + 20
        });

        const xColumn = columns[0]?.name || '';
        const yColumn = columns.length > 1 ? columns[1]?.name : columns[0]?.name || '';

        let createResult = null;
        try {
          createResult = await mcpClient.callTool({
            name: 'create_card',
            arguments: {
              dataset_id: targetDomoDatasetId,
              card_title: reportName,
              chart_type: 'TABLE',
              x_column: xColumn,
              y_column: yColumn,
              confirm: true
            }
          });
        } catch (createErr) {
          console.error(`[MIGRATION ERROR] Domo card creation failed:`, createErr);
          updateStatus(reportId, { status: 'error', progress: 0, message: `Card creation failed: ${createErr.message}`, migratedTables: results });
          return res.status(500).json({ success: false, status: 'error', message: createErr.message });
        }

        // Guard here — if createResult is still null something unexpected happened
        if (!createResult) {
          updateStatus(reportId, { status: 'error', progress: 0, message: 'Card creation returned no result.' });
          return res.status(500).json({ success: false, message: 'Card creation returned no result.' });
        }

        const textResponse = createResult.content?.[0]?.text || '';
        const parsedResult = parseCreateCardResult(textResponse);

        if (parsedResult.success) {
          const numericCardId = parseInt(parsedResult.domoCardId, 10);
          if (!isNaN(numericCardId)) {
            createdCardIds.push(numericCardId);
          }
        }
      }

      if (createdCardIds.length === 0) {
        updateStatus(reportId, { status: 'error', progress: 0, message: 'Failed to create cards for any dashboard tiles.' });
        return res.status(500).json({ success: false, status: 'error', progress: 0, message: 'Failed to create cards for dashboard tiles.' });
      }

      // 6. Create Domo Dashboard (Page)
      updateStatus(reportId, { status: 'Assembling Domo Dashboard page', progress: 90 });
      console.log(`[MIGRATION] Creating Domo dashboard "${reportName}" with card IDs: ${createdCardIds.join(', ')}`);

      let createDashboardResult;
      try {
        createDashboardResult = await mcpClient.callTool({
          name: 'create_dashboard',
          arguments: {
            name: reportName,
            cardIds: createdCardIds,
            confirm: true
          }
        });
      } catch (dashCreateErr) {
        console.error(`[MIGRATION ERROR] create_dashboard tool failed:`, dashCreateErr);
        updateStatus(reportId, { status: 'error', progress: 0, message: `Dashboard page assembly failed: ${dashCreateErr.message}` });
        return res.status(500).json({ success: false, status: 'error', progress: 0, message: `Dashboard page assembly failed: ${dashCreateErr.message}` });
      }

      const dbText = createDashboardResult.content?.[0]?.text || '';
      const dbResult = parseCreateDashboardResult(dbText);

      if (!dbResult.success) {
        console.error(`[MIGRATION ERROR] Dashboard page parse failed:`, dbResult.message);
        updateStatus(reportId, { status: 'error', progress: 0, message: dbResult.message });
        return res.status(500).json({ success: false, status: 'error', progress: 0, message: dbResult.message });
      }

      const finalState = {
        status: 'complete',
        success: true,
        progress: 100,
        reportName,
        domoDashboardId: dbResult.dashboardId,
        domoCardUrl: dbResult.dashboardUrl, // UI opens cardUrl when clicking View in Domo
        message: 'Dashboard migration completed successfully.'
      };

      updateStatus(reportId, finalState);
      return res.status(200).json(finalState);

    } else {
      // ─── REPORT MIGRATION FLOW ─────────────────────────────────────────────
      if (!datasetId) {
        return res.status(400).json({ status: 'error', message: 'datasetId is required for report migration.' });
      }

      updateStatus(reportId, { status: 'Fetching PowerBI data', progress: 10 });

      // Step 1: Discover tables
      console.log(`[MIGRATION] Discovering tables for dataset ID: ${datasetId}...`);
      let tableNames = [];
      try {
        tableNames = await getDatasetTables(datasetId);
      } catch (discErr) {
        console.error(`[MIGRATION ERROR] Failed to discover tables:`, discErr);
      }

      if (!tableNames || tableNames.length === 0) {
        const errorMsg = 'No tables discovered or fallback discovery failed.';
        updateStatus(reportId, { status: 'error', progress: 0, message: errorMsg });
        return res.status(500).json({
          success: false,
          status: 'error',
          progress: 0,
          message: errorMsg
        });
      }

      updateStatus(reportId, {
        status: 'Discovering tables',
        progress: 15,
        tables: tableNames
      });

      console.log(`[MIGRATION] Discovered tables: ${tableNames.join(', ')}`);

      // Step 2: Migrate each table sequentially
      const results = [];
      const previousState = migrations.get(reportId);
      let firstTableColumns = null;

      for (let i = 0; i < tableNames.length; i++) {
        const tableName = tableNames[i];

        // Check if table was already successfully uploaded/migrated in a previous run for this report
        const alreadyMigratedTable = previousState?.migratedTables?.find(
          t => t.tableName === tableName && t.status === 'success' && t.domoDatasetId
        );

        let domoDatasetId = null;
        let rowCount = 0;

        if (alreadyMigratedTable) {
          console.log(`[MIGRATION] Table '${tableName}' was already successfully migrated in a previous run. Reusing dataset ID: ${alreadyMigratedTable.domoDatasetId}`);
          domoDatasetId = alreadyMigratedTable.domoDatasetId;
          rowCount = alreadyMigratedTable.rowCount || 0;
          results.push({
            tableName,
            domoDatasetId,
            rowCount,
            columns: alreadyMigratedTable.columns || [],
            status: 'success'
          });
        } else {
          try {
            console.log(`[MIGRATION] Processing table: ${tableName}`);

            // 2a. Fetch table data from PowerBI
            const powerbiData = await getTableData(datasetId, tableName);
            const pbTable = powerbiData?.results?.[0]?.tables?.[0];
            const rawRows = pbTable?.rows || [];
            const rawColumnNames = rawRows.length > 0 ? Object.keys(rawRows[0]) : [];

            if (!rawRows.length || !rawColumnNames.length) {
              throw new Error(`Table '${tableName}' returned no data rows.`);
            }

            rowCount = rawRows.length;
            console.log(`[MIGRATION] PowerBI returned ${rowCount} rows for table '${tableName}'.`);

            // 2b. Build columns schema list using current buildCsv helper (for type detection)
            const { columns } = buildCsv(rawRows, rawColumnNames);
            if (!firstTableColumns) {
              firstTableColumns = columns;
            }

            // 2c. Create Domo dataset
            console.log(`[MIGRATION] Creating Domo dataset for table '${tableName}'...`);
            domoDatasetId = await createDomoDataset(tableName, columns);
            console.log(`[MIGRATION] Dataset created in Domo. ID: ${domoDatasetId}`);

            // 2d. Upload data
            console.log(`[MIGRATION] Uploading data for table '${tableName}' to Domo dataset ${domoDatasetId}...`);
            await uploadDataToDomoDataset(domoDatasetId, columns, rawRows);

            results.push({
              tableName,
              domoDatasetId,
              rowCount,
              columns,
              status: 'success'
            });
          } catch (tableErr) {
            console.error(`[MIGRATION ERROR] Failed to migrate table '${tableName}':`, tableErr);
            results.push({
              tableName,
              domoDatasetId: null,
              rowCount: 0,
              status: 'failed',
              error: tableErr.message
            });
          }
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

      // If ALL tables failed, error out
      const successfulTables = results.filter(t => t.status === 'success');
      if (successfulTables.length === 0) {
        const errorMsg = 'All tables failed to migrate or no tables were successfully created.';
        updateStatus(reportId, { status: 'error', progress: 0, message: errorMsg, migratedTables: results });
        return res.status(500).json({
          success: false,
          status: 'error',
          progress: 0,
          message: errorMsg,
          migratedTables: results
        });
      }

      // Step 3: Dataflow Migration
      updateStatus(reportId, { status: 'Migrating model view to Domo dataflow', progress: 72, migratedTables: results });

      let domoDataflowResult = null;
      try {
        // Build a map of tableName -> domoDatasetId from successful migrations
        const tableToDatasetId = {};
        const tableToColumns = {};
        for (const t of successfulTables) {
          tableToDatasetId[t.tableName] = t.domoDatasetId;
          tableToColumns[t.tableName] = t.columns;
        }

        // Fetch Power BI model relationships + metadata needed to resolve IDs to names
        const relationships = await getDatasetRelationships(datasetId);

        if (relationships.length === 0) {
          console.log('[MIGRATION] No relationships found in Power BI model — skipping dataflow creation.');
        } else {
          const resolvedRels = resolveRelationships(relationships);

          if (resolvedRels.length > 0) {
            domoDataflowResult = await createDomoDataModel(
              `${reportName} - Model`,
              resolvedRels,
              tableToDatasetId,
              tableToColumns
            );
            console.log(`[MIGRATION] Data model created: ${domoDataflowResult.modelUrl}`);
          } else {
            console.warn('[MIGRATION] Relationships found but none could be resolved to table/column names.');
          }
        }
      } catch (dataflowErr) {
        // Non-fatal — log and continue to card creation
        console.error(`[MIGRATION ERROR] Dataflow creation failed (non-fatal): ${dataflowErr.message}`);
      }

      // Step 4: Connect to Domo MCP
      updateStatus(reportId, { status: 'Connecting to Domo MCP', progress: 75, migratedTables: results });
      console.log(`[MIGRATION] Connecting to Domo MCP for card creation...`);

      // Step 5: Create Domo card using the first successfully migrated table
      updateStatus(reportId, { status: 'Creating Domo card', progress: 85, migratedTables: results });

      const firstSuccessTable = successfulTables[0];
      const targetDomoDatasetId = firstSuccessTable.domoDatasetId;
      console.log(`[MIGRATION] Creating Domo card using first successful table '${firstSuccessTable.tableName}' (Dataset ID: ${targetDomoDatasetId})`);

      if (!firstTableColumns && firstSuccessTable) {
        try {
          const firstTableData = await getTableData(datasetId, firstSuccessTable.tableName);
          const pbFirstTable = firstTableData?.results?.[0]?.tables?.[0];
          const rawFirstRows = pbFirstTable?.rows || [];
          const rawFirstColumnNames = rawFirstRows.length > 0 ? Object.keys(rawFirstRows[0]) : [];
          const cleanFirstNames = rawFirstColumnNames.map(cleanColumnName);
          firstTableColumns = cleanFirstNames.map(name => ({ name }));
        } catch (firstTableErr) {
          console.warn(`[MIGRATION] Failed to extract column names for card mapping:`, firstTableErr);
        }
      }

      const allColumns = firstTableColumns?.map(c => c.name) || [];
      const xColumn = allColumns[0] || '';
      const yColumn = allColumns[1] || xColumn;

      const createResult = await mcpClient.callTool({
        name: 'create_card',
        arguments: {
          dataset_id: targetDomoDatasetId,
          card_title: reportName,
          chart_type: 'TABLE',
          x_column: xColumn,
          y_column: yColumn,
          columns: allColumns,   // pass full list so MCP knows all columns
          confirm: true
        }
      });
      const textResponse = createResult.content?.[0]?.text || '';
      const parsedResult = parseCreateCardResult(textResponse);

      if (!parsedResult.success) {
        console.error(`[MIGRATION ERROR] Domo card creation returned failure status:`, parsedResult.message);
        updateStatus(reportId, { status: 'error', progress: 0, message: parsedResult.message, migratedTables: results });
        return res.status(500).json({ success: false, status: 'error', progress: 0, message: parsedResult.message, migratedTables: results });
      }

      const { domoCardId, domoCardUrl } = parsedResult;
      console.log(`[MIGRATION] Domo card successfully created. ID: ${domoCardId}, URL: ${domoCardUrl}`);

      const finalState = {
        status: 'complete',
        success: true,
        progress: 100,
        reportName,
        domoDatasetId: targetDomoDatasetId,
        domoCardId,
        domoCardUrl,
        migratedTables: results,
        domoDataModelId: domoDataflowResult?.modelId || null,
        domoDataModelUrl: domoDataflowResult?.modelUrl || null,
        message: 'Migration completed successfully.'
      };

      updateStatus(reportId, finalState);
      return res.status(200).json(finalState);
    }

  } catch (err) {
    console.error(`[MIGRATION ERROR] Unhandled exception:`, err);
    updateStatus(reportId, { status: 'error', progress: 0, message: err.message });
    return res.status(500).json({
      success: false,
      status: 'error',
      progress: 0,
      message: `Internal exception: ${err.message}`
    });
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

/**
 * GET /api/migration/mcp/sse
 * Starts the stdio-to-SSE bridge, spawning Python subprocess for gwcteq-domo-mcp.
 */
router.get('/mcp/sse', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  const sessionId = Math.random().toString(36).substring(2, 15);

  console.log(`[MCP BRIDGE] Spawning Node MCP subprocess for Session ${sessionId} at ${env.domoMcpScriptPath}`);

  // Spawn Node MCP script
  const mcpProcess = spawn('node', [env.domoMcpScriptPath], {
    env: {
      ...process.env,
      DOMO_CLIENT_DOMAIN: env.domoClientDomain,
      DOMO_CLIENT_TOKEN: env.domoClientToken,
      DOMO_AGENT_EMAIL: env.domoAgentEmail,
      DOMO_AGENT_ROLE: env.domoAgentRole
    }
  });

  mcpSessions.set(sessionId, mcpProcess);

  // Write endpoint event as required by MCP SSE specifications
  const postUrl = `${req.protocol}://${req.get('host')}/api/migration/mcp/messages?sessionId=${sessionId}`;
  res.write(`event: endpoint\ndata: ${postUrl}\n\n`);

  let buffer = '';
  mcpProcess.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep trailing incomplete block

    for (const line of lines) {
      if (line.trim()) {
        res.write(`event: message\ndata: ${line.trim()}\n\n`);
      }
    }
  });

  mcpProcess.stderr.on('data', (data) => {
    console.error(`[NODE MCP STDERR] Session ${sessionId}: ${data}`);
  });

  mcpProcess.on('exit', (code) => {
    console.log(`[MCP BRIDGE] Node subprocess for Session ${sessionId} exited with code ${code}`);
    mcpSessions.delete(sessionId);
    res.end();
  });

  req.on('close', () => {
    console.log(`[MCP BRIDGE] SSE client closed connection. Terminating session ${sessionId}`);
    mcpProcess.kill();
    mcpSessions.delete(sessionId);
  });
});

/**
 * POST /api/migration/mcp/messages
 * Submits Client JSON-RPC payload message to Node stdio channel.
 */
router.post('/mcp/messages', (req, res) => {
  const { sessionId } = req.query;
  const mcpProcess = mcpSessions.get(sessionId);

  if (!mcpProcess) {
    return res.status(404).json({ error: 'MCP session not active or terminated.' });
  }

  // Push JSON string newline delimited to stdin
  mcpProcess.stdin.write(JSON.stringify(req.body) + '\n');
  return res.status(200).send('OK');
});

export default router;
