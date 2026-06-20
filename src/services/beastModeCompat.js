/**
 * Beast Mode Compatibility Map & Validation
 *
 * Static reference module encoding:
 * - Beast Mode supported function whitelist
 * - DAX construct blocklists (ETL / MANUAL_BUILD triggers)
 * - Measure classification (DIRECT_BEASTMODE | ETL_PREAGGREGATION | MANUAL_BUILD)
 * - Post-conversion formula validation
 * - Data type inference, aggregation detection, column extraction
 */

// ─── Beast Mode Supported Functions (Whitelist) ────────────────────────────────

export const BEAST_MODE_FUNCTIONS = {
  aggregate: [
    'SUM', 'AVG', 'COUNT', 'MIN', 'MAX',
    'CEILING', 'FLOOR', 'STDDEV_POP', 'VAR_POP',
    'APPROXIMATE_COUNT_DISTINCT',
    'HLL_SKETCH_INIT', 'HLL_SKETCH_EXTRACT', 'HLL_SKETCH_MERGE',
    'HLL_SKETCH_MERGE_PARTIAL',
  ],
  mathematical: ['ABS', 'MOD', 'POWER', 'RAND', 'ROUND'],
  logical: ['IFNULL', 'NULLIF'],                           // CASE/WHEN/THEN/ELSE/END are keywords, not functions
  string: [
    'CONCAT', 'INSTR', 'LEFT', 'LENGTH', 'LOWER', 'REPLACE', 'RIGHT',
    'SUBSTRING', 'TRIM', 'UPPER',
    'SUBSTRING_INDEX',                                      // community-reported, undocumented
  ],
  datetime: [
    'ADDDATE', 'ADDTIME', 'CURDATE', 'CURTIME', 'CURRENT_DATE', 'CURRENT_TIME',
    'CURRENT_TIMESTAMP', 'DATE', 'DATEDIFF', 'DATE_ADD', 'DATE_FORMAT',
    'DATE_SUB', 'DAY', 'DAYNAME', 'DAYOFMONTH', 'DAYOFWEEK', 'DAYOFYEAR',
    'FROM_DAYS', 'FROM_UNIXTIME', 'HOUR', 'LAST_DAY', 'MINUTE', 'MONTH',
    'MONTHNAME', 'NOW', 'PERIOD_ADD', 'PERIOD_DIFF', 'QUARTER', 'SECOND',
    'SEC_TO_TIME', 'STR_TO_DATE', 'SUBDATE', 'SUBTIME', 'SYSDATE', 'TIME',
    'TIMEDIFF', 'TIMESTAMP', 'TIME_FORMAT', 'TIME_TO_SEC', 'TO_DAYS',
    'UNIX_TIMESTAMP', 'WEEK', 'YEAR', 'YEARWEEK',
  ],
};

// Flattened set for fast lookup
const ALL_ALLOWED_FUNCTIONS = new Set(
  Object.values(BEAST_MODE_FUNCTIONS).flat().map(f => f.toUpperCase())
);

// "SUM(DISTINCT" and "COUNT(DISTINCT" are special compound forms
const COMPOUND_AGGREGATE_FORMS = ['SUM(DISTINCT', 'COUNT(DISTINCT'];

// Logical keywords that appear before `(` but are NOT function calls
const LOGICAL_KEYWORDS = new Set([
  'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'IN', 'LIKE', 'AND', 'OR', 'NOT',
  'BETWEEN', 'IS', 'NULL', 'TRUE', 'FALSE', 'AS', 'DISTINCT',
]);

// Aggregate function names (used for `aggregated` detection + nonAggregatedColumns)
const AGGREGATE_FUNCTIONS = new Set([
  'SUM', 'AVG', 'COUNT', 'MIN', 'MAX',
  'CEILING', 'FLOOR', 'STDDEV_POP', 'VAR_POP',
  'APPROXIMATE_COUNT_DISTINCT',
  'HLL_SKETCH_INIT', 'HLL_SKETCH_EXTRACT', 'HLL_SKETCH_MERGE',
  'HLL_SKETCH_MERGE_PARTIAL',
]);

// ─── Explicitly Unsupported Functions ──────────────────────────────────────────

