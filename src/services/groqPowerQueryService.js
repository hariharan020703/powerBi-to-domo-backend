import axios from 'axios';

// ─── Constants ──────────────────────────────────────────────────────────────
const ALLOWED_ACTION_TYPES = [
  'FILTER', 'SELECT_COLUMNS', 'REMOVE_COLUMNS', 'RENAME_COLUMNS',
  'SET_COLUMN_TYPE', 'ADD_FORMULA', 'ADD_CONSTANT', 'GROUP_BY',
  'SORT', 'REMOVE_DUPLICATES', 'TOP_N_ROWS', 'JOIN_DATA',
  'APPEND_ROWS', 'PIVOT', 'UNPIVOT', 'DUPLICATE_COLUMN',
  'SPLIT_COLUMN', 'FIND_REPLACE', 'TEXT_FORMULA', 'NUMBER_FORMULA',
  'DATE_OPERATIONS', 'MANUAL_BUILD'
];

// ─── Local Helpers (Copied from magicEtlService.js for compatibility) ────────
function mapMTypeToEtlType(mType) {
  const t = String(mType || '').toLowerCase().replace(/\s+/g, '');
  if (t === 'int64.type' || t === 'integer' || t === 'long') return 'LONG';
  if (t === 'typenumber' || t === 'double' || t === 'decimal') return 'DOUBLE';
  if (t === 'typedate') return 'DATE';
  if (t === 'typedatetime' || t === 'datetime') return 'DATETIME';
  return 'STRING';
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

export function mapStepToDomoAction(step, tileId, x, y, previousTileId, stepNameToTileId = {}) {
  if (step.actionType === 'MANUAL_BUILD') {
    console.warn(`[PQ SERVICE] Skipping MANUAL_BUILD step: ${step.stepName || step.description}`);
    return null;
  }

  const base = {
    id: tileId,
    name: step.stepName || step.description || `Step ${tileId}`,
    dependsOn: previousTileId ? [previousTileId] : [],
    gui: makeActionGui(x, y),
  };

  switch (step.actionType) {
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

    case 'FILTER':
      return {
        ...base,
        type: 'Filter',
        settings: {
          filterCondition: step.properties.condition || '',
        },
      };

    case 'SELECT_COLUMNS':
      return {
        ...base,
        type: 'SelectValues',
        fields: (step.properties.columns || []).map(c => ({
          name: c,
          included: true
        })),
        removeByDefault: true,
      };

    case 'REMOVE_COLUMNS':
      return {
        ...base,
        type: 'SelectValues',
        fields: (step.properties.columns || []).map(c => ({
          name: c,
          included: false
        })),
        removeByDefault: false,
      };

    case 'RENAME_COLUMNS':
      return {
        ...base,
        type: 'SelectValues',
        fields: (step.properties.renames || []).map(r => ({
          name: r.from,
          newName: r.to,
          included: true
        })),
        removeByDefault: false,
      };

    case 'SET_COLUMN_TYPE':
      return {
        ...base,
        type: 'EditMetadata',
        fields: (step.properties.columns || [])
          .filter(c => c.name && c.name.trim().length > 0)
          .map(c => ({
            name: c.name,
            newName: c.name,
            type: mapMTypeToEtlType(c.toType),
            hidden: false
          })),
      };

    case 'ADD_FORMULA':
      return {
        ...base,
        type: 'Calculation',
        fields: [
          {
            name: step.properties.columnName || '',
            formula: step.properties.formula || '',
          }
        ],
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
        type: 'Calculation',
        fields: [
          {
            name: step.properties.columnName || '',
            formula: exprStr,
          }
        ],
      };
    }

    case 'GROUP_BY':
      return {
        ...base,
        type: 'Aggregate',
        settings: {
          groupByColumns: (step.properties.groupByColumns || []).map(col => ({
            name: col
          })),
          aggregations: (step.properties.aggregations || []).map(agg => ({
            outputName: agg.outputColName || '',
            function: agg.aggregationFunction || 'SUM',
            sourceName: agg.sourceCol || ''
          })),
        },
      };

    case 'SORT':
      return {
        ...base,
        type: 'Sort',
        settings: {
          orderByColumns: (step.properties.sortColumns || []).map(s => ({
            name: s.column,
            descending: s.order === 'DESC'
          })),
        },
      };

    case 'REMOVE_DUPLICATES':
      return {
        ...base,
        type: 'Distinct',
        settings: {
          keyColumns: (step.properties.keyColumns || []).map(col => ({
            name: col
          })),
        },
      };

    case 'TOP_N_ROWS':
      return {
        ...base,
        type: 'TopN',
        settings: {
          n: step.properties.n || 10,
          order: step.properties.order || 'FIRST',
          orderByColumn: step.properties.orderByColumn || '',
        },
      };

    case 'JOIN_DATA':
      return {
        ...base,
        type: 'Join',
        joinType: step.properties.joinType === 'LEFT' ? 'LEFT OUTER'
          : step.properties.joinType === 'INNER' ? 'INNER'
            : step.properties.joinType === 'FULL' ? 'FULL OUTER'
              : 'LEFT OUTER',
        keys1: Array.isArray(step.properties.leftKey)
          ? step.properties.leftKey.map(k => ({ name: k }))
          : [{ name: step.properties.leftKey || '' }],
        keys2: Array.isArray(step.properties.rightKey)
          ? step.properties.rightKey.map(k => ({ name: k }))
          : [{ name: step.properties.rightKey || '' }],
        step1: base.dependsOn[0] || '',
        step2: step.properties.rightDataset || '',
      };

    case 'APPEND_ROWS': {
      const rightStepName = step.properties.rightInputStepName;
      const rightTileId = rightStepName && stepNameToTileId[rightStepName]
        ? stepNameToTileId[rightStepName]
        : previousTileId;
      return {
        ...base,
        type: 'UnionAll',
        dependsOn: [previousTileId, rightTileId],
        settings: {},
      };
    }

    case 'PIVOT':
      return {
        ...base,
        type: 'Pivot',
        settings: {
          pivotColumn: step.properties.pivotColumn || '',
          valueColumn: step.properties.valueColumn || '',
          aggregation: step.properties.aggregation || 'SUM',
        },
      };

    case 'UNPIVOT':
      return {
        ...base,
        type: 'Unpivot',
        settings: {
          attributeColumns: (step.properties.attributeColumns || []).map(c => ({
            name: c
          })),
          attributeColumnName: step.properties.attributeColumnName || 'Attribute',
          valueColumnName: step.properties.valueColumnName || 'Value',
        },
      };

    case 'DUPLICATE_COLUMN':
      return {
        ...base,
        type: 'Calculation',
        fields: [
          {
            name: step.properties.newColumnName || '',
            formula: `\`${step.properties.sourceColumn || ''}\``,
          }
        ],
      };

    case 'SPLIT_COLUMN':
      return {
        ...base,
        type: 'StringSplit',
        settings: {
          sourceColumn: step.properties.sourceColumn || '',
          delimiter: step.properties.delimiter || ',',
          outputColumns: step.properties.outputColumns || [],
        },
      };

    case 'TEXT_FORMULA':
      return {
        ...base,
        type: 'Calculation',
        fields: [
          {
            name: step.properties.columnName || '',
            formula: `${step.properties.operation || 'UPPER'}(\`${step.properties.sourceColumn || ''}\`)`,
          }
        ],
      };

    case 'NUMBER_FORMULA':
      return {
        ...base,
        type: 'Calculation',
        fields: [
          {
            name: step.properties.columnName || '',
            formula: `${step.properties.operation || 'ROUND'}(\`${step.properties.sourceColumn || ''}\`, ${step.properties.precision ?? 2})`,
          }
        ],
      };

    case 'DATE_OPERATIONS':
      return {
        ...base,
        type: 'Calculation',
        fields: [
          {
            name: step.properties.columnName || '',
            formula: `${step.properties.operation || 'YEAR'}(\`${step.properties.sourceColumn || ''}\`)`,
          }
        ],
      };

    case 'MANUAL_BUILD':
    default:
      return null;

  }
}

