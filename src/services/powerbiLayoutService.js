import axios from 'axios';
import AdmZip from 'adm-zip';
import { env } from '../config/env.js';
import { getAccessToken } from './authService.js';

async function getAuthHeaders() {
  const token = await getAccessToken();
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json'
  };
}

/**
 * Cleans a raw PowerBI visual field reference by removing outer function calls
 * (e.g. Sum(Credit_Cards.Credit Limit) -> Credit_Cards.Credit Limit) and table prefixes.
 */
export function cleanRawFieldName(fieldName) {
  if (!fieldName) return '';
  let s = String(fieldName).trim();

  // Recursively remove any outer function calls like Sum(Field), Average(Field), etc.
  let matched = true;
  while (matched) {
    const match = s.match(/^[a-zA-Z_]+\((.*)\)$/);
    if (match) {
      s = match[1].trim();
    } else {
      matched = false;
    }
  }

  // Strip table prefix if present: "TableName.ColumnName" -> "ColumnName"
  if (s.includes('.')) {
    s = s.split('.').slice(1).join('.').trim();
  }

  // Remove surrounding quotes, non-breaking spaces, and extra whitespace
  return s
    .replace(/^['"`]|['"`]$/g, '')
    .replace(/\u00A0/g, ' ')
    .trim();
}

/**
 * Parses the raw legacy Report/Layout JSON into a normalized array of visuals.
 */
export function parseReportLayout(layoutData) {
  const sections = layoutData.sections || [];
  const normalizedPages = [];

  for (const section of sections) {
    const pageName = section.displayName || section.name || `Page_${section.id}`;
    const pageOrder = section.ordinal ?? 0;
    const visualContainers = section.visualContainers || [];
    const normalizedVisuals = [];

    for (const vc of visualContainers) {
      // config is a JSON string nested inside the layout JSON
      let config = {};
      try {
        config = typeof vc.config === 'string' ? JSON.parse(vc.config) : (vc.config || {});
      } catch (e) {
        console.warn(`[LAYOUT PARSER] Failed to parse config for visual ${vc.id}:`, e.message);
      }

      const singleVisual = config.singleVisual || {};
      const visualType = singleVisual.visualType || 'unknown';
      const isHidden = singleVisual.isHidden || false;

      // Extract title from visual objects
      let title = null;
      const titleObj = singleVisual.objects?.title?.[0]?.properties;
      if (titleObj?.text?.expr?.Literal?.Value) {
        title = titleObj.text.expr.Literal.Value.replace(/^'|'$/g, '');
      } else if (titleObj?.text?.expr?.ScopedEval?.Expression?.Literal?.Value) {
        title = titleObj.text.expr.ScopedEval.Expression.Literal.Value.replace(/^'|'$/g, '');
      }

      // Extract data roles (fields used by the visual)
      const projections = singleVisual.projections || {};
      const queryState = singleVisual.prototypeQuery || {};
      const fields = {
        category: [],
        values: [],
        legend: [],
        axis: [],
        rows: [],
        columns: [],
        tooltips: [],
        filters: [],
      };

      for (const [role, items] of Object.entries(projections)) {
        const colNames = Array.isArray(items)
          ? items.map(i => i.queryRef || i.displayName || JSON.stringify(i))
          : [];
        if (role === 'Category' || role === 'Axis' || role === 'RowGrouping') {
          fields.category.push(...colNames);
        } else if (role === 'Y' || role === 'Values') {
          fields.values.push(...colNames);
        } else if (role === "ColumnGrouping") {
          fields.legend.push(...colNames);
        } else if (role === 'Legend') {
          fields.legend.push(...colNames);
        } else if (role === 'Tooltips') {
          fields.tooltips.push(...colNames);
        } else if (role === 'Rows') {
          fields.rows.push(...colNames);
        } else if (role === 'Columns') {
          fields.columns.push(...colNames);
        } else {
          // catch-all for unknown roles
          fields.values.push(...colNames);
        }
      }

      // Parse filters
      let filters = [];
      try {
        filters = typeof vc.filters === 'string' ? JSON.parse(vc.filters) : (vc.filters || []);
      } catch (e) { }

      // Extract formatting
      const formatting = {
        fillColor: null,
        borderColor: null,
        fontColor: null,
        backgroundColor: null,
        objects: singleVisual.objects || {},
      };
      const fillObj = singleVisual.objects?.fill?.[0]?.properties?.fillColor?.solid?.color?.expr?.Literal?.Value;
      if (fillObj) formatting.fillColor = fillObj.replace(/^'|'$/g, '');
      const bgObj = singleVisual.objects?.background?.[0]?.properties?.fillColor?.solid?.color?.expr?.Literal?.Value;
      if (bgObj) formatting.backgroundColor = bgObj.replace(/^'|'$/g, '');

      normalizedVisuals.push({
        id: vc.id,
        page: pageName,
        visualType,
        title,
        isHidden,
        position: {
          x: vc.x ?? 0,
          y: vc.y ?? 0,
          z: vc.z ?? 0,
          width: vc.width ?? 0,
          height: vc.height ?? 0,
        },
        fields,
        filters,
        formatting,
        rawConfig: config,
      });
    }

    normalizedPages.push({
      id: section.id,
      name: pageName,
      order: pageOrder,
      width: section.width ?? 1280,
      height: section.height ?? 720,
      visuals: normalizedVisuals,
    });
  }

  return normalizedPages;
}

// ─── Power BI → Domo chart type mapping ───────────────────────────────────────
const VISUAL_TYPE_MAP = {
  // Bar charts
  barChart: { domoChartType: 'badge_horiz_bar', skip: false },
  clusteredBarChart: { domoChartType: 'badge_horiz_bar', skip: false },
  stackedBarChart: { domoChartType: 'badge_horiz_stackedbar', skip: false },
  hundredPercentStackedBarChart: { domoChartType: 'badge_horiz_stackedbar', skip: false },

  // Column charts
  columnChart: { domoChartType: 'badge_vert_bar', skip: false },
  clusteredColumnChart: { domoChartType: 'badge_vert_bar', skip: false },
  stackedColumnChart: { domoChartType: 'badge_vert_stackedbar', skip: false },
  hundredPercentStackedColumnChart: { domoChartType: 'badge_vert_stackedbar', skip: false },

  // Line charts
  lineChart: { domoChartType: 'badge_two_trendline', skip: false },
  areaChart: { domoChartType: 'badge_curved_line', skip: false },
  stackedAreaChart: { domoChartType: 'badge_curved_line', skip: false },
  hundredPercentStackedAreaChart: { domoChartType: 'badge_curved_line', skip: false },

  // Combo charts
  lineStackedColumnComboChart: { domoChartType: 'badge_vert_stackedbar', skip: false },
  lineClusteredColumnComboChart: { domoChartType: 'badge_vert_bar', skip: false },
  ribbonChart: { domoChartType: 'badge_vert_stackedbar', skip: false },

  // Pie / Donut
  pieChart: { domoChartType: 'badge_pie', skip: false },
  donutChart: { domoChartType: 'badge_donut', skip: false },
  sunburstChart: { domoChartType: 'badge_pie', skip: false },

  // Scatter / Bubble
  scatterChart: { domoChartType: 'badge_bubble', skip: false },
  bubbleChart: { domoChartType: 'badge_bubble', skip: false },

  // Funnel / Waterfall
  funnel: { domoChartType: 'badge_funnel', skip: false },
  waterfallChart: { domoChartType: 'badge_vert_stackedbar', skip: false },

  // Table / Matrix
  tableEx: { domoChartType: 'badge_basic_table', skip: false },
  table: { domoChartType: 'badge_basic_table', skip: false },
  matrix: { domoChartType: 'badge_basic_table', skip: false },

  // KPI / Card / Gauge
  card: { domoChartType: 'badge_single_value', skip: false },
  multiRowCard: { domoChartType: 'badge_basic_table', skip: false },
  kpi: { domoChartType: 'badge_single_value', skip: false },
  gauge: { domoChartType: 'badge_filledgauge', skip: false },

  // Map visuals — fallback to bar since Domo map requires lat/long
  map: { domoChartType: 'badge_vert_bar', skip: false },
  filledMap: { domoChartType: 'badge_vert_bar', skip: false },
  azureMap: { domoChartType: 'badge_vert_bar', skip: false },
  shapeMap: { domoChartType: 'badge_vert_bar', skip: false },

  // Treemap / Heatmap
  treemap: { domoChartType: 'badge_tree_map', skip: false },
  heatMap: { domoChartType: 'badge_vert_stackedbar', skip: false },

  // Layout/decoration — skip these
  shape: { domoChartType: null, skip: true, reason: 'Decorative shape' },
  image: { domoChartType: null, skip: true, reason: 'Image visual' },
  textbox: { domoChartType: null, skip: true, reason: 'Text box' },
  actionButton: { domoChartType: null, skip: true, reason: 'Navigation button' },
  slicer: { domoChartType: null, skip: true, reason: 'Slicer — add as Domo page filter manually' },
  unknown: { domoChartType: null, skip: true, reason: 'Background container' },
};

/**
 * Converts a parsed page/visual structure into Domo card creation configs.
 * Returns { cardsToCreate, skipped, migrationReport }
 */
export function mapPagesToDomo(pages, domoDatasetIdMap, domoMeasureIdMap, datasetColumnsMap, columnCaseMap, datasetColumnTypesMap) {
  const cardsToCreate = [];
  const skipped = [];
  const migrationReport = {
    totalVisuals: 0,
    willMigrate: 0,
    willSkip: 0,
    byPage: [],
  };

  for (const page of pages) {
    const pageReport = {
      pageName: page.name,
      pageId: page.id,
      totalVisuals: page.visuals.length,
      migrated: 0,
      skipped: 0,
      visuals: [],
    };

    for (const visual of page.visuals) {
      migrationReport.totalVisuals++;
      const mapping = VISUAL_TYPE_MAP[visual.visualType];

      if (!mapping || mapping.skip) {
        console.log('[UNMAPPED VISUAL]', visual.visualType, JSON.stringify(visual.fields));
        skipped.push({
          id: visual.id,
          page: page.name,
          visualType: visual.visualType,
          reason: mapping?.reason || `Unknown visual type: ${visual.visualType}`,
        });
        migrationReport.willSkip++;
        pageReport.skipped++;
        pageReport.visuals.push({ id: visual.id, visualType: visual.visualType, action: 'skip', reason: mapping?.reason });
        continue;
      }

      // 1. Resolve target dataset ID from visual fields first (before filtering measures)
      let visualTableName = null;
      const allVisualFieldsList = [
        ...visual.fields.category,
        ...visual.fields.values,
        ...visual.fields.legend,
        ...visual.fields.rows,
        ...visual.fields.columns,
        ...visual.fields.tooltips,
        ...(visual.fields.axis || []),
      ].filter(Boolean);

      let fallbackTableName = null;

      for (const f of allVisualFieldsList) {
        const parts = f.replace(/^['"`]|['"`]$/g, '').split('.');
        if (parts.length >= 2) {
          const tName = parts[0].trim();
          if (tName === '_Measures' || tName === '_measures' || tName === 'Measures') continue;
          if (/^calendar/i.test(tName) || /date/i.test(tName)) {
            fallbackTableName = fallbackTableName || tName;
            continue;
          }
          visualTableName = tName;
          break;
        }
      }

      if (!visualTableName) visualTableName = fallbackTableName;
      const visualDatasetId = (visualTableName && domoDatasetIdMap?.[visualTableName])
        || (domoDatasetIdMap ? Object.values(domoDatasetIdMap)[0] : null);

      // 2. Define isMeasureField using the resolved dataset info
      const knownMeasureNames = new Set(
        Object.keys(domoMeasureIdMap || {}).map(k => k.trim().toLowerCase())
      );

      const isMeasureField = (f) => {
        if (!f) return false;

        // If it starts with _Measures or Measures, it is definitely a measure
        if (f.startsWith('_Measures.') ||
          f.startsWith('_measures.') ||
          f.startsWith('Measures.')) {
          return true;
        }

        const cleanName = cleanRawFieldName(f).trim().toLowerCase();
        const parts = f.replace(/^['"`]|['"`]$/g, '').split('.');
        let tableName = visualTableName;

        if (parts.length >= 2) {
          const tName = parts[0].trim();
          if (tName === '_Measures' || tName === '_measures' || tName === 'Measures') {
            return true;
          }
          tableName = tName;
        }

        // Look up in physical columns of resolved table/dataset
        const physicalCols = datasetColumnsMap?.[tableName] ||
          datasetColumnsMap?.[visualDatasetId] ||
          [];
        if (physicalCols.length > 0) {
          const hasPhysicalCol = physicalCols.some(col => col.toLowerCase() === cleanName.toLowerCase());
          if (!hasPhysicalCol) {
            return true; // Not in physical columns -> must be a measure!
          }
        }

        return knownMeasureNames.has(cleanName) || knownMeasureNames.has(f.trim().toLowerCase());
      };

      const isDateHierarchy = (f) =>
        f.includes('Date Hierarchy') ||
        f.includes('.Variation.') ||
        f.includes('DateHierarchy');

      // Map measure fields to their corresponding calculation column names
      const resolveMeasureOrColumn = (f) => {
        if (!f) return f;
        if (isMeasureField(f)) {
          const cleanName = cleanRawFieldName(f).trim().toLowerCase();
          const beastModeId = domoMeasureIdMap?.[cleanName];
          if (beastModeId) {
            return String(beastModeId).startsWith('calculation_') ? beastModeId : `calculation_${beastModeId}`;
          }
          return null; // Filter out unmapped measures so they don't break card creation
        }
        return f;
      };

      const cleanedVisual = {
        ...visual,
        fields: {
          category: visual.fields.category.map(resolveMeasureOrColumn).filter(f => f && !isDateHierarchy(f)),
          values: visual.fields.values.map(resolveMeasureOrColumn).filter(f => f && !isDateHierarchy(f)),
          legend: visual.fields.legend.map(resolveMeasureOrColumn).filter(f => f && !isDateHierarchy(f)),
          rows: visual.fields.rows.map(resolveMeasureOrColumn).filter(f => f && !isDateHierarchy(f)),
          columns: visual.fields.columns.map(resolveMeasureOrColumn).filter(f => f && !isDateHierarchy(f)),
          tooltips: visual.fields.tooltips.map(resolveMeasureOrColumn).filter(f => f && !isDateHierarchy(f)),
          filters: visual.fields.filters,
          axis: (visual.fields.axis || []).map(resolveMeasureOrColumn).filter(f => f && !isDateHierarchy(f)),
        },
      };

      // Build Beast Mode IDs from measure fields
      const allMeasureFields = [
        ...visual.fields.category,
        ...visual.fields.values,
        ...visual.fields.legend,
        ...visual.fields.rows,
        ...visual.fields.columns,
      ].filter(isMeasureField)
        .map(f => cleanRawFieldName(f));

      const beastModeIds = allMeasureFields
        .map(measureName => domoMeasureIdMap?.[measureName.trim().toLowerCase()])
        .filter(Boolean);

      const tableName = visualTableName;
      const domoDatasetId = visualDatasetId;

      // Resolve exact column casing using dataset schema
      // Power BI queryRef fields look like "TableName.ColumnName" — strip prefix first,
      // then match against Domo dataset's actual column names (case-insensitive)
      const resolveColumnName = (colName) => {
        if (!colName) return colName;
        if (colName.startsWith('calculation_')) return colName; // Keep calculation columns as-is
        const cleanName = cleanRawFieldName(colName);
        const dsMap = columnCaseMap?.[domoDatasetId] || {};
        const rawLower = colName.replace(/^['"`]|['"`]$/g, '').trim().toLowerCase();

        // 1. Try exact table-prefixed match (e.g. "orders.quantity")
        if (dsMap[rawLower]) {
          return dsMap[rawLower];
        }
        // 2. Try clean field name match (e.g. "quantity")
        if (dsMap[cleanName.toLowerCase()]) {
          return dsMap[cleanName.toLowerCase()];
        }
        return cleanName;
      };

      // Apply resolution to cleanedVisual fields
      const resolvedVisual = {
        ...cleanedVisual,
        fields: {
          category: cleanedVisual.fields.category.map(resolveColumnName),
          values: cleanedVisual.fields.values.map(resolveColumnName),
          legend: cleanedVisual.fields.legend.map(resolveColumnName),
          rows: cleanedVisual.fields.rows.map(resolveColumnName),
          columns: cleanedVisual.fields.columns.map(resolveColumnName),
          tooltips: cleanedVisual.fields.tooltips.map(resolveColumnName),
          filters: cleanedVisual.fields.filters,
          axis: cleanedVisual.fields.axis.map(resolveColumnName),
        },
      };

      const fallbackCols = datasetColumnsMap?.[tableName] ||
        datasetColumnsMap?.[domoDatasetId] || [];
      let columns = buildDomoColumns(resolvedVisual, mapping.domoChartType, fallbackCols, datasetColumnTypesMap, domoDatasetId);

      // If columns is null but we have Beast Mode IDs, create with a fallback physical column
      if (!columns && beastModeIds.length > 0) {
        const anyFallbackCol = (fallbackCols && fallbackCols.length > 0)
          ? fallbackCols[0]
          : null;
        if (anyFallbackCol) {
          const isTableChart = mapping.domoChartType === 'badge_basic_table';
          console.log(`[LAYOUT MAPPER] Visual ${visual.id} uses only Beast Mode measures. Using fallback column '${anyFallbackCol}'${isTableChart ? '' : ' with COUNT'}.`);
          columns = [{
            column: anyFallbackCol,
            mapping: 'VALUE',
            ...(isTableChart ? {} : { aggregation: 'COUNT' })
          }];
        }
      }

      // Skip this visual if no valid columns found
      if (!columns) {
        skipped.push({
          id: visual.id,
          page: page.name,
          visualType: visual.visualType,
          reason: 'No valid physical columns found — visual uses only DAX measures without Beast Mode mapping',
        });
        migrationReport.willSkip++;
        pageReport.skipped++;
        pageReport.visuals.push({
          id: visual.id,
          visualType: visual.visualType,
          action: 'skip',
          reason: 'No valid physical columns',
        });
        continue;
      }

      cardsToCreate.push({
        powerBiVisualId: visual.id,
        powerBiVisualType: visual.visualType,
        page: page.name,
        pageOrder: page.order,
        cardName: visual.title || `${page.name} - ${visual.visualType} (${visual.id})`,
        domoChartType: mapping.domoChartType,
        domoDatasetId,
        columns,
        beastModeIds,
        position: visual.position,
        fields: visual.fields,
      });

      migrationReport.willMigrate++;
      pageReport.migrated++;
      pageReport.visuals.push({
        id: visual.id,
        visualType: visual.visualType,
        domoChartType: mapping.domoChartType,
        action: 'migrate',
        columnCount: columns.length,
      });
    }

    migrationReport.byPage.push(pageReport);
  }

  return { cardsToCreate, skipped, migrationReport };
}

function buildDomoColumns(visual, domoChartType, fallbackColumns, datasetColumnTypesMap, domoDatasetId) {
  const isTable = domoChartType === 'badge_basic_table';
  const isPie = ['badge_pie', 'badge_donut'].includes(domoChartType);
  const isBubble = domoChartType === 'badge_bubble';
  const isFunnel = domoChartType === 'badge_funnel';
  const isSingleValue = domoChartType === 'badge_single_value';
  const isGauge = domoChartType === 'badge_filledgauge';

  const clean = (f) => cleanRawFieldName(f);

  const getColType = (colName) => {
    if (!colName) return 'STRING';
    if (colName.startsWith('calculation_')) return 'DOUBLE';
    const cleanName = clean(colName).toLowerCase();
    const type = datasetColumnTypesMap?.[`${domoDatasetId}.${cleanName}`] || 'STRING';
    return type.toUpperCase();
  };

  const isNumeric = (colName) => {
    const type = getColType(colName);
    return ['LONG', 'DOUBLE', 'DECIMAL', 'INTEGER', 'NUMERIC'].includes(type);
  };

  const isDate = (colName) => {
    const type = getColType(colName);
    return ['DATE', 'DATETIME', 'TIME', 'TIMESTAMP'].includes(type);
  };

  const getColAggregation = (colName, defaultAgg = 'SUM') => {
    if (colName.startsWith('calculation_')) return null;
    if (isNumeric(colName)) return defaultAgg;
    if (isDate(colName)) return 'MAX';
    return 'COUNT';
  };

  // ── Single Value (KPI / Card) ──────────────────────────────────────────────
  if (isSingleValue) {
    const valueCol = visual.fields.values[0] || visual.fields.category[0];
    if (!valueCol) {
      return null; // Skip KPI creation entirely if no visual fields are mapped
    }
    const cleanColName = clean(valueCol);
    const agg = getColAggregation(cleanColName, 'SUM');
    const resultCols = [{
      column: cleanColName,
      mapping: 'VALUE',
      ...(agg ? { aggregation: agg } : {})
    }];

    // Look for a date field in axis or category for trend/dateGrain
    const dateCol = [
      ...(visual.fields.axis || []),
      ...(visual.fields.category || [])
    ].find(f => f && isDate(clean(f)));

    if (dateCol) {
      const cleanDateCol = clean(dateCol);
      resultCols.push({
        column: cleanDateCol,
        mapping: 'TREND',
        calendar: true
      });
    }

    return resultCols;
  }

  // ── Gauge Chart ─────────────────────────────────────────────────────────────
  if (isGauge) {
    const uniqueFields = [...new Set([
      ...visual.fields.values,
      ...visual.fields.category
    ])].filter(Boolean);

    if (uniqueFields.length === 0) {
      if (fallbackColumns && fallbackColumns.length > 0) {
        const col1 = clean(fallbackColumns[0]);
        const col2 = clean(fallbackColumns[1] || fallbackColumns[0]);
        return [
          { column: col1, mapping: 'CURRENT', aggregation: 'COUNT' },
          { column: col2, mapping: 'TARGET', aggregation: 'COUNT' }
        ];
      }
      return null;
    }

    const col1 = clean(uniqueFields[0]);
    const col2 = uniqueFields[1] ? clean(uniqueFields[1]) : col1;

    const isDate1 = isDate(col1);
    const isDate2 = isDate(col2);

    const agg1 = getColAggregation(col1, 'SUM');
    const agg2 = getColAggregation(col2, 'SUM');

    return [
      {
        column: col1,
        mapping: 'CURRENT',
        ...(agg1 ? { aggregation: agg1 } : {}),
        ...(isDate1 ? { calendar: true } : {})
      },
      {
        column: col2,
        mapping: 'TARGET',
        ...(agg2 ? { aggregation: agg2 } : {}),
        ...(isDate2 ? { calendar: true } : {})
      }
    ];
  }

  if (isTable) {
    const allFields = [
      ...visual.fields.category,
      ...visual.fields.rows,
      ...visual.fields.columns,
      ...visual.fields.values,
    ].filter(Boolean);
    if (allFields.length === 0) return null;
    return allFields.map(f => ({ column: clean(f), mapping: 'VALUE' }));
  }

  if (isPie) {
    let categoryCol = visual.fields.category[0] || visual.fields.legend[0];
    let valueCol = visual.fields.values[0];
    if (!categoryCol && valueCol) {
      categoryCol = (fallbackColumns || [])[0] || 'id';
    }
    if (categoryCol && !valueCol) {
      const cleanCat = clean(categoryCol);
      const cleanVal = (fallbackColumns || [])[0] || cleanCat;
      const agg = getColAggregation(cleanVal, 'COUNT');
      return [
        { column: cleanCat, mapping: 'ITEM' },
        { column: cleanVal, mapping: 'VALUE', ...(agg ? { aggregation: agg } : {}) },
      ];
    }
    if (!categoryCol || !valueCol) return null;
    const cleanCat = clean(categoryCol);
    const cleanVal = clean(valueCol);
    const agg = getColAggregation(cleanVal, 'SUM');
    return [
      { column: cleanCat, mapping: 'ITEM' },
      { column: cleanVal, mapping: 'VALUE', ...(agg ? { aggregation: agg } : {}) },
    ];
  }

  if (isBubble) {
    const xCol = visual.fields.category[0];
    const yCol = visual.fields.values[0];
    const sizeCol = visual.fields.values[1] || visual.fields.values[0];
    const aggY = getColAggregation(clean(yCol), 'SUM');
    const aggS = getColAggregation(clean(sizeCol), 'SUM');
    return [
      xCol ? { column: clean(xCol), mapping: 'ITEM' } : null,
      yCol ? { column: clean(yCol), mapping: 'VALUE', ...(aggY ? { aggregation: aggY } : {}) } : null,
      sizeCol ? { column: clean(sizeCol), mapping: 'VALUE', ...(aggS ? { aggregation: aggS } : {}) } : null,
    ].filter(Boolean);
  }

  if (isFunnel) {
    let labelCol = visual.fields.category[0];
    let valueCol = visual.fields.values[0];
    if (!labelCol && valueCol) {
      labelCol = (fallbackColumns || [])[0] || 'id';
    }
    if (labelCol && !valueCol) {
      const cleanLabel = clean(labelCol);
      const cleanVal = (fallbackColumns || [])[0] || cleanLabel;
      const agg = getColAggregation(cleanVal, 'COUNT');
      return [
        { column: cleanLabel, mapping: 'ITEM' },
        { column: cleanVal, mapping: 'VALUE', ...(agg ? { aggregation: agg } : {}) },
      ];
    }
    if (!labelCol || !valueCol) return null;
    const cleanLabel = clean(labelCol);
    const cleanVal = clean(valueCol);
    const agg = getColAggregation(cleanVal, 'SUM');
    return [
      { column: cleanLabel, mapping: 'ITEM' },
      { column: cleanVal, mapping: 'VALUE', ...(agg ? { aggregation: agg } : {}) },
    ];
  }

  // Default: bar/column/line/combo/area
  const categoryFields = visual.fields.category
    .filter(f => f && !f.startsWith('CountNonNull('))
    .map(f => ({ column: clean(f), mapping: 'ITEM' }));

  const valueFields = visual.fields.values
    .filter(f => f && !f.startsWith('CountNonNull('))
    .map(f => {
      const cleanVal = clean(f);
      const agg = getColAggregation(cleanVal, 'SUM');
      return {
        column: cleanVal,
        mapping: 'VALUE',
        ...(agg ? { aggregation: agg } : {}),
      };
    });

  const legendFields = visual.fields.legend
    .filter(f => f && !f.startsWith('CountNonNull('))
    .map(f => ({ column: clean(f), mapping: 'SERIES' }));

  const allCols = [...categoryFields, ...valueFields, ...legendFields];

  if (allCols.length === 0) {
    return null;
  }
  // If only category, no value — use COUNT of first fallback physical column
  if (valueFields.length === 0 && categoryFields.length > 0) {
    const countCol = (fallbackColumns || [])[0] || categoryFields[0].column;
    const agg = getColAggregation(countCol, 'COUNT');
    return [
      ...categoryFields,
      {
        column: countCol,
        mapping: 'VALUE',
        ...(agg ? { aggregation: agg } : {}),
      },
    ];
  }

  // If only value, no category — use first fallback physical column as ITEM
  if (categoryFields.length === 0 && valueFields.length > 0) {
    const fallbackItemCol = (fallbackColumns || [])[0] || 'id';
    return [
      { column: fallbackItemCol, mapping: 'ITEM' },
      ...valueFields,
      ...legendFields,
    ];
  }

  return allCols;
}

/**
 * Exports a Power BI report to .pbix format and downloads the raw bytes.
 * Requires Pro/Premium license and Report.ReadWrite.All or Report.Read.All scope.
 */
export async function exportReportToPbix(workspaceId, reportId) {
  const headers = await getAuthHeaders();

  const url = `${env.powerBiApiUrl}/v1.0/myorg/groups/${workspaceId}/reports/${reportId}/Export?preferClientRouting=false`;
  console.log(`[LAYOUT] Exporting .pbix from: ${url}`);

  try {
    const fileRes = await axios.get(url, {
      headers,
      responseType: 'arraybuffer',
      timeout: 120000,
    });
    console.log(`[LAYOUT] Downloaded ${fileRes.data.byteLength} bytes.`);
    return Buffer.from(fileRes.data);
  } catch (err) {
    console.error('[LAYOUT] Export request failed.');
    console.error('[LAYOUT] Status:', err.response?.status);
    const bodyText = err.response?.data ? Buffer.from(err.response.data).toString('utf8').slice(0, 500) : err.message;
    console.error('[LAYOUT] Response body:', bodyText);
    throw new Error(`Export failed: HTTP ${err.response?.status} — ${bodyText}`);
  }
}

/**
 * Unzips a .pbix buffer and extracts the report layout —
 * supports both legacy (Report/Layout) and PBIR (Report/definition/...) formats.
 */
export function extractReportLayout(pbixBuffer) {
  const zip = new AdmZip(pbixBuffer);
  const entries = zip.getEntries();

  console.log(`[LAYOUT] .pbix contains ${entries.length} entries.`);

  const legacyLayout = entries.find(e => e.entryName === 'Report/Layout');
  if (legacyLayout) {
    console.log('[LAYOUT] Found legacy Report/Layout format.');
    const raw = legacyLayout.getData().toString('utf16le').replace(/^\uFEFF/, '');
    return { format: 'legacy', data: JSON.parse(raw) };
  }

  const pbirVisualEntries = entries.filter(e =>
    e.entryName.startsWith('Report/definition/pages/') && e.entryName.endsWith('visual.json')
  );
  const pbirPageEntries = entries.filter(e =>
    e.entryName.startsWith('Report/definition/pages/') && e.entryName.endsWith('page.json')
  );

  if (pbirVisualEntries.length > 0 || pbirPageEntries.length > 0) {
    console.log(`[LAYOUT] Found PBIR format — ${pbirPageEntries.length} page(s), ${pbirVisualEntries.length} visual(s).`);
    const pages = pbirPageEntries.map(e => ({
      path: e.entryName,
      data: JSON.parse(e.getData().toString('utf8')),
    }));
    const visuals = pbirVisualEntries.map(e => ({
      path: e.entryName,
      data: JSON.parse(e.getData().toString('utf8')),
    }));
    return { format: 'pbir', data: { pages, visuals } };
  }

  console.warn('[LAYOUT] No recognizable layout found. Entry names sample:', entries.slice(0, 20).map(e => e.entryName));
  throw new Error('Could not locate report layout in either legacy or PBIR format.');
}