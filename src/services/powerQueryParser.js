/**
 * Extracts the body of a `let ... in <final>` M expression.
 * Returns an array of { stepName, expression } in declaration order.
 */
function extractLetSteps(mExpression) {
  const trimmed = mExpression.trim();

  // Match `let ... in <finalStep>`
  const letMatch = trimmed.match(/^let\s+([\s\S]+?)\s+in\s+(?:#"[^"]*"|\S+)\s*$/i);
  if (!letMatch) {
    // Not a standard let/in expression — treat entire thing as one step
    return [];
  }

  const body = letMatch[1];

  // Split on top-level commas that separate step assignments.
  // M steps look like:  StepName = <expression>,
  // We need to handle nested braces {} and parentheses ().
  const steps = [];
  let current = '';
  let depth = 0;       // tracks () depth
  let braceDepth = 0;  // tracks {} depth
  let bracketDepth = 0; // tracks [] depth (but [] is also used for column refs)
  let inString = false;
  let stringChar = '';

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];

    if (inString) {
      current += ch;
      if (ch === stringChar) {
        // Check for escaped quote (doubled)
        if (i + 1 < body.length && body[i + 1] === stringChar) {
          current += body[i + 1];
          i++;
        } else {
          inString = false;
        }
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      stringChar = '"';
      current += ch;
      continue;
    }

    if (ch === '(') { depth++; current += ch; continue; }
    if (ch === ')') { depth--; current += ch; continue; }
    if (ch === '{') { braceDepth++; current += ch; continue; }
    if (ch === '}') { braceDepth--; current += ch; continue; }

    // Comma at top level = step separator
    if (ch === ',' && depth === 0 && braceDepth === 0) {
      const step = current.trim();
      if (step) steps.push(step);
      current = '';
      continue;
    }

    current += ch;
  }

  // Last step (no trailing comma)
  const last = current.trim();
  if (last) steps.push(last);

  // Parse each step into { stepName, expression }
  return steps.map(step => {
    const eqIdx = step.indexOf('=');
    if (eqIdx === -1) return null;

    // Handle cases like `#"Step Name" = ...`
    const rawName = step.substring(0, eqIdx).trim();
    const stepName = rawName.replace(/^#"/, '').replace(/"$/, '');
    const expression = step.substring(eqIdx + 1).trim();

    return { stepName, expression };
  }).filter(Boolean);
}

/**
 * Extracts items from an M list literal: {"a", "b", "c"} → ["a", "b", "c"]
 */
function extractListItems(listStr) {
  const inner = listStr.replace(/^\{/, '').replace(/\}$/, '').trim();
  if (!inner) return [];

  const items = [];
  let current = '';
  let depth = 0;
  let braceDepth = 0;
  let inString = false;

  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];

    if (inString) {
      current += ch;
      if (ch === '"') {
        if (i + 1 < inner.length && inner[i + 1] === '"') {
          current += inner[i + 1];
          i++;
        } else {
          inString = false;
        }
      }
      continue;
    }

    if (ch === '"') { inString = true; current += ch; continue; }
    if (ch === '(') { depth++; current += ch; continue; }
    if (ch === ')') { depth--; current += ch; continue; }
    if (ch === '{') { braceDepth++; current += ch; continue; }
    if (ch === '}') { braceDepth--; current += ch; continue; }

    if (ch === ',' && depth === 0 && braceDepth === 0) {
      items.push(current.trim());
      current = '';
      continue;
    }

    current += ch;
  }
  if (current.trim()) items.push(current.trim());

  return items
    .map(item => item.replace(/^"/, '').replace(/"$/, '').trim())
    .filter(item => item.length > 0 && item.toLowerCase() !== 'null');
}

/**
 * Extracts rename pairs from M: {{"old1", "new1"}, {"old2", "new2"}}
 */
function extractRenamePairs(expr) {
  const pairs = [];
  const pairRegex = /\{\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\}/g;
  let match;
  while ((match = pairRegex.exec(expr)) !== null) {
    pairs.push({ from: match[1], to: match[2] });
  }
  return pairs;
}

/**
 * Extracts type change columns from: {{"ColName", type number}, {"Col2", type text}}
 */
function extractTypeChanges(expr) {
  const columns = [];
  // Primary regex — handles standard and multi-line formats
  const typeRegex = /\{\s*"([^"]+)"\s*,\s*(type\s+\w+|Int64\.Type|Currency\.Type|Percentage\.Type|[\w.]+Type)\s*\}/gi;
  let match;
  while ((match = typeRegex.exec(expr)) !== null) {
    const name = match[1];
    const rawType = match[2].trim().toLowerCase();
    columns.push({ name, toType: mapMTypeToDomoType(rawType) });
  }
  return columns;
}

/**
 * Maps Power Query type names to Domo type names.
 */
function mapMTypeToDomoType(rawType) {
  const t = rawType.replace(/^type\s+/, '').trim().toLowerCase();
  const map = {
    'text': 'STRING',
    'number': 'DOUBLE',
    'decimal': 'DOUBLE',
    'whole number': 'LONG',
    'int64.type': 'LONG',
    'int64': 'LONG',
    'integer': 'LONG',
    'date': 'DATE',
    'datetime': 'DATETIME',
    'datetimezone': 'DATETIME',
    'time': 'STRING',
    'duration': 'STRING',
    'logical': 'STRING',
    'binary': 'STRING',
    'currency.type': 'DOUBLE',
    'percentage.type': 'DOUBLE',
  };
  return map[t] || 'STRING';
}

/**
 * Extracts column names from an M list: {"Col1", "Col2", "Col3"}
 */
function extractColumnNames(expr) {
  const match = expr.match(/\{([^}]*)\}/);
  if (!match) return [];
  return extractListItems(`{${match[1]}}`);
}

/**
 * Extracts a filter condition from a `Table.SelectRows` `each [...]` expression.
 * Returns a plain English description.
 */
function extractFilterCondition(expr) {
  // Try to extract the `each ...` part
  const eachMatch = expr.match(/each\s+([\s\S]+?)\s*\)\s*$/);
  if (!eachMatch) return expr;

  let condition = eachMatch[1].trim();
  // Remove trailing parenthesis if any
  condition = condition.replace(/\)\s*$/, '').trim();

  // Convert M syntax to readable format
  condition = condition
    .replace(/\[([^\]]+)\]/g, '$1')     // [Column] → Column
    .replace(/<>/g, '!=')                // <> → !=
    .replace(/\band\b/gi, 'AND')
    .replace(/\bor\b/gi, 'OR')
    .replace(/\bnot\b/gi, 'NOT')
    .replace(/\bnull\b/gi, 'NULL');

  return condition;
}

/**
 * Extracts sort columns from Table.Sort expression.
 * M format: Table.Sort(prev, {{"Col1", Order.Ascending}, {"Col2", Order.Descending}})
 * or: Table.Sort(prev, {"Col1", Order.Ascending})
 */
function extractSortColumns(expr) {
  const sortColumns = [];
  const pairRegex = /\{\s*"([^"]+)"\s*,\s*Order\.(Ascending|Descending)\s*\}/gi;
  let match;
  while ((match = pairRegex.exec(expr)) !== null) {
    sortColumns.push({
      column: match[1],
      order: match[2].toLowerCase() === 'ascending' ? 'ASC' : 'DESC'
    });
  }
  return sortColumns;
}

/**
 * Extracts GROUP_BY details from Table.Group expression.
 */
function extractGroupByDetails(expr) {
  // Table.Group(prev, {"GroupCol1", "GroupCol2"}, {{"AggName", each List.Sum([Col]), type number}})
  const groupByColumns = [];
  const aggregations = [];

  // Extract group-by column names — first list after the previous step reference
  const groupMatch = expr.match(/Table\.Group\s*\([^,]+,\s*(\{[^}]*\})/i);
  if (groupMatch) {
    const cols = extractListItems(groupMatch[1]);
    groupByColumns.push(...cols);
  }

  // Extract aggregations — look for patterns like {"AggName", each List.Sum([Col]), ...}
  const aggBlockMatch = expr.match(/,\s*(\{\s*\{[\s\S]+\}\s*\})\s*\)/);
  if (aggBlockMatch) {
    const aggBlock = aggBlockMatch[1];
    // Match individual aggregation entries
    const aggRegex = /\{\s*"([^"]+)"\s*,\s*each\s+([\s\S]+?)(?:,\s*type\s+\w+)?\s*\}/gi;
    let aggMatch;
    while ((aggMatch = aggRegex.exec(aggBlock)) !== null) {
      const aggName = aggMatch[1];
      const aggExpr = aggMatch[2].trim();

      let func = 'COUNT';
      let col = aggName;

      if (/List\.Sum/i.test(aggExpr)) func = 'SUM';
      else if (/List\.Average/i.test(aggExpr)) func = 'AVG';
      else if (/List\.Count/i.test(aggExpr) || /Table\.RowCount/i.test(aggExpr)) func = 'COUNT';
      else if (/List\.Min/i.test(aggExpr)) func = 'MIN';
      else if (/List\.Max/i.test(aggExpr)) func = 'MAX';
      else if (/List\.DistinctCount/i.test(aggExpr)) func = 'COUNT_DISTINCT';

      const colMatch = aggExpr.match(/\[([^\]]+)\]/);
      if (colMatch) col = colMatch[1];

      aggregations.push({ outputColName: aggName, aggregationFunction: func, sourceCol: col });
    }
  }

  return { groupByColumns, aggregations };
}