function normalizeActionType(actionType) {
  if (!actionType) return '';
  return actionType
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s-]/g, '_')
    .toUpperCase();
}

// ─── Validator ──────────────────────────────────────────────────────────────
function validateEtlSteps(steps) {
  if (!Array.isArray(steps)) {
    throw new Error('Response must contain an array of steps.');
  }
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step.actionType) {
      throw new Error(`Step at index ${i} is missing actionType.`);
    }
    const norm = normalizeActionType(step.actionType);
    if (!ALLOWED_ACTION_TYPES.includes(norm)) {
      throw new Error(`Step at index ${i} has invalid actionType "${step.actionType}". Must be one of: ${ALLOWED_ACTION_TYPES.join(', ')}`);
    }
    step.actionType = norm;
    if (!step.stepName) {
      throw new Error(`Step at index ${i} is missing stepName.`);
    }
    if (!step.properties || typeof step.properties !== 'object') {
      throw new Error(`Step at index ${i} is missing properties object.`);
    }

    // Validate specific schemas
    if (step.actionType === 'FILTER' && typeof step.properties.condition !== 'string') {
      throw new Error(`Step at index ${i} (FILTER) must have a "condition" string property.`);
    }
    if (step.actionType === 'RENAME_COLUMNS' && !Array.isArray(step.properties.renames)) {
      throw new Error(`Step at index ${i} (RENAME_COLUMNS) must have a "renames" array property.`);
    }
    if (step.actionType === 'SET_COLUMN_TYPE' && !Array.isArray(step.properties.columns)) {
      throw new Error(`Step at index ${i} (SET_COLUMN_TYPE) must have a "columns" array property.`);
    }
    if (step.actionType === 'ADD_FORMULA' && (typeof step.properties.columnName !== 'string' || typeof step.properties.formula !== 'string')) {
      throw new Error(`Step at index ${i} (ADD_FORMULA) must have "columnName" and "formula" string properties.`);
    }
    if (step.actionType === 'GROUP_BY') {
      if (!Array.isArray(step.properties.groupByColumns) || !Array.isArray(step.properties.aggregations)) {
        throw new Error(`Step at index ${i} (GROUP_BY) must have "groupByColumns" and "aggregations" array properties.`);
      }
    }
    if (step.actionType === 'JOIN_DATA') {
      if (typeof step.properties.joinType !== 'string' || !Array.isArray(step.properties.leftKey) || !Array.isArray(step.properties.rightKey) || typeof step.properties.rightDataset !== 'string') {
        throw new Error(`Step at index ${i} (JOIN_DATA) must have "joinType" string, "leftKey" array, "rightKey" array, and "rightDataset" string properties.`);
      }
    }
  }
}

