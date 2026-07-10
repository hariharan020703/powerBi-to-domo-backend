import axios from 'axios';

const API_TIMEOUT_MS = 30_000;

async function requestWithRetry(requestFn, maxRetries = 3) {
  let attempt = 0;
  while (true) {
    try {
      return await requestFn();
    } catch (error) {
      attempt++;
      const status = error.response ? error.response.status : null;
      const isRetryable = !status || status === 429 || status >= 500;
      if (attempt > maxRetries || !isRetryable) throw error;
      const backoffDelay = 2000 * Math.pow(2, attempt - 1);
      console.warn(`[CARD SERVICE] Request failed (${error.message}). Retrying in ${backoffDelay}ms (Attempt ${attempt}/${maxRetries})...`);
      await new Promise(resolve => setTimeout(resolve, backoffDelay));
    }
  }
}

function buildCardBody({ cardName, domoDatasetId, columns, beastModeIds, beastModes, chartType, description }) {
  const cols = columns || [];
  let resolvedChartType = chartType || 'badge_vert_stackedbar';
  const isTable = resolvedChartType === 'badge_basic_table';
  const isSingleValue = resolvedChartType === 'badge_single_value' || resolvedChartType === 'badge_single_value';
  const isGauge = resolvedChartType === 'badge_filledgauge' || resolvedChartType === 'badge_filled_gauge';

  if (isGauge) {
    resolvedChartType = 'badge_filledgauge';
  }
  if (isSingleValue) {
    resolvedChartType = 'badge_single_value';
  }

  let subscriptionColumns;
  let groupBy = [];
  let projection = false;
  let dateGrain = null;

  // ── Handle single-value / gauge charts (KPI, Card, Gauge visuals) ──────────
  if (isSingleValue || isGauge) {
    if (cols.length > 0 && cols[0].mapping) {
      // Pre-mapped columns from layout parser — use as-is (except TREND columns in columns array)
      subscriptionColumns = cols
        .filter(c => c.mapping !== 'TREND')
        .map(c => ({
          column: c.column,
          mapping: c.mapping || 'VALUE',
          ...(c.aggregation && c.aggregation !== 'NONE' ? { aggregation: c.aggregation } : {}),
          ...(c.calendar ? { calendar: true } : {}),
        }));
    } else if (cols.length > 0) {
      // Auto-detect: use first numeric column or fallback to COUNT
      if (isGauge) {
        subscriptionColumns = [
          {
            column: cols[0].name,
            mapping: 'CURRENT',
            aggregation: 'COUNT',
          },
          {
            column: (cols[1] || cols[0]).name,
            mapping: 'TARGET',
            aggregation: 'COUNT',
          }
        ];
      } else {
        const isNumericType = (t) =>
          ['LONG', 'DOUBLE', 'DECIMAL', 'INTEGER', 'NUMERIC'].includes((t || '').toUpperCase());
        const numCol = cols.find(c => isNumericType(c.type));
        subscriptionColumns = [{
          column: (numCol || cols[0]).name,
          mapping: 'VALUE',
          aggregation: numCol ? 'SUM' : 'COUNT',
        }];
      }
    } else {
      // No physical columns — Beast Mode columns will be added below
      subscriptionColumns = [];
    }
    // Single-value cards: no groupBy, no dateGrain, no projection
    groupBy = [];
    projection = false;

    // Set dateGrain if trend/date column is present
    const dateCol = cols.find(c => c.calendar || c.mapping === 'TREND' || c.type === 'DATE' || c.type === 'DATETIME');
    if (dateCol) {
      dateGrain = { column: dateCol.column || dateCol.name };
    }

    // ── Handle case where no physical columns but Beast Mode IDs exist ─────────
  } else if (cols.length === 0 && beastModeIds && beastModeIds.length > 0) {
    // Beast Mode-only visual — physical subscription is empty, Beast Mode columns added below
    subscriptionColumns = [];
    groupBy = [];
    projection = false;

  } else if (cols.length > 0 && cols[0].mapping) {
    if (!isTable) {
      const itemCols = cols.filter(c => c.mapping === 'ITEM' || c.mapping === 'SERIES');
      const seenValueCols = new Set();
      const valueCols = cols.filter(c => {
        if (c.mapping !== 'VALUE') return false;
        if (seenValueCols.has(c.column)) return false;
        seenValueCols.add(c.column);
        return true;
      });

      // groupBy must contain all ITEM and SERIES columns
      groupBy = itemCols.map(c => ({
        column: c.column,
        ...(c.calendar ? { calendar: true } : {}),
      }));

      // dateGrain for date-based ITEM columns
      const dateItemCol = itemCols.find(c => c.calendar);
      if (dateItemCol) {
        dateGrain = { column: dateItemCol.column, dateTimeElement: 'MONTH' };
      }

      // Build subscription columns — ITEM/SERIES columns have no aggregation
      subscriptionColumns = [
        ...itemCols.map(c => ({
          column: c.column,
          mapping: c.mapping,
          ...(c.calendar ? { calendar: true } : {}),
        })),
        ...valueCols.map(c => ({
          column: c.column,
          mapping: 'VALUE',
          aggregation: c.aggregation || 'SUM',
        })),
      ];
    } else {
      // Table — all columns as VALUE, no aggregation
      subscriptionColumns = cols.map(c => ({
        column: c.column,
        mapping: 'VALUE',
      }));
    }
    projection = isTable;
  } else {
    // Auto-detect from column types (fallback for existing dataset-migration flow)
    const isNumericType = (t) =>
      ['LONG', 'DOUBLE', 'DECIMAL', 'INTEGER', 'NUMERIC'].includes((t || '').toUpperCase());
    const isDateType = (t) =>
      ['DATE', 'DATETIME'].includes((t || '').toUpperCase());

    const categoryCol =
      cols.find(c => !isNumericType(c.type) && !isDateType(c.type)) ||
      cols.find(c => isDateType(c.type)) ||
      cols[0] ||
      { name: 'id', type: 'STRING' };

    const measureCol = cols.find(c => isNumericType(c.type) && c.name !== categoryCol.name);

    const categoryColumnDef = {
      column: categoryCol.name,
      mapping: isTable ? 'VALUE' : 'ITEM',
      ...(isDateType(categoryCol.type) ? { calendar: true } : {}),
    };

    const measureColumnDef = measureCol
      ? { column: measureCol.name, mapping: 'VALUE', aggregation: 'SUM' }
      : { column: categoryCol.name, mapping: 'VALUE', aggregation: 'COUNT' };

    subscriptionColumns = isTable
      ? cols.map(c => ({ column: c.name, mapping: 'VALUE' }))
      : [categoryColumnDef, measureColumnDef];

    if (!isTable) {
      groupBy = [{ column: categoryCol.name }];
      if (isDateType(categoryCol.type)) {
        dateGrain = { column: categoryCol.name, dateTimeElement: 'DAY' };
      }
    }
    projection = isTable;
  }

  const beastModeColumns = (beastModeIds || [])
    .filter(Boolean)
    .map(id => {
      const colName = id.startsWith('calculation_') ? id : `calculation_${id}`;
      const alreadySubscribed = (subscriptionColumns || []).some(c => c.column === colName);
      if (alreadySubscribed) return null;
      return {
        column: colName,
        mapping: 'VALUE',
      };
    })
    .filter(Boolean);

  const subscriptionBody = {
    name: 'main',
    columns: [...subscriptionColumns, ...beastModeColumns],
    filters: [],
    orderBy: [],
    groupBy,
    fiscal: false,
    projection,
    distinct: false,
  };

  if (dateGrain) subscriptionBody.dateGrain = dateGrain;

  const subscriptions = { main: subscriptionBody };

  // Add big_number subscription for KPI/trendline/bar/line/pie/funnel/waterfall charts
  const showSummaryNumber = !isTable && !isGauge;
  if (showSummaryNumber) {
    const valCol = [...subscriptionColumns, ...beastModeColumns].find(
      c => c.mapping === 'VALUE'
    );
    if (valCol) {
      const isBeast = valCol.column.startsWith('calculation_');
      const cleanAlias = isBeast ? 'Value' : valCol.column;
      const agg = valCol.aggregation || 'SUM';
      subscriptions.big_number = {
        name: 'big_number',
        columns: [
          {
            column: valCol.column,
            aggregation: agg,
            alias: `${agg.charAt(0) + agg.slice(1).toLowerCase()} of ${cleanAlias}`,
            format: {
              format: '#A',
              type: 'abbreviated',
            },
          },
        ],
        filters: [],
      };
    }
  }

  const hasNoDateRange = !(isGauge || isSingleValue);

  return {
    definition: {
      subscriptions,
      formulas: {
        dsUpdated: (beastModes || [])
          .filter(bm => bm && bm.domoFunctionId)
          .map(bm => {
            const id = bm.domoFunctionId;
            const colName = id.startsWith('calculation_') ? id : `calculation_${id}`;
            return {
              id: colName,
              name: bm.name,
              formula: bm.beastModeFormula || '',
              dataType: bm.dataType || 'DECIMAL',
              status: 'VALID',
              aggregated: bm.aggregated !== undefined ? bm.aggregated : true,
            };
          }),
        dsDeleted: [],
        card: []
      },
      annotations: { new: [], modified: [], deleted: [] },
      conditionalFormats: { card: [], datasource: [] },
      controls: [],
      segments: { active: [], create: [], update: [], delete: [] },
      charts: {
        main: {
          component: 'main',
          chartType: resolvedChartType,
          overrides: {},
          goal: null,
        },
      },
      dynamicTitle: { text: [{ text: cardName, type: 'TEXT' }] },
      dynamicDescription: { text: [], displayOnCardDetails: true },
      chartVersion: '12',
      includeEmptyFilters: true,
      ...(hasNoDateRange ? { noDateRange: true } : {}),
      inputTable: false,
      title: cardName,
      description: description || 'Migrated from Power BI',
    },
    dataProvider: { dataSourceId: domoDatasetId },
    variables: true,
    columns: false,
  };
}