/**
 * Determines if a Table.AddColumn expression is a fixed literal (ADD_CONSTANT),
 * a text operation (TEXT_FORMULA), a date operation (DATE_OPERATIONS),
 * a number format (NUMBER_FORMAT), or a general formula (ADD_FORMULA).
 */
function classifyAddColumn(expr) {
  // Extract column name and the `each ...` expression
  const addColMatch = expr.match(/Table\.AddColumn\s*\([^,]+,\s*"([^"]+)"\s*,\s*each\s+([\s\S]+?)(?:,\s*type\s+\w+)?\s*\)\s*$/i);
  if (!addColMatch) {
    // Try without `each` (constant value)
    const constMatch = expr.match(/Table\.AddColumn\s*\([^,]+,\s*"([^"]+)"\s*,\s*each\s+"([^"]+)"\s*\)/i)
      || expr.match(/Table\.AddColumn\s*\([^,]+,\s*"([^"]+)"\s*,\s*each\s+(\d+(?:\.\d+)?)\s*\)/i)
      || expr.match(/Table\.AddColumn\s*\([^,]+,\s*"([^"]+)"\s*,\s*each\s+(true|false|null)\s*\)/i);

    if (constMatch) {
      return {
        actionType: 'ADD_CONSTANT',
        columnName: constMatch[1],
        value: constMatch[2],
        dataType: /^\d+(\.\d+)?$/.test(constMatch[2]) ? 'DOUBLE' : 'STRING'
      };
    }
    return null;
  }

  const columnName = addColMatch[1];
  const calcExpr = addColMatch[2].trim();

  // Check if it's a simple constant
  if (/^"[^"]*"$/.test(calcExpr) || /^\d+(\.\d+)?$/.test(calcExpr) || /^(true|false|null)$/i.test(calcExpr)) {
    return {
      actionType: 'ADD_CONSTANT',
      columnName,
      value: calcExpr.replace(/^"/, '').replace(/"$/, ''),
      dataType: /^\d/.test(calcExpr) ? 'DOUBLE' : 'STRING'
    };
  }

  // Check for date operations
  if (/Date\.(Year|Month|Day|DayOfWeek|DayOfYear|AddDays|AddMonths|AddYears|From)/i.test(calcExpr)
    || /Duration\./i.test(calcExpr)) {
    let operation = 'YEAR';
    if (/Date\.Month/i.test(calcExpr)) operation = 'MONTH';
    else if (/Date\.Day(?:OfWeek|OfYear)?/i.test(calcExpr)) operation = 'DAY';
    else if (/Duration\./i.test(calcExpr) || /Date\.Add/i.test(calcExpr)) operation = 'ADD';

    const sourceColMatch = calcExpr.match(/\[([^\]]+)\]/);
    return {
      actionType: 'DATE_OPERATIONS',
      columnName,
      operation,
      sourceColumn: sourceColMatch ? sourceColMatch[1] : '',
      unit: 'DAYS'
    };
  }

  // Check for number formatting
  if (/Number\.(Round|RoundDown|RoundUp|Abs)/i.test(calcExpr)) {
    let operation = 'ROUND';
    if (/RoundDown/i.test(calcExpr)) operation = 'FLOOR';
    else if (/RoundUp/i.test(calcExpr)) operation = 'CEILING';
    else if (/Number\.Abs/i.test(calcExpr)) operation = 'ABS';

    const sourceColMatch = calcExpr.match(/\[([^\]]+)\]/);
    const precisionMatch = calcExpr.match(/,\s*(\d+)\s*\)/);
    return {
      actionType: 'NUMBER_FORMAT',
      columnName,
      operation,
      sourceColumn: sourceColMatch ? sourceColMatch[1] : '',
      precision: precisionMatch ? parseInt(precisionMatch[1]) : 0
    };
  }

  // Check for text operations
  if (/Text\.(Upper|Lower|Trim|TrimStart|TrimEnd|PadStart|PadEnd|Replace|Contains|StartsWith|EndsWith|Length|Reverse|Combine)/i.test(calcExpr)) {
    let operation = 'UPPER';
    if (/Text\.Lower/i.test(calcExpr)) operation = 'LOWER';
    else if (/Text\.Trim/i.test(calcExpr)) operation = 'TRIM';
    else if (/Text\.Replace/i.test(calcExpr)) operation = 'REPLACE';
    else if (/Text\.Contains/i.test(calcExpr)) operation = 'CONTAINS';
    else if (/Text\.Length/i.test(calcExpr)) operation = 'LENGTH';
    else if (/Text\.Combine/i.test(calcExpr)) operation = 'COMBINE';

    const sourceColMatch = calcExpr.match(/\[([^\]]+)\]/);
    return {
      actionType: 'TEXT_FORMULA',
      columnName,
      operation,
      sourceColumn: sourceColMatch ? sourceColMatch[1] : ''
    };
  }

  // Check for column combine using & operator
  if (/\[.+\]\s*&\s*/.test(calcExpr) || /&\s*\[.+\]/.test(calcExpr)) {
    const colRefs = [];
    const colRefRegex = /\[([^\]]+)\]/g;
    let colMatch;
    while ((colMatch = colRefRegex.exec(calcExpr)) !== null) {
      colRefs.push(colMatch[1]);
    }
    // Try to find separator
    const sepMatch = calcExpr.match(/&\s*"([^"]*)"\s*&/);
    return {
      actionType: 'COLUMN_COMBINE',
      sourceColumns: colRefs,
      outputColumn: columnName,
      separator: sepMatch ? sepMatch[1] : ''
    };
  }

  // Default: general formula
  // Convert M column refs [ColName] to backtick notation
  const formula = calcExpr
    .replace(/\[([^\]]+)\]/g, '`$1`')
    .replace(/\beach\b\s*/gi, '')
    .trim();

  return {
    actionType: 'ADD_FORMULA',
    columnName,
    formula
  };
}