const BLOCKLISTED_FUNCTIONS = new Set([
  'SQRT', 'CONVERT_TZ', 'MICROSECOND', 'WEEKDAY',
]);

// ─── DAX Constructs that Trigger ETL / MANUAL_BUILD ────────────────────────────

// Cross-table / filter-context functions → ETL_PREAGGREGATION
const ETL_DAX_CONSTRUCTS = [
  'CALCULATE', 'CALCULATETABLE',
  'FILTER',                       // as a table function (not simple IF-filter)
  'ALL', 'ALLEXCEPT', 'ALLSELECTED', 'ALLNOBLANKROW',
  'RELATED', 'RELATEDTABLE',
  'EARLIER', 'EARLIEST',
  'USERELATIONSHIP', 'CROSSFILTER',
];

// Iterative / time-intelligence / complex → MANUAL_BUILD
const MANUAL_BUILD_DAX_CONSTRUCTS = [
  'SUMX', 'AVERAGEX', 'COUNTX', 'MINX', 'MAXX', 'RANKX',
  'SAMEPERIODLASTYEAR', 'DATEADD', 'DATESYTD', 'DATESMTD', 'DATESQTD',
  'TOTALYTD', 'TOTALMTD', 'TOTALQTD',
  'PARALLELPERIOD', 'PREVIOUSYEAR', 'PREVIOUSMONTH', 'PREVIOUSQUARTER',
  'OPENINGBALANCEMONTH', 'CLOSINGBALANCEMONTH',
];