// ─── System Prompt ──────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a Power Query M Expression to Domo Magic ETL step converter.

CRITICAL RULES:
1. Skip SOURCE step (Csv.Document, Table.FromRows, Sql.Database, File.Contents etc) — data already loaded
2. Skip FINAL step (the "in" line)
3. Table.PromoteHeaders → SKIP it
4. Return ONLY raw JSON, no markdown, no explanation

STRICT ACCURACY RULE — CRITICAL:
Only convert steps that ACTUALLY EXIST in the M expression.
NEVER invent, assume, or add steps that are not explicitly present in the M expression.
NEVER add REMOVE_COLUMNS unless Table.RemoveColumns explicitly appears in the M expression.
NEVER add RENAME_COLUMNS unless Table.RenameColumns explicitly appears in the M expression.
NEVER add FILTER unless Table.SelectRows explicitly appears in the M expression.
NEVER add REMOVE_DUPLICATES unless Table.Distinct explicitly appears in the M expression.
NEVER add any step that you think "should" be there — only add steps that ARE there.

Before outputting each step, verify:
1. Does this exact M function call exist in the expression above?
2. If NO → do not include this step
3. If YES → include it

If the M expression only has Table.PromoteHeaders and Table.TransformColumnTypes, output ONLY SET_COLUMN_TYPE (skip PromoteHeaders).

COLUMN CONFIGURATION RULE — CRITICAL:
When generating SET_COLUMN_TYPE steps, you MUST use ONLY the exact column names from the "Available columns" list provided below.
NEVER rename, shorten, abbreviate, or modify column names.
NEVER invent column names not in the available columns list.
If a column in the M expression does not match any name in the available columns list, find the closest exact match from the list and use that.
Column names are case-sensitive — copy them exactly as they appear in the available columns list.

Example — WRONG:
{ "name": "Ser_num", "toType": "LONG" }

Example — CORRECT (exact match from available columns):
{ "name": "Ser_Num", "toType": "LONG" }