export async function createDomoCard(domain, token, options) {
  const { cardName, domoDatasetId, columns, beastModeIds, beastModes, ownerId, description } = options;
  const cardBody = buildCardBody({ cardName, domoDatasetId, columns, beastModeIds, beastModes, chartType: options.chartType, description });
  console.log(`[CARD BODY DEBUG] "${cardName}" full request body:`, JSON.stringify(cardBody));

  const headers = {
    'Content-Type': 'application/json',
    'X-DOMO-Developer-Token': token || (process.env.DOMO_CLIENT_TOKEN || '').trim()
  };

  let url = `https://${domain}/api/content/v3/cards/kpi`;
  if (options.pageId) {
    url += `?pageId=${options.pageId}`;
  }
  console.log(`[CARD SERVICE] Creating card "${cardName}" via v3 instance API`);

  try {
    const response = await requestWithRetry(() =>
      axios.put(url, cardBody, { headers, timeout: API_TIMEOUT_MS })
    );

    const data = response.data;
    console.log(`[CARD SERVICE] Raw response: ${JSON.stringify(data)?.slice(0, 300)}`);
    const cardId = data?.id || data?.urn;

    if (!cardId) {
      const msg = `No card ID in response: ${JSON.stringify(data)?.slice(0, 300)}`;
      console.error(`[CARD SERVICE] ${msg}`);
      return { cardId: null, cardUrl: null, error: msg };
    }

    const cardUrl = `https://${domain}/cards/${cardId}`;
    console.log(`[CARD SERVICE] Success: Created card at ${cardUrl}`);
    return { cardId, cardUrl, error: null };

  } catch (err) {
    const status = err.response?.status;
    const detail = JSON.stringify(err.response?.data ?? err.message);
    console.error(`[CARD SERVICE] Card creation failed (HTTP ${status ?? 'N/A'}): ${detail}`);

    return { cardId: null, cardUrl: null, error: `Card creation failed: HTTP ${status ?? 'N/A'} — ${detail}` };
  }
}