// Regex patterns for complex DAX constructs
const VAR_RETURN_PATTERN = /\bVAR\b[\s\S]+?\bRETURN\b/i;
const VALUES_TABLE_PATTERN = /\bVALUES\s*\(/i;
const DISTINCT_TABLE_PATTERN = /\bDISTINCT\s*\(/i;

/**
 * Build a regex that matches a DAX construct as a whole-word token followed by `(`
 * to avoid false positives on column names that contain the keyword.
 */
function buildDaxConstructRegex(construct) {
  // Escape any regex-special chars in the construct name (none expected, but defensive)
  const escaped = construct.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\s*\\(`, 'i');
}

// Pre-compiled regexes
const ETL_PATTERNS = ETL_DAX_CONSTRUCTS.map(c => ({
  name: c,
  regex: buildDaxConstructRegex(c),
}));

const MANUAL_PATTERNS = MANUAL_BUILD_DAX_CONSTRUCTS.map(c => ({
  name: c,
  regex: buildDaxConstructRegex(c),
}));


// ─── Measure Classification ────────────────────────────────────────────────────

/**
 * Classifies a DAX measure into one of:
 * - DIRECT_BEASTMODE  — safe for LLM conversion to Beast Mode formula
 * - ETL_PREAGGREGATION — cross-table/filter-context logic → ETL steps
 * - MANUAL_BUILD       — time intelligence, iterators, complex, unclassifiable
 *
 * @param {string} name - Measure name
 * @param {string} expression - DAX expression
 * @returns {{ classification: string, reason: string|null }}
 */
export function classifyDaxMeasure(name, expression, hasDependencies = false) {
  if (!expression || expression.trim().length === 0) {
    return { classification: 'MANUAL_BUILD', reason: 'Empty expression' };
  }

  const expr = expression.trim();

  // Check for VAR...RETURN pattern first (multi-step measures)
  if (VAR_RETURN_PATTERN.test(expr)) {
    // Simple VAR/RETURN with only one variable is borderline — but for safety
    // count the number of VAR declarations
    const varCount = (expr.match(/\bVAR\b/gi) || []).length;
    if (varCount > 1) {
      return {
        classification: 'MANUAL_BUILD',
        reason: `Uses VAR...RETURN with ${varCount} variable definitions — multi-step logic`,
      };
    }
    // Single VAR: still risky if it contains complex constructs, fall through
    // to check other patterns
  }

  // Check MANUAL_BUILD triggers (highest priority for "never translate" constructs)
  for (const { name: construct, regex } of MANUAL_PATTERNS) {
    if (regex.test(expr)) {
      return {
        classification: 'MANUAL_BUILD',
        reason: `Uses ${construct} — time intelligence / iterator with no Beast Mode equivalent`,
      };
    }
  }

  // Check ETL_PREAGGREGATION triggers
  for (const { name: construct, regex } of ETL_PATTERNS) {
    if (regex.test(expr)) {
      // Special case: FILTER used as a simple boolean inside IF is not a table function
      if (construct === 'FILTER') {
        // If FILTER is used as FILTER(<table>, ...) it's a table function → ETL
        // A crude but effective check: FILTER( immediately followed by a table ref or '
        // vs. a simple column ref
        const filterMatch = expr.match(/\bFILTER\s*\(\s*([^,)]+)/i);
        if (filterMatch) {
          const firstArg = filterMatch[1].trim();
          // If first arg is a table reference (starts with ' or is a bare word without [])
          if (firstArg.startsWith("'") || !firstArg.includes('[')) {
            return {
              classification: 'ETL_PREAGGREGATION',
              reason: `Uses ${construct} as table function — requires ETL join/group-by`,
            };
          }
          // Otherwise it might be a column filter, still flag as ETL for safety
        }
      }
      return {
        classification: 'ETL_PREAGGREGATION',
        reason: `Uses ${construct} — cross-table / filter-context logic`,
      };
    }
  }

  // Check for VALUES/DISTINCT used as table functions
  if (VALUES_TABLE_PATTERN.test(expr)) {
    // VALUES(<table or column>) — if it looks like a table ref, it's ETL
    const valMatch = expr.match(/\bVALUES\s*\(\s*([^)]+)\)/i);
    if (valMatch) {
      const arg = valMatch[1].trim();
      if (arg.startsWith("'") || !arg.includes('[')) {
        return {
          classification: 'ETL_PREAGGREGATION',
          reason: 'Uses VALUES as a table function',
        };
      }
    }
  }

  if (DISTINCT_TABLE_PATTERN.test(expr)) {
    const distMatch = expr.match(/\bDISTINCT\s*\(\s*([^)]+)\)/i);
    if (distMatch) {
      const arg = distMatch[1].trim();
      if (arg.startsWith("'") || !arg.includes('[')) {
        return {
          classification: 'ETL_PREAGGREGATION',
          reason: 'Uses DISTINCT as a table function',
        };
      }
    }
  }

  // If VAR/RETURN passed through all checks with single var, classify as MANUAL_BUILD
  // to be safe (single-var RETURN typically still involves complex logic)
  if (VAR_RETURN_PATTERN.test(expr)) {
    return {
      classification: 'MANUAL_BUILD',
      reason: 'Uses VAR...RETURN — multi-step variable definition',
    };
  }

  // If it has dependencies, classify as MEASURE_DEPENDENT instead of DIRECT_BEASTMODE
  if (hasDependencies) {
    return { classification: 'MEASURE_DEPENDENT', reason: 'References other measures' };
  }

  // If none of the above matched, it's safe for direct conversion
  return { classification: 'DIRECT_BEASTMODE', reason: null };
}


// ─── Formula Validation ────────────────────────────────────────────────────────

/**
 * Validates a converted Beast Mode formula against the function whitelist
 * and structural rules.
 *
 * @param {string} formula - The Beast Mode formula to validate
 * @param {string[]} availableColumns - Column names on the target Domo dataset
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateBeastModeFormula(formula, availableColumns) {
  const errors = [];

  if (!formula || typeof formula !== 'string' || formula.trim().length === 0) {
    return { valid: false, errors: ['Formula is empty'] };
  }

  const trimmed = formula.trim();

  // 0. Check for unresolved measure reference patterns or DAX brackets
  if (/\bMEASURE\s*\(/i.test(trimmed) || /\bCALCULATE\s*\(/i.test(trimmed) || /\[[^\]]+\]/.test(trimmed)) {
    errors.push("Unresolved measure reference found in converted formula — substitution step likely failed");
  }

  // 1. Check for blocklisted functions
  for (const blocked of BLOCKLISTED_FUNCTIONS) {
    const regex = new RegExp(`\\b${blocked}\\s*\\(`, 'i');
    if (regex.test(trimmed)) {
      errors.push(`Uses unsupported function: ${blocked}`);
    }
  }

  // 2. Extract all function calls: token immediately before `(`
  const funcCallRegex = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let match;
  while ((match = funcCallRegex.exec(trimmed)) !== null) {
    const funcName = match[1].toUpperCase();
    // Skip logical keywords and known allowed functions
    if (LOGICAL_KEYWORDS.has(funcName)) continue;
    if (ALL_ALLOWED_FUNCTIONS.has(funcName)) continue;
    errors.push(`Unknown function: ${funcName} — not in Beast Mode whitelist`);
  }

  // 3. Validate backtick-quoted column references
  const colRefRegex = /`([^`]+)`/g;
  const referencedColumns = [];
  let colMatch;
  while ((colMatch = colRefRegex.exec(trimmed)) !== null) {
    referencedColumns.push(colMatch[1]);
  }

  if (availableColumns && availableColumns.length > 0) {
    const colSet = new Set(availableColumns);
    for (const ref of referencedColumns) {
      if (!colSet.has(ref)) {
        errors.push(`Column reference \`${ref}\` not found in available columns`);
      }
    }
  }

  // 4. Balanced parentheses
  let parenDepth = 0;
  for (const ch of trimmed) {
    if (ch === '(') parenDepth++;
    if (ch === ')') parenDepth--;
    if (parenDepth < 0) {
      errors.push('Unbalanced parentheses: unexpected closing )');
      break;
    }
  }
  if (parenDepth > 0) {
    errors.push(`Unbalanced parentheses: ${parenDepth} unclosed (`);
  }

  // 5. CASE/END matching
  const caseCount = (trimmed.match(/\bCASE\b/gi) || []).length;
  const endCount = (trimmed.match(/\bEND\b/gi) || []).length;
  if (caseCount !== endCount) {
    errors.push(`Mismatched CASE/END: ${caseCount} CASE vs ${endCount} END`);
  }

  // Every CASE must have at least one WHEN/THEN
  if (caseCount > 0) {
    const whenCount = (trimmed.match(/\bWHEN\b/gi) || []).length;
    const thenCount = (trimmed.match(/\bTHEN\b/gi) || []).length;
    if (whenCount === 0 || thenCount === 0) {
      errors.push('CASE block missing WHEN/THEN clause');
    }
  }

  return { valid: errors.length === 0, errors };
}


// ─── Data Type Inference ───────────────────────────────────────────────────────

/**
 * Infers the output dataType for a Beast Mode formula.
 * Returns one of: 'STRING', 'DECIMAL', 'LONG', 'DATE', 'DATETIME'
 *
 * @param {string} formula - The converted Beast Mode formula
 * @returns {string}
 */
export function inferBeastModeDataType(formula) {
  if (!formula) return 'DECIMAL';

  const upper = formula.toUpperCase();

  // Date/time functions → DATETIME or DATE
  const dateFunctions = [
    'CURDATE', 'CURRENT_DATE', 'CURRENT_TIME', 'CURRENT_TIMESTAMP',
    'DATE_ADD', 'DATE_SUB', 'ADDDATE', 'SUBDATE', 'NOW', 'SYSDATE',
    'TIMESTAMP', 'STR_TO_DATE', 'FROM_UNIXTIME', 'LAST_DAY',
  ];
  if (dateFunctions.some(f => upper.includes(f + '('))) {
    return 'DATETIME';
  }

  // Date extraction → LONG
  const dateExtractFunctions = [
    'YEAR', 'MONTH', 'DAY', 'DAYOFMONTH', 'DAYOFWEEK', 'DAYOFYEAR',
    'HOUR', 'MINUTE', 'SECOND', 'QUARTER', 'WEEK', 'YEARWEEK',
    'DATEDIFF', 'PERIOD_DIFF', 'TO_DAYS', 'UNIX_TIMESTAMP', 'TIME_TO_SEC',
  ];
  if (dateExtractFunctions.some(f => upper.includes(f + '('))) {
    return 'LONG';
  }

  // String functions → STRING
  const stringFunctions = [
    'CONCAT', 'LEFT', 'RIGHT', 'SUBSTRING', 'TRIM', 'UPPER', 'LOWER',
    'REPLACE', 'SUBSTRING_INDEX', 'DATE_FORMAT', 'TIME_FORMAT',
    'DAYNAME', 'MONTHNAME',
  ];
  if (stringFunctions.some(f => upper.includes(f + '('))) {
    return 'STRING';
  }

  // CASE...WHEN with string literals in THEN → STRING
  const caseStringPattern = /\bTHEN\s+'[^']*'/i;
  if (caseStringPattern.test(formula)) {
    return 'STRING';
  }

  // Arithmetic / aggregation → DECIMAL
  return 'DECIMAL';
}


// ─── Aggregation Detection ─────────────────────────────────────────────────────

/**
 * Returns true if the formula's outermost operation is an aggregate function.
 *
 * @param {string} formula - The Beast Mode formula
 * @returns {boolean}
 */
export function detectAggregated(formula) {
  if (!formula) return false;

  const trimmed = formula.trim();

  // Check if the entire formula is wrapped in an aggregate function
  for (const agg of AGGREGATE_FUNCTIONS) {
    const regex = new RegExp(`^${agg}\\s*\\(`, 'i');
    if (regex.test(trimmed)) {
      // Verify the opening paren matches the closing paren at end
      let depth = 0;
      let foundOpen = false;
      for (let i = 0; i < trimmed.length; i++) {
        if (trimmed[i] === '(') {
          depth++;
          if (!foundOpen) foundOpen = true;
        }
        if (trimmed[i] === ')') {
          depth--;
          if (depth === 0 && foundOpen && i === trimmed.length - 1) {
            return true; // whole expression is wrapped in aggregate
          }
        }
      }
    }
  }

  // Also check for CASE wrapping an aggregate (common pattern):
  // CASE WHEN ... THEN SUM(...) ELSE ... END
  // In this case, the expression IS aggregated (it contains aggregates)
  for (const agg of AGGREGATE_FUNCTIONS) {
    const regex = new RegExp(`\\b${agg}\\s*\\(`, 'i');
    if (regex.test(trimmed)) {
      return true;
    }
  }

  return false;
}


// ─── Non-Aggregated Column Extraction ──────────────────────────────────────────

/**
 * Finds backtick-quoted column references NOT inside an aggregate function call.
 *
 * @param {string} formula - The Beast Mode formula
 * @returns {string[]} Column names referenced outside aggregates
 */
export function extractNonAggregatedColumns(formula) {
  if (!formula) return [];

  const nonAggCols = [];
  const allCols = [];

  // Collect all column refs
  const colRefRegex = /`([^`]+)`/g;
  let m;
  while ((m = colRefRegex.exec(formula)) !== null) {
    allCols.push({ name: m[1], index: m.index });
  }

  if (allCols.length === 0) return [];

  // For each column ref, check if it's inside an aggregate
  for (const col of allCols) {
    if (!isInsideAggregate(formula, col.index)) {
      if (!nonAggCols.includes(col.name)) {
        nonAggCols.push(col.name);
      }
    }
  }

  return nonAggCols;
}

/**
 * Checks whether a position in the formula string is inside an aggregate function call.
 */
function isInsideAggregate(formula, position) {
  // Scan backwards from position to find if we're inside AGG_FUNC(...)
  // Find the nearest unmatched '(' before position
  let depth = 0;

  for (let i = position - 1; i >= 0; i--) {
    if (formula[i] === ')') {
      depth++;
    } else if (formula[i] === '(') {
      if (depth > 0) {
        depth--;
      } else {
        // Found the unmatched '(' — check what's before it
        const beforeParen = formula.substring(0, i).trimEnd();
        for (const agg of AGGREGATE_FUNCTIONS) {
          if (beforeParen.toUpperCase().endsWith(agg)) {
            return true;
          }
        }
        // Not an aggregate function — could be a CASE sub-expression, etc.
        return false;
      }
    }
  }

  return false;
}


// ─── Build Available Columns List from System Prompt ───────────────────────────

/**
 * Returns the full whitelist as a flat, sorted, comma-separated string
 * suitable for embedding in an LLM system prompt.
 *
 * @returns {string}
 */
export function getWhitelistForPrompt() {
  return Object.values(BEAST_MODE_FUNCTIONS)
    .flat()
    .sort()
    .join(', ');
}

// ─── Measure Dependency Graph & Cycle Detection ──────────────────────────────────

/**
 * Builds a graph mapping each measure name to a set of its bracketed measure dependencies.
 *
 * @param {object[]} measures - List of measures { name, expression }
 * @returns {Map<string, Set<string>>} Map from measure name to its set of dependency names
 */
export function buildMeasureDependencyGraph(measures) {
  const measureNames = new Set(measures.map(m => m.name));
  const graph = new Map();
  const bracketRegex = /\[([^\]]+)\]/g;

  for (const m of measures) {
    const deps = new Set();
    const expr = m.expression || '';
    let match;

    bracketRegex.lastIndex = 0;
    while ((match = bracketRegex.exec(expr)) !== null) {
      const token = match[1].trim();
      if (measureNames.has(token)) {
        deps.add(token);
      }
    }
    graph.set(m.name, deps);
  }
  return graph;
}

/**
 * Finds all nodes in the graph that form or reach a cyclic dependency.
 *
 * @param {Map<string, Set<string>>} graph - Graph of dependencies
 * @returns {Set<string>} Set of node names that are part of or reach a cycle
 */
export function detectCycles(graph) {
  const cyclicNodes = new Set();
  const visited = new Set();

  function hasCycle(node, path) {
    if (path.has(node)) {
      return true;
    }
    if (visited.has(node)) {
      return cyclicNodes.has(node);
    }
    visited.add(node);
    path.add(node);

    const deps = graph.get(node) || new Set();
    for (const dep of deps) {
      if (hasCycle(dep, path)) {
        cyclicNodes.add(node);
        path.delete(node);
        return true;
      }
    }
    path.delete(node);
    return false;
  }

  for (const node of graph.keys()) {
    const path = new Set();
    if (hasCycle(node, path)) {
      cyclicNodes.add(node);
    }
  }
  return cyclicNodes;
}

/**
 * Performs a topological sort of the graph.
 * Assumes the graph has been cleared of cyclic nodes.
 *
 * @param {object[]} measures - Array of measures to sort
 * @param {Map<string, Set<string>>} graph - Graph of dependencies
 * @returns {string[]} Ordered measure names (dependencies first)
 */
export function topologicalSortMeasures(measures, graph) {
  const visited = new Set();
  const order = [];

  function visit(node) {
    if (visited.has(node)) return;
    visited.add(node);

    const deps = graph.get(node) || new Set();
    for (const dep of deps) {
      visit(dep);
    }
    order.push(node);
  }

  for (const m of measures) {
    if (graph.has(m.name)) {
      visit(m.name);
    }
  }

  return order;
}

/**
 * Inline-substitutes converted formulas for bracketed dependency references.
 * Wraps substituted formulas in parentheses to preserve operator precedence.
 *
 * @param {string} expression - The DAX expression containing [Measure] references
 * @param {Map<string, string>} convertedFormulasMap - Map of measureName -> converted Beast Mode formula
 * @returns {string} The substituted formula text
 */
export function substituteDependencies(expression, convertedFormulasMap) {
  if (!expression) return '';
  const bracketRegex = /\[([^\]]+)\]/g;

  return expression.replace(bracketRegex, (match, token) => {
    const name = token.trim();
    if (convertedFormulasMap.has(name)) {
      const formula = convertedFormulasMap.get(name);
      return `(${formula})`;
    }
    return match; // Keep unchanged if not in map (genuine column reference)
  });
}


// ─── Formula Sanitization ──────────────────────────────────────────────────────

/**
 * Sanitizes a Beast Mode formula before sending to the Domo API.
 * Removes DAX comments, collapses whitespace, replaces leaked DAX `&`
 * concatenation operators, and normalises double-quoted string literals
 * to single quotes.
 *
 * @param {string} formula - The Beast Mode formula to sanitize
 * @returns {string} The sanitized formula
 */
export function sanitizeBeastModeFormula(formula) {
  if (!formula || typeof formula !== 'string') return formula;
  let f = formula;
  // Remove DAX line comments
  f = f.replace(/--[^\n]*/g, ' ');
  // Remove DAX block comments
  f = f.replace(/\/\*[\s\S]*?\*\//g, ' ');
  // Collapse newlines and extra spaces
  f = f.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  // Replace double-quoted string literals with single quotes
  f = f.replace(/"([^"]*)"/g, "'$1'");
  // Remove DAX & concatenation operator that leaked through
  f = f.replace(/'\s*&\s*'/g, "', '");
  return f;
}