Type mapping from Power Query to Domo:
- Int64.Type → LONG
- type number / Decimal.Type → DOUBLE
- type date → DATE
- type datetime / DateTime.Type → DATETIME
- type text / type any → STRING
- type logical → STRING
- Currency.Type → DOUBLE
- Percentage.Type → DOUBLE

ALLOWED ACTION TYPES (copy exactly, no variations):
FILTER, SELECT_COLUMNS, REMOVE_COLUMNS, RENAME_COLUMNS, SET_COLUMN_TYPE, ADD_FORMULA, ADD_CONSTANT, GROUP_BY, SORT, REMOVE_DUPLICATES, TOP_N_ROWS, JOIN_DATA, APPEND_ROWS, PIVOT, UNPIVOT, DUPLICATE_COLUMN, SPLIT_COLUMN, FIND_REPLACE, TEXT_FORMULA, NUMBER_FORMULA, DATE_OPERATIONS, MANUAL_BUILD

BANNED ACTION TYPES — NEVER USE:
REPLACE_VALUE, ReplaceValue, FilterRows, RemoveDuplicatesAction, AddConstantAction, ManualAction, UnionAll, TransformColumns, AddColumn, RemoveColumn, RenameColumn, ChangeType, SelectValues, Metadata, EditMetadata, GroupBy, any camelCase or PascalCase

M EXPRESSION TO ACTION TYPE MAPPING:
- Table.TransformColumnTypes → SET_COLUMN_TYPE
- Table.RemoveColumns → REMOVE_COLUMNS
- Table.SelectColumns → SELECT_COLUMNS
- Table.RenameColumns → RENAME_COLUMNS
- Table.ReplaceValue → FIND_REPLACE
- Table.SelectRows → FILTER
- Table.AddColumn → ADD_FORMULA
- Table.Group → GROUP_BY
- Table.Sort → SORT
- Table.Distinct → REMOVE_DUPLICATES
- Table.FirstN / Table.LastN → TOP_N_ROWS
- Table.NestedJoin / Table.Join → JOIN_DATA
- Table.Combine → APPEND_ROWS
- Table.Pivot → PIVOT
- Table.Unpivot → UNPIVOT
- Table.DuplicateColumn → DUPLICATE_COLUMN
- Table.SplitColumn → SPLIT_COLUMN
- Table.TransformColumns → ADD_FORMULA
- Anything else → MANUAL_BUILD

MERGE RULE — CRITICAL:
If multiple consecutive M steps do the same transformation (e.g. multiple Table.TransformColumnTypes, multiple Table.RemoveColumns, multiple Table.ReplaceValue), combine them ALL into a SINGLE step with all columns/renames/replacements merged into one properties array. NEVER create separate steps for the same action type when they can be combined.

Example — WRONG (3 separate steps):
{ "actionType": "FIND_REPLACE", "stepName": "ReplacedValue", "properties": { "column": "col1", "findValue": "null", "replaceValue": "" } }
{ "actionType": "FIND_REPLACE", "stepName": "ReplacedValue1", "properties": { "column": "col2", "findValue": "null", "replaceValue": "" } }
{ "actionType": "FIND_REPLACE", "stepName": "ReplacedValue2", "properties": { "column": "col3", "findValue": "null", "replaceValue": "" } }

Example — CORRECT (1 merged step):
{ "actionType": "FIND_REPLACE", "stepName": "ReplacedValues", "properties": { "replacements": [{ "column": "col1", "findValue": "null", "replaceValue": "" }, { "column": "col2", "findValue": "null", "replaceValue": "" }, { "column": "col3", "findValue": "null", "replaceValue": "" }] } }