/**
 * Extracts JOIN details from Table.Join or Table.NestedJoin.
 */
function extractJoinDetails(expr) {
  let joinType = 'LEFT';

  if (/JoinKind\.Inner/i.test(expr)) joinType = 'INNER';
  else if (/JoinKind\.RightOuter/i.test(expr)) joinType = 'RIGHT';
  else if (/JoinKind\.FullOuter/i.test(expr)) joinType = 'FULL';
  else if (/JoinKind\.LeftOuter/i.test(expr)) joinType = 'LEFT';

  // Extract key columns — they appear as {"KeyCol"} or {{"Key1", "Key2"}}
  const keyMatches = [...expr.matchAll(/\{\s*"([^"]+)"\s*\}/g)];
  const leftKey = keyMatches.length > 0 ? [keyMatches[0][1]] : [];
  const rightKey = keyMatches.length > 1 ? [keyMatches[1][1]] : leftKey;

  // Try to identify the right dataset — it's the second table argument
  const rightDatasetMatch = expr.match(/Table\.(?:Nested)?Join\s*\([^,]+,\s*[^,]+,\s*(\w+|#"[^"]+"|[^,]+)\s*,/i);
  const rightDataset = rightDatasetMatch
    ? rightDatasetMatch[1].replace(/^#"/, '').replace(/"$/, '').trim()
    : 'unknown';

  return { joinType, leftKey, rightKey, rightDataset };
}


// ─── Main Parser ────────────────────────────────────────────────────────────

/**
 * Parses a Power Query M expression and returns an array of ETL steps.
 *
 * Each step:
 * {
 *   stepName: string,
 *   actionType: string,     // one of the 24 allowed Domo tile types
 *   description: string,    // actionable English description
 *   properties: object      // tile-specific fields
 * }
 */
export function parsePowerQuerySteps(mExpression) {
  if (!mExpression || typeof mExpression !== 'string') {
    console.warn('[POWER QUERY PARSER] mExpression is null or not a string — skipping');
    return [];
  }

  const rawSteps = extractLetSteps(mExpression);
  console.log(`[POWER QUERY PARSER] extractLetSteps returned ${rawSteps.length} raw steps`);

  if (rawSteps.length === 0) {
    console.warn('[POWER QUERY PARSER] No steps extracted — expression may not match let...in pattern or is a single-line expression');
    console.warn('[POWER QUERY PARSER] First 300 chars:', mExpression.substring(0, 300));
    return [];
  }

  const steps = [];

  for (let i = 0; i < rawSteps.length; i++) {
    const { stepName, expression } = rawSteps[i];
    const expr = expression.trim();

    // ── Skip source steps ──
    if (i === 0 && /^(Sql\.|OData\.|Web\.|Excel\.|Csv\.|File\.|Folder\.|SharePoint\.|AzureStorage\.|AnalysisServices\.|Odbc\.|Oracle\.|Salesforce\.|GoogleAnalytics\.|Facebook\.|Json\.|Xml\.|Table\.FromRows|#table|Source)/i.test(expr)) {
      continue;
    }

    // Also skip if the step name is literally "Source"
    if (stepName === 'Source' || stepName === 'source') {
      continue;
    }

    // ── Navigation steps (skip) ──
    if (/^Source\s*\[/i.test(expr) || /Navigation/i.test(stepName) || /^Source\{/i.test(expr)) {
      continue;
    }

    // Promoted headers (skip — Domo handles headers automatically)
    if (/Table\.PromoteHeaders/i.test(expr)) {
      continue;
    }

    let step = null;

    // ── FILTER: Table.SelectRows / Table.Filter ──
    if (/Table\.SelectRows/i.test(expr) || /Table\.Filter/i.test(expr)) {
      const condition = extractFilterCondition(expr);
      step = {
        stepName,
        actionType: 'FILTER',
        description: `Filter rows where: ${condition}`,
        properties: { condition }
      };
    }

    // ── SELECT_COLUMNS: Table.SelectColumns ──
    else if (/Table\.SelectColumns/i.test(expr)) {
      const columns = extractColumnNames(expr);
      step = {
        stepName,
        actionType: 'SELECT_COLUMNS',
        description: `Keep only columns: ${columns.join(', ')}`,
        properties: { columns }
      };
    }

    // ── REMOVE_COLUMNS: Table.RemoveColumns ──
    else if (/Table\.RemoveColumns/i.test(expr)) {
      const columns = extractColumnNames(expr);
      step = {
        stepName,
        actionType: 'REMOVE_COLUMNS',
        description: `Remove columns: ${columns.join(', ')}`,
        properties: { columns }
      };
    }

    // ── RENAME_COLUMNS: Table.RenameColumns ──
    else if (/Table\.RenameColumns/i.test(expr)) {
      const renames = extractRenamePairs(expr);
      const desc = renames.map(r => `'${r.from}' → '${r.to}'`).join(', ');
      step = {
        stepName,
        actionType: 'RENAME_COLUMNS',
        description: `Rename columns: ${desc}`,
        properties: { renames }
      };
    }

    // ── SET_COLUMN_TYPE: Table.TransformColumnTypes ──
    else if (/Table\.TransformColumnTypes/i.test(expr)) {
      const columns = extractTypeChanges(expr);
      const desc = columns.map(c => `'${c.name}' → ${c.toType}`).join(', ');
      step = {
        stepName,
        actionType: 'SET_COLUMN_TYPE',
        description: `Set column types: ${desc}`,
        properties: { columns }
      };
    }

    // ── SORT: Table.Sort ──
    else if (/Table\.Sort/i.test(expr)) {
      const sortColumns = extractSortColumns(expr);
      const desc = sortColumns.map(s => `${s.column} ${s.order}`).join(', ');
      step = {
        stepName,
        actionType: 'SORT',
        description: `Sort by: ${desc || 'specified columns'}`,
        properties: { sortColumns }
      };
    }

    // ── GROUP_BY: Table.Group ──
    else if (/Table\.Group/i.test(expr)) {
      const { groupByColumns, aggregations } = extractGroupByDetails(expr);
      const desc = `Group by [${groupByColumns.join(', ')}] with ${aggregations.map(a => `${a.aggregationFunction}(${a.sourceCol})`).join(', ')}`;
      step = {
        stepName,
        actionType: 'GROUP_BY',
        description: desc,
        properties: { groupByColumns, aggregations }
      };
    }

    // ── REMOVE_DUPLICATES: Table.Distinct / Table.RemoveDuplicates ──
    else if (/Table\.Distinct/i.test(expr)) {
      step = {
        stepName,
        actionType: 'REMOVE_DUPLICATES',
        description: 'Remove duplicate rows (all columns as key)',
        properties: { keyColumns: [] }
      };
    }
    else if (/Table\.RemoveDuplicates/i.test(expr)) {
      const keyColumns = extractColumnNames(expr);
      step = {
        stepName,
        actionType: 'REMOVE_DUPLICATES',
        description: `Remove duplicates by key columns: ${keyColumns.length > 0 ? keyColumns.join(', ') : 'all columns'}`,
        properties: { keyColumns }
      };
    }

    // ── TOP_N_ROWS: Table.FirstN / Table.LastN / Table.Skip ──
    else if (/Table\.FirstN/i.test(expr)) {
      const nMatch = expr.match(/Table\.FirstN\s*\([^,]+,\s*(\d+)/i);
      step = {
        stepName,
        actionType: 'TOP_N_ROWS',
        description: `Keep first ${nMatch ? nMatch[1] : 'N'} rows`,
        properties: {
          n: nMatch ? parseInt(nMatch[1]) : 0,
          order: 'FIRST',
          orderByColumn: null
        }
      };
    }
    else if (/Table\.LastN/i.test(expr)) {
      const nMatch = expr.match(/Table\.LastN\s*\([^,]+,\s*(\d+)/i);
      step = {
        stepName,
        actionType: 'TOP_N_ROWS',
        description: `Keep last ${nMatch ? nMatch[1] : 'N'} rows`,
        properties: {
          n: nMatch ? parseInt(nMatch[1]) : 0,
          order: 'LAST',
          orderByColumn: null
        }
      };
    }
    else if (/Table\.Skip/i.test(expr)) {
      const nMatch = expr.match(/Table\.Skip\s*\([^,]+,\s*(\d+)/i);
      step = {
        stepName,
        actionType: 'TOP_N_ROWS',
        description: `Skip first ${nMatch ? nMatch[1] : 'N'} rows`,
        properties: {
          n: nMatch ? parseInt(nMatch[1]) : 0,
          order: 'FIRST',
          orderByColumn: null
        }
      };
    }

    // ── JOIN_DATA: Table.Join / Table.NestedJoin ──
    else if (/Table\.(Nested)?Join/i.test(expr)) {
      const joinDetails = extractJoinDetails(expr);
      step = {
        stepName,
        actionType: 'JOIN_DATA',
        description: `${joinDetails.joinType} join with '${joinDetails.rightDataset}' on [${joinDetails.leftKey.join(', ')}] = [${joinDetails.rightKey.join(', ')}]`,
        properties: joinDetails
      };
    }

    // ── APPEND_ROWS: Table.Combine ──
    else if (/Table\.Combine/i.test(expr)) {
      // Extract dataset references from the list
      const listMatch = expr.match(/Table\.Combine\s*\(\s*\{([^}]+)\}/i);
      const datasetsToAppend = listMatch
        ? listMatch[1].split(',').map(s => s.replace(/^#"/, '').replace(/"$/, '').trim())
        : [];
      step = {
        stepName,
        actionType: 'APPEND_ROWS',
        description: `Append rows from: ${datasetsToAppend.join(', ')}`,
        properties: { datasetsToAppend }
      };
    }

    // ── PIVOT: Table.Pivot ──
    else if (/Table\.Pivot/i.test(expr)) {
      const pivotColMatch = expr.match(/Table\.Pivot\s*\([^,]+,\s*[^,]+,\s*"([^"]+)"\s*,\s*"([^"]+)"/i);
      let aggregation = 'SUM';
      if (/List\.Sum/i.test(expr)) aggregation = 'SUM';
      else if (/List\.Average/i.test(expr)) aggregation = 'AVG';
      else if (/List\.Count/i.test(expr)) aggregation = 'COUNT';
      else if (/List\.Min/i.test(expr)) aggregation = 'MIN';
      else if (/List\.Max/i.test(expr)) aggregation = 'MAX';

      step = {
        stepName,
        actionType: 'PIVOT',
        description: `Pivot on '${pivotColMatch?.[1] || 'column'}' with values from '${pivotColMatch?.[2] || 'column'}' (${aggregation})`,
        properties: {
          pivotColumn: pivotColMatch?.[1] || '',
          valueColumn: pivotColMatch?.[2] || '',
          aggregation
        }
      };
    }

    // ── UNPIVOT: Table.Unpivot / Table.UnpivotOtherColumns ──
    else if (/Table\.UnpivotOtherColumns/i.test(expr)) {
      const colsMatch = expr.match(/Table\.UnpivotOtherColumns\s*\([^,]+,\s*(\{[^}]*\})\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"/i);
      const attributeColumns = colsMatch ? extractListItems(colsMatch[1]) : [];
      step = {
        stepName,
        actionType: 'UNPIVOT',
        description: `Unpivot all columns except [${attributeColumns.join(', ')}] into attribute/value pairs`,
        properties: {
          attributeColumns,
          attributeColumnName: colsMatch?.[2] || 'Attribute',
          valueColumnName: colsMatch?.[3] || 'Value'
        }
      };
    }
    else if (/Table\.Unpivot\b/i.test(expr)) {
      const colsMatch = expr.match(/Table\.Unpivot\s*\([^,]+,\s*(\{[^}]*\})\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"/i);
      const attributeColumns = colsMatch ? extractListItems(colsMatch[1]) : [];
      step = {
        stepName,
        actionType: 'UNPIVOT',
        description: `Unpivot columns [${attributeColumns.join(', ')}] into attribute/value pairs`,
        properties: {
          attributeColumns,
          attributeColumnName: colsMatch?.[2] || 'Attribute',
          valueColumnName: colsMatch?.[3] || 'Value'
        }
      };
    }

    // ── DUPLICATE_COLUMN: Table.DuplicateColumn ──
    else if (/Table\.DuplicateColumn/i.test(expr)) {
      const dupMatch = expr.match(/Table\.DuplicateColumn\s*\([^,]+,\s*"([^"]+)"\s*,\s*"([^"]+)"/i);
      step = {
        stepName,
        actionType: 'DUPLICATE_COLUMN',
        description: `Duplicate column '${dupMatch?.[1] || ''}' as '${dupMatch?.[2] || ''}'`,
        properties: {
          sourceColumn: dupMatch?.[1] || '',
          newColumnName: dupMatch?.[2] || ''
        }
      };
    }

    // ── SPLIT_COLUMN: Table.SplitColumn / Text.Split ──
    else if (/Table\.SplitColumn/i.test(expr)) {
      const splitMatch = expr.match(/Table\.SplitColumn\s*\([^,]+,\s*"([^"]+)"/i);
      const delimMatch = expr.match(/Splitter\.SplitTextByDelimiter\s*\(\s*"([^"]+)"/i)
        || expr.match(/Splitter\.SplitTextByEachDelimiter\s*\(\s*\{\s*"([^"]+)"/i);
      step = {
        stepName,
        actionType: 'SPLIT_COLUMN',
        description: `Split column '${splitMatch?.[1] || ''}' by delimiter '${delimMatch?.[1] || ''}'`,
        properties: {
          sourceColumn: splitMatch?.[1] || '',
          delimiter: delimMatch?.[1] || '',
          outputColumns: []
        }
      };
    }

    // ── FIND_REPLACE: Table.ReplaceValue ──
    else if (/Table\.ReplaceValue/i.test(expr)) {
      const replMatch = expr.match(/Table\.ReplaceValue\s*\([^,]+,\s*"([^"]*)"\s*,\s*"([^"]*)"\s*,\s*Replacer\.Replace\w*\s*,\s*\{\s*"([^"]+)"/i);
      step = {
        stepName,
        actionType: 'FIND_REPLACE',
        description: `Replace '${replMatch?.[1] || ''}' with '${replMatch?.[2] || ''}' in column '${replMatch?.[3] || ''}'`,
        properties: {
          column: replMatch?.[3] || '',
          findValue: replMatch?.[1] || '',
          replaceValue: replMatch?.[2] || '',
          matchCase: true
        }
      };
    }

    // ── TEXT_FORMULA: Table.TransformColumns with Text.* ──
    else if (/Table\.TransformColumns/i.test(expr) && /Text\./i.test(expr)) {
      const colMatch = expr.match(/"([^"]+)"\s*,\s*Text\.(\w+)/i);
      step = {
        stepName,
        actionType: 'TEXT_FORMULA',
        description: `Apply Text.${colMatch?.[2] || 'Transform'} to column '${colMatch?.[1] || ''}'`,
        properties: {
          columnName: colMatch?.[1] || '',
          operation: (colMatch?.[2] || 'UPPER').toUpperCase(),
          sourceColumn: colMatch?.[1] || ''
        }
      };
    }

    // ── NUMBER_FORMULA: Table.TransformColumns with Number.* ──
    else if (/Table\.TransformColumns/i.test(expr) && /Number\./i.test(expr)) {
      const colMatch = expr.match(/"([^"]+)"\s*,\s*Number\.(\w+)/i);
      step = {
        stepName,
        actionType: 'NUMBER_FORMULA',
        description: `Apply Number.${colMatch?.[2] || 'Round'} to column '${colMatch?.[1] || ''}'`,
        properties: {
          columnName: colMatch?.[1] || '',
          operation: (colMatch?.[2] || 'ROUND').toUpperCase(),
          sourceColumn: colMatch?.[1] || '',
          precision: 0
        }
      };
    }

    // ── ADD_COLUMN variants (must come after specific checks) ──
    else if (/Table\.AddColumn/i.test(expr)) {
      const addColResult = classifyAddColumn(expr);
      if (addColResult) {
        if (addColResult.actionType === 'ADD_CONSTANT') {
          step = {
            stepName,
            actionType: 'ADD_CONSTANT',
            description: `Add constant column '${addColResult.columnName}' with value '${addColResult.value}'`,
            properties: {
              columnName: addColResult.columnName,
              value: addColResult.value,
              dataType: addColResult.dataType
            }
          };
        } else if (addColResult.actionType === 'DATE_OPERATIONS') {
          step = {
            stepName,
            actionType: 'DATE_OPERATIONS',
            description: `Add date column '${addColResult.columnName}' — ${addColResult.operation} from '${addColResult.sourceColumn}'`,
            properties: {
              columnName: addColResult.columnName,
              operation: addColResult.operation,
              sourceColumn: addColResult.sourceColumn,
              unit: addColResult.unit
            }
          };
        } else if (addColResult.actionType === 'NUMBER_FORMAT') {
          step = {
            stepName,
            actionType: 'NUMBER_FORMULA',
            description: `Add number column '${addColResult.columnName}' — ${addColResult.operation}(${addColResult.sourceColumn})`,
            properties: {
              columnName: addColResult.columnName,
              operation: addColResult.operation,
              sourceColumn: addColResult.sourceColumn,
              precision: addColResult.precision
            }
          };
        } else if (addColResult.actionType === 'TEXT_FORMULA') {
          step = {
            stepName,
            actionType: 'TEXT_FORMULA',
            description: `Add text column '${addColResult.columnName}' — ${addColResult.operation}(${addColResult.sourceColumn})`,
            properties: {
              columnName: addColResult.columnName,
              operation: addColResult.operation,
              sourceColumn: addColResult.sourceColumn
            }
          };
        } else if (addColResult.actionType === 'COLUMN_COMBINE') {
          step = {
            stepName,
            actionType: 'COLUMN_COMBINE',
            description: `Combine columns [${addColResult.sourceColumns.join(', ')}] into '${addColResult.outputColumn}'${addColResult.separator ? ` with separator '${addColResult.separator}'` : ''}`,
            properties: {
              sourceColumns: addColResult.sourceColumns,
              outputColumn: addColResult.outputColumn,
              separator: addColResult.separator
            }
          };
        } else {
          // ADD_FORMULA
          step = {
            stepName,
            actionType: 'ADD_FORMULA',
            description: `Add calculated column '${addColResult.columnName}' = ${addColResult.formula}`,
            properties: {
              columnName: addColResult.columnName,
              formula: addColResult.formula
            }
          };
        }
      }
    }

    // ── RANK_WINDOW: Table.AddRankColumn ──
    else if (/Table\.AddRankColumn/i.test(expr)) {
      const rankMatch = expr.match(/Table\.AddRankColumn\s*\([^,]+,\s*"([^"]+)"/i);
      step = {
        stepName,
        actionType: 'RANK_WINDOW',
        description: `Add rank column '${rankMatch?.[1] || 'Rank'}'`,
        properties: {
          partitionColumns: [],
          orderColumn: '',
          rankType: 'RANK'
        }
      };
    }

    // ── Table.FillDown / Table.FillUp → MANUAL_BUILD ──
    else if (/Table\.Fill(Down|Up)/i.test(expr)) {
      const direction = /FillDown/i.test(expr) ? 'down' : 'up';
      const columns = extractColumnNames(expr);
      step = {
        stepName,
        actionType: 'MANUAL_BUILD',
        description: `Fill ${direction} null values in columns [${columns.join(', ')}]. No native Domo tile — build manually using Beast Mode or MySQL dataflow.`,
        properties: { description: `Fill ${direction}: ${columns.join(', ')}` }
      };
    }

    // ── Table.Buffer / Table.Schema / metadata → MANUAL_BUILD ──
    else if (/Table\.(Buffer|Schema|View)/i.test(expr)) {
      step = {
        stepName,
        actionType: 'MANUAL_BUILD',
        description: `M step '${stepName}' uses ${expr.substring(0, 40)}... — no Domo tile equivalent. Can be safely skipped.`,
        properties: { description: `Internal M operation: ${stepName}` }
      };
    }

    // ── Table.ExpandTableColumn / Table.ExpandRecordColumn → MANUAL_BUILD ──
    else if (/Table\.Expand(Table|Record)Column/i.test(expr)) {
      const expandColMatch = expr.match(/Table\.Expand\w+Column\s*\([^,]+,\s*"([^"]+)"/i);
      const expandedCols = extractColumnNames(expr);
      step = {
        stepName,
        actionType: 'MANUAL_BUILD',
        description: `Expand nested column '${expandColMatch?.[1] || ''}' — extract fields [${expandedCols.length > 0 ? expandedCols.join(', ') : 'unknown — check source'
          }]. Build manually in Domo using joins or flattening logic.`,
        properties: {
          description: `Expand column '${expandColMatch?.[1] || ''}' with fields: ${expandedCols.join(', ')}`
        }
      };
    }

    // ── Fallback: MANUAL_BUILD for anything unrecognized ──
    if (!step) {
      // Try to identify the primary M function
      const funcMatch = expr.match(/^(\w+(?:\.\w+)*)\s*\(/);
      const funcName = funcMatch ? funcMatch[1] : 'Unknown';

      step = {
        stepName,
        actionType: 'MANUAL_BUILD',
        description: `Step '${stepName}' uses M function '${funcName}' — no automatic Domo tile mapping. Review and build manually.`,
        properties: {
          description: `Unrecognized M function: ${funcName}. Original expression: ${expr.substring(0, 200)}`
        }
      };
    }

    steps.push(step);
  }

  return steps;
}


// ─── Dataflow Definition Builder ────────────────────────────────────────────

/**
 * Builds a complete dataflow definition JSON object for one table.
 *
 * @param {string} reportName - Power BI report name
 * @param {string} tableName  - Table name
 * @param {string} domoInputDatasetId - Domo dataset ID for the raw data
 * @param {Array}  steps      - Parsed ETL steps from parsePowerQuerySteps()
 * @returns {object} Dataflow definition matching the output schema
 */
export function buildDataflowDefinition(reportName, tableName, domoInputDatasetId, steps) {
  return {
    dataflowName: `${reportName} - ${tableName} (Magic ETL)`,
    tableName,
    domoInputDatasetId,
    outputDatasetName: `${reportName} - ${tableName} Output`,
    steps: steps || [],
    skipped: !steps || steps.length === 0,
    skipReason: !steps || steps.length === 0 ? 'No parseable M Query steps found' : null,
  };
}