export async function createDomoPage(domain, token, { pageName, ownerId }) {
  const headers = {
    'Content-Type': 'application/json',
    'X-DOMO-DEVELOPER-TOKEN': token,
  };
  const payload = {
    title: pageName,
    type: 'page',
    visibility: { userIds: [], groupIds: [] },
    ...(ownerId != null ? { ownerId } : {}),
  };

  console.log(`[CARD SERVICE] Creating page "${pageName}"...`);
  return requestWithRetry(async () => {
    try {
      const response = await axios.post(
        `https://${domain}/api/content/v1/pages`,
        payload,
        { headers, timeout: API_TIMEOUT_MS }
      );
      const pageId = response.data?.id || response.data?.pageId;
      const pageUrl = `https://${domain}/page/${pageId}`;
      console.log(`[CARD SERVICE] Success: Created dashboard page at ${pageUrl}`);
      return { pageId, pageUrl };
    } catch (err) {
      const status = err.response?.status;
      if (status === 401 || status === 403) {
        console.error(`[CARD SERVICE] Auth error (HTTP ${status}): insufficient permissions for page creation.`);
      }
      throw err;
    }
  }).catch(err => {
    console.error(`[CARD SERVICE] Failed to create page: ${err.message}`);
    return { pageId: null, pageUrl: null, error: err.message };
  });
}

export async function addCardsToPage(domain, token, pageId, cardIds) {
  const validCardIds = (cardIds || []).filter(id => id && !String(id).startsWith('failed-'));
  if (validCardIds.length === 0) {
    console.warn(`[CARD SERVICE] addCardsToPage: no valid card IDs to add to page ${pageId}. Skipping.`);
    return false;
  }

  const headers = {
    'Content-Type': 'application/json',
    'X-DOMO-Developer-Token': token || (process.env.DOMO_CLIENT_TOKEN || '').trim()
  };

  console.log(`[CARD SERVICE] Adding ${validCardIds.length} card(s) to page ${pageId}...`);

  let allSucceeded = true;
  for (const cardId of validCardIds) {
    try {
      const url = `https://${domain}/api/content/v1/cards/${cardId}/pages`;
      const response = await requestWithRetry(() =>
        axios.put(url, [Number(pageId)], { headers, timeout: API_TIMEOUT_MS })
      );
      console.log(`[CARD SERVICE] Card ${cardId} → page ${pageId}: HTTP ${response.status}`);
    } catch (err) {
      const status = err.response?.status;
      const detail = JSON.stringify(err.response?.data ?? err.message);
      console.error(`[CARD SERVICE] Failed to add card ${cardId} to page ${pageId}. status: ${status}. details: ${detail}`);
      allSucceeded = false;
    }
  }

  if (allSucceeded) {
    console.log(`[CARD SERVICE] Success: Added all cards to page ${pageId}`);
  }
  return allSucceeded;
}