PROPERTY SCHEMAS:
- FILTER: { "condition": "SQL WHERE using backticks e.g. \`col\` > 0" }
- RENAME_COLUMNS: { "renames": [{ "from": "oldName", "to": "newName" }, { "from": "oldName2", "to": "newName2" }] }
- REMOVE_COLUMNS: { "columns": ["col1", "col2", "col3"] }
- SELECT_COLUMNS: { "columns": ["col1", "col2"] }
- SET_COLUMN_TYPE: { "columns": [{ "name": "col1", "toType": "STRING|LONG|DOUBLE|DATE|DATETIME" }, { "name": "col2", "toType": "LONG" }] }
- ADD_FORMULA: { "columnName": "newCol", "formula": "SQL expression using backticks" }
- ADD_CONSTANT: { "columnName": "col", "value": "value", "dataType": "STRING|LONG|DOUBLE|DATE|DATETIME" }
- GROUP_BY: { "groupByColumns": ["col1"], "aggregations": [{ "outputColName": "name", "aggregationFunction": "SUM|AVG|COUNT|MIN|MAX", "sourceCol": "col" }] }
- SORT: { "sortColumns": [{ "column": "colName", "order": "ASC|DESC" }] }
- REMOVE_DUPLICATES: { "keyColumns": ["colName"] }
- TOP_N_ROWS: { "n": 10, "order": "FIRST|LAST", "orderByColumn": null }
- JOIN_DATA: { "joinType": "LEFT|INNER|FULL", "leftKey": ["col"], "rightKey": ["col"], "rightDataset": "tableName" }
- APPEND_ROWS: { "leftInputStepName": "stepName", "rightInputStepName": "stepName" }
- FIND_REPLACE: { "replacements": [{ "column": "colName", "findValue": "val", "replaceValue": "val", "matchCase": false }] }
- MANUAL_BUILD: { "description": "what needs manual configuration" }

OUTPUT FORMAT — return ONLY this raw JSON:
{
  "steps": [
    {
      "actionType": "SET_COLUMN_TYPE",
      "stepName": "ChangedTypes",
      "properties": {
        "columns": [
          { "name": "Ser_Num", "toType": "LONG" },
          { "name": "Modified", "toType": "DATE" },
          { "name": "Created", "toType": "DATE" }
        ]
      }
    }
  ]
}

M Expression to convert:
{{M_EXPRESSION}}

Available columns:
{{COLUMN_LIST}}`;

// ─── Main Service Function ──────────────────────────────────────────────────
let _rateLimitExceeded = false;
let _lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 2000; // 2.0s minimum between API requests to respect 30 RPM

export function resetPqRateLimit() {
  console.log('[PQ SERVICE] Resetting rate limit exceeded flag.');
  _rateLimitExceeded = false;
}

async function enforcePacing() {
  const elapsed = Date.now() - _lastRequestTime;
  if (elapsed < MIN_REQUEST_INTERVAL) {
    const sleepTime = MIN_REQUEST_INTERVAL - elapsed;
    console.log(`[PQ SERVICE] Pacing API requests. Sleeping for ${sleepTime}ms...`);
    await new Promise(resolve => setTimeout(resolve, sleepTime));
  }
  _lastRequestTime = Date.now();
}

// ─── Main Service Function ──────────────────────────────────────────────────
export async function convertMExpressionToEtlSteps(mExpression, tableName, availableColumns) {
  if (_rateLimitExceeded) {
    console.warn(`[PQ SERVICE] Rate limit previously exceeded. Bypassing API call for '${tableName}' and using manual fallback.`);
    return getManualFallbackResult(tableName, 'Groq rate limit previously exceeded. Using manual review fallback.');
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.error('[PQ SERVICE] GROQ_API_KEY is not defined in environment variables.');
    return getManualFallbackResult(tableName, 'Missing GROQ_API_KEY environment variable');
  }

  // Detect parameter table keywords manually for safety as well
  const lowerExpr = String(mExpression).toLowerCase();
  const looksLikeParameterTable = lowerExpr.includes('list.transform') || lowerExpr.includes('#table') || lowerExpr.includes('record.field');
  if (looksLikeParameterTable && lowerExpr.length < 500) {
    console.log(`[PQ SERVICE] Table "${tableName}" detected as static parameter table — returning empty steps array.`);
    return [];
  }

  // Pre-filter: Check if there are any active transformation keywords. If not, skip creating a Magic ETL.
  const TRANSFORMATION_KEYWORDS = [
    'table.selectrows',
    'table.renamecolumns',
    'table.removecolumns',
    'table.selectcolumns',
    'table.transformcolumntypes',
    'table.addcolumn',
    'table.group',
    'table.sort',
    'table.distinct',
    'table.firstn',
    'table.lastn',
    'table.nestedjoin',
    'table.join',
    'table.combine',
    'table.pivot',
    'table.unpivot',
    'table.duplicatecolumn',
    'table.splitcolumn',
    'table.replacevalue',
    'table.transformcolumns',
    'table.addindexcolumn',
    'table.skip',
    'table.transpose',
    'table.alternaterows',
    'table.selectrow',
    'table.replacekeys',
    'table.reordercolumns'
  ];

  const hasKeyword = TRANSFORMATION_KEYWORDS.some(kw => lowerExpr.includes(kw));
  if (!hasKeyword) {
    console.log(`[PQ SERVICE] Table "${tableName}" has no transformation keywords — returning empty steps array.`);
    return [];
  }

  const columnsList = Array.isArray(availableColumns)
    ? availableColumns.map(c => typeof c === 'string' ? c : (c.name || c.columnName || ''))
    : [];

  let userMessage = SYSTEM_PROMPT
    .replace('{{M_EXPRESSION}}', mExpression)
    .replace('{{COLUMN_LIST}}', columnsList.join(', '));

  let lastError = null;

  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      console.log(`[PQ SERVICE] Groq conversion attempt ${attempt}/5 for table ${tableName}...`);

      await enforcePacing();

      const response = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          model: process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
          messages: [
            { role: 'user', content: userMessage }
          ],
          response_format: { type: 'json_object' },
          temperature: 0.1,
          max_tokens: 2048
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
        userMessage += `\n\nYour previous response was not valid JSON. Return ONLY a JSON object. Error: ${jsonErr.message}`;
        throw jsonErr;
      }

      const steps = parsedJson?.steps || [];
      try {
        validateEtlSteps(steps);
      } catch (valErr) {
        userMessage += `\n\nYour previous response failed validation: ${valErr.message}\nPlease correct the step output schema.`;
        throw valErr;
      }

      console.log(`[PQ SERVICE] Groq successfully returned and validated ${steps.length} steps for table ${tableName}.`);
      return steps;

    } catch (err) {
      lastError = err.message;
      const status = err.response?.status;
      const responseData = err.response?.data;
      const responseMsg = responseData?.error?.message || '';
      console.warn(`[PQ SERVICE] Attempt ${attempt}/5 failed (HTTP status: ${status}): ${lastError}. Details: ${responseMsg}`);

      if (status === 429) {
        // Parse retry-after header if present
        const retryAfterHeader = err.response?.headers?.['retry-after'];
        let delay = 5000; // default fallback wait
        if (retryAfterHeader) {
          const seconds = parseFloat(retryAfterHeader);
          if (!isNaN(seconds)) {
            delay = Math.ceil(seconds * 1000) + 1000; // convert to ms and add 1000ms safety buffer
          }
        }

        console.warn(`[PQ SERVICE] Hit 429 Rate Limit. retry-after suggests waiting ${delay}ms.`);

        // Determine if it is a hard daily quota/limit or if we've exhausted all retries
        const isQuotaExceeded = 
          delay > 30000 || 
          responseMsg.toLowerCase().includes('daily') || 
          responseMsg.toLowerCase().includes('quota') || 
          (responseMsg.toLowerCase().includes('limit reached') && 
           (responseMsg.toLowerCase().includes('day') || responseMsg.toLowerCase().includes('rpd') || responseMsg.toLowerCase().includes('tpd')));

        if (isQuotaExceeded || attempt === 5) {
          console.error(`[PQ SERVICE] Daily limit/quota exceeded or maximum retries reached. Setting _rateLimitExceeded to true to skip future calls.`);
          _rateLimitExceeded = true;
          break; // break retry loop and use fallback
        }

        // Wait for retry duration
        console.log(`[PQ SERVICE] Transient rate limit hit. Waiting ${delay}ms before retrying...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      // If it's a non-429 error, use standard exponential backoff
      if (attempt < 5) {
        let delay = Math.pow(2, attempt) * 1000;
        console.log(`[PQ SERVICE] Non-429 error. Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  console.error(`[PQ SERVICE] All attempts exhausted or rate limit hit for table ${tableName}. Falling back to MANUAL_BUILD.`);
  return getManualFallbackResult(tableName, `Groq conversion failed or rate limited. Last error: ${lastError}`);
}

function getManualFallbackResult(tableName, reason) {
  return [
    {
      actionType: 'MANUAL_BUILD',
      stepName: 'Manual Review Needed',
      properties: {
        description: `Please manually review the M expression for table "${tableName}". Reason: ${reason}`
      }
    }
  ];
}

/**
 * Builds a complete dataflow definition JSON object for one table.
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
