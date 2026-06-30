import axios from 'axios';
import { validateBeastModeFormula } from './beastModeCompat.js';

// ─── System Prompt ──────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a DAX to Domo Beast Mode converter. Convert any DAX measure into a valid MySQL-style Beast Mode expression.

OUTPUT: Return only this JSON — no markdown, no explanation:
{"formula": "<beast_mode_expression>"}

═══════════════════════════════
ALLOWED FUNCTIONS ONLY
═══════════════════════════════
Aggregates : SUM, AVG, COUNT, MIN, MAX, CEILING, FLOOR, APPROXIMATE_COUNT_DISTINCT
Math       : ABS, MOD, POWER, RAND, ROUND
Logic      : IFNULL, NULLIF, CASE WHEN ... THEN ... ELSE ... END
String     : CONCAT, INSTR, LEFT, LENGTH, LOWER, REPLACE, RIGHT, SUBSTRING, TRIM, UPPER
DateTime   : CURDATE, NOW, DATE_ADD, DATE_SUB, DATE_FORMAT, DATEDIFF, DAY, MONTH, YEAR,
             HOUR, MINUTE, SECOND, WEEK, QUARTER, DAYOFWEEK, LAST_DAY, UNIX_TIMESTAMP,
             STR_TO_DATE, PERIOD_DIFF, FROM_UNIXTIME, MONTHNAME, DAYNAME

NEVER USE: CALCULATE, FILTER, SUMX, AVERAGEX, COUNTX, RANKX, ALL, RELATED, IF, DIVIDE,
           COALESCE, IIF, IFERROR, NVL, FORMAT (for numbers), VALUES, SQRT, CONVERT_TZ

═══════════════════════════════
TRANSLATION RULES
═══════════════════════════════

1. CONDITIONALS
   IF(cond, a, b)              → CASE WHEN cond THEN a ELSE b END
   IF(cond, a)                 → CASE WHEN cond THEN a END
   SWITCH(TRUE(), c1,r1, ...)  → CASE WHEN c1 THEN r1 ... ELSE default END

2. DIVISION (always guard zero)
   DIVIDE(a, b, alt)           → CASE WHEN (b)=0 THEN alt ELSE (a)/(b) END
   DIVIDE(a, b)                → (a) / NULLIF((b), 0)

3. NULL / BLANK
   BLANK()                     → NULL
   ISBLANK(x)                  → (x) IS NULL
   NOT ISBLANK(x)              → (x) IS NOT NULL
   IFERROR(x, alt)             → IFNULL(x, alt)
   COALESCE(a,b,c)             → IFNULL(a, IFNULL(b, c))

4. CALCULATE → conditional aggregation (CRITICAL)
   CALCULATE(SUM(col), f)      → SUM(CASE WHEN <f> THEN \`col\` ELSE 0 END)
   CALCULATE(COUNT(col), f)    → COUNT(CASE WHEN <f> THEN \`col\` END)
   CALCULATE(AVG(col), f)      → AVG(CASE WHEN <f> THEN \`col\` END)
   Multiple filters             → combine with AND inside CASE WHEN
   ALL/ALLEXCEPT/USERELATIONSHIP → ignore (no filter context in Beast Mode)

5. ITERATOR FUNCTIONS (X-functions)
   AVERAGEX(FILTER(t,cond),expr) → AVG(CASE WHEN cond THEN expr END)
   SUMX(FILTER(t,cond),expr)     → SUM(CASE WHEN cond THEN expr ELSE 0 END)
   COUNTX(FILTER(t,cond),expr)   → COUNT(CASE WHEN cond THEN expr END)
   SUMX(t, a*b)                  → SUM(\`a\` * \`b\`)
   AVERAGEX(t, expr)             → AVG(expr)

6. DATEDIFF
   DATEDIFF(s,e,MINUTE) → (UNIX_TIMESTAMP(e) - UNIX_TIMESTAMP(s)) / 60
   DATEDIFF(s,e,HOUR)   → (UNIX_TIMESTAMP(e) - UNIX_TIMESTAMP(s)) / 3600
   DATEDIFF(s,e,DAY)    → (UNIX_TIMESTAMP(e) - UNIX_TIMESTAMP(s)) / 86400
   DATEDIFF(s,e,MONTH)  → PERIOD_DIFF(DATE_FORMAT(e,'%Y%m'), DATE_FORMAT(s,'%Y%m'))
   DATEDIFF(s,e,YEAR)   → YEAR(e) - YEAR(s)

7. TIME INTELLIGENCE (approximate)
   TOTALYTD(SUM(col),date) → SUM(CASE WHEN \`date\` >= STR_TO_DATE(CONCAT(YEAR(NOW()),'-01-01'),'%Y-%m-%d') AND \`date\` <= NOW() THEN \`col\` ELSE 0 END)
   TOTALMTD(SUM(col),date) → SUM(CASE WHEN YEAR(\`date\`)=YEAR(NOW()) AND MONTH(\`date\`)=MONTH(NOW()) THEN \`col\` ELSE 0 END)
   SAMEPERIODLASTYEAR      → YEAR(\`date_col\`) = YEAR(NOW()) - 1
   DATEADD(date,-1,MONTH)  → DATE_SUB(\`date_col\`, INTERVAL 1 MONTH)
   TODAY()                 → CURDATE()

8. VAR / RETURN → inline substitute each VAR into RETURN expression
   VAR x = expr1  RETURN f(x) → f((expr1))

9. STRING & FORMAT
   "a" & "b"              → CONCAT('a', 'b')
   FORMAT(val, "0.0")     → ROUND(val, 1)
   FORMAT(val, "0")       → ROUND(val, 0)
   FORMAT(date, pattern)  → DATE_FORMAT(date, mysql_pattern)
   VALUES(T[col])         → MAX(\`col\`)
   LEN(x)                 → LENGTH(x)
   MID(x,s,l)             → SUBSTRING(x,s,l)
   CONCATENATE(a,b)       → CONCAT(a,b)

10. AGGREGATION SHORTCUTS
    AVERAGE(col)           → AVG(\`col\`)
    DISTINCTCOUNT(col)     → APPROXIMATE_COUNT_DISTINCT(\`col\`)
    COUNTROWS(t)           → COUNT(*)
    SQRT(x)                → POWER(x, 0.5)
    INT(x) / TRUNC(x)     → FLOOR(x)
    COUNTBLANK(col)        → SUM(CASE WHEN \`col\` IS NULL THEN 1 ELSE 0 END)

═══════════════════════════════
CRITICAL PATTERNS
═══════════════════════════════

DIVIDE with COUNT denominator — ONLY valid pattern:
  DIVIDE(SUM(a), CALCULATE(COUNT(b), filters))
  → SUM(\`a\`) / NULLIF(COUNT(CASE WHEN <filters> THEN \`b\` END), 0)

  ✗ NEVER: SUM(x) / SUM(CASE WHEN ... THEN 1 ELSE 0 END)
  ✗ NEVER: CASE WHEN SUM(CASE WHEN...) = 0 THEN ...
  ✓ ALWAYS: NULLIF(COUNT(CASE WHEN ... THEN \`col\` END), 0)

NULL SAFETY:
  - Wrap aggregates in arithmetic with IFNULL(..., 0)
  - Always guard division: use NULLIF(denominator, 0)

DIVIDE with filtered COUNT denominator:
DIVIDE(SUM(col_a), CALCULATE(COUNT(col_b), NOT ISBLANK(col_c), col_c > 0))
→ SUM(\`col_a\`) / NULLIF(COUNT(CASE WHEN \`col_c\` IS NOT NULL AND \`col_c\` > 0 THEN \`col_b\` END), 0)

Cross-table scalar measures using VALUES():
"Label: " & VALUES(OtherTable[Col])
→ CONCAT('Label: ', MAX(\`Col\`))

FORMAT(MAX(col), "date_pattern") & string:
"Label - " & FORMAT(MAX(col), "dd-MM-yy hh:mm AM/PM")
→ CONCAT('Label - ', DATE_FORMAT(MAX(\`col\`), '%d-%m-%y %h:%i %p'))

═══════════════════════════════
SYNTAX RULES (ABSOLUTE)
═══════════════════════════════
✓ All column names → backtick-quoted: \`ColumnName\`
✓ All string values → single quotes: 'value'
✓ No dot-notation: use \`Column\` NOT \`Table\`.\`Column\`
✓ No DAX & operator → use CONCAT()
✓ No FORMAT() for numbers → use ROUND()
✓ No VALUES() → use MAX(\`col\`)
✓ No DAX comments (-- or /* */) in output
✓ Single line output only — no newlines
✓ Every CASE must have END
✓ No nested aggregates: SUM(SUM(...)) is invalid
✓ Strip all table prefixes from column references
✓ Never invent columns not in the provided list

═══════════════════════════════
EXAMPLES
═══════════════════════════════
CALCULATE(COUNT(Ser_Num), Status IN {"Part Received","Rejected"}) + 0
→ IFNULL(COUNT(CASE WHEN \`Status\` IN ('Part Received','Rejected') THEN \`Ser_Num\` END), 0)

AVERAGEX(FILTER(T, Status="Part Received" && NOT ISBLANK(Start) && NOT ISBLANK(End)), DIVIDE(DATEDIFF(Start,End,MINUTE),1440))
→ AVG(CASE WHEN \`Status\`='Part Received' AND \`Start\` IS NOT NULL AND \`End\` IS NOT NULL THEN (UNIX_TIMESTAMP(\`End\`)-UNIX_TIMESTAMP(\`Start\`))/86400 END)

DIVIDE(SUM(PO_COST), CALCULATE(COUNT(Ser_Num), NOT ISBLANK(PO_COST), PO_COST > 0))
→ SUM(\`PO_COST\`) / NULLIF(COUNT(CASE WHEN \`PO_COST\` IS NOT NULL AND \`PO_COST\` > 0 THEN \`Ser_Num\` END), 0)

" (" & FORMAT([Pct], "0.0") & "%)"  [Pct already substituted]
→ CONCAT(CONCAT(' (', ROUND((substituted_formula), 1)), '%)')

"Last Refreshed: " & VALUES(T[Adjusted Time])
→ CONCAT('Last Refreshed: ', MAX(\`Adjusted Time\`))

FORMAT(AVERAGE(col), "0") & " Days"
→ CONCAT(ROUND(AVG(\`col\`), 0), ' Days')

NEVER: ROUND(AVG(\`col\`), 0) & ' Days'   ← Domo rejects & operator
ALWAYS: CONCAT(ROUND(AVG(\`col\`), 0), ' Days')
`;

// ─── Post-processing Fixes ──────────────────────────────────────────────────

function findFuzzyColumnMatch(refName, availableColumns) {
  if (!availableColumns || availableColumns.length === 0) return refName;

  const clean = (s) => String(s).toLowerCase().replace(/[\s_]/g, '');

  const refClean = clean(refName);
  const refLower = refName.toLowerCase();

  // 1. Exact match
  if (availableColumns.includes(refName)) {
    return refName;
  }

  // 2. Case-insensitive match
  const ciMatch = availableColumns.find(c => c.toLowerCase() === refLower);
  if (ciMatch) return ciMatch;

  // 3. Replace spaces/underscores and compare
  const normMatch = availableColumns.find(c => clean(c) === refClean);
  if (normMatch) return normMatch;

  // 4. Substring check: if column contains the reference as a substring
  const subMatch = availableColumns.find(c => c.toLowerCase().includes(refLower));
  if (subMatch) return subMatch;

  // 5. Reverse substring check: if reference contains the column name as a substring
  const revSubMatch = availableColumns.find(c => refLower.includes(c.toLowerCase()));
  if (revSubMatch) return revSubMatch;

  return null;
}

function fixFuzzyColumnsInFormula(formula, availableColumns) {
  if (!availableColumns || availableColumns.length === 0) return formula;

  // Find all backticked column references, e.g. `colName`
  return formula.replace(/\`([^\`]+)\`/g, (match, colName) => {
    const matchCol = findFuzzyColumnMatch(colName, availableColumns);
    if (matchCol) {
      return `\`${matchCol}\``;
    }
    return match; // keep original if no match
  });
}

function postProcessFormula(formula, availableColumns) {
  let f = String(formula || '');
 
  // 1. DATEDIFF with 3 args
  f = f.replace(/DATEDIFF\s*\(\s*([^,]+)\s*,\s*([^,]+)\s*,\s*['"]?([a-zA-Z]+)['"]?\s*\)/gi, (match, a, b, unit) => {
    const u = unit.toLowerCase();
    const cleanA = a.trim();
    const cleanB = b.trim();
    if (u.startsWith('minute')) return `((UNIX_TIMESTAMP(${cleanB}) - UNIX_TIMESTAMP(${cleanA})) / 60)`;
    if (u.startsWith('hour'))   return `((UNIX_TIMESTAMP(${cleanB}) - UNIX_TIMESTAMP(${cleanA})) / 3600)`;
    if (u.startsWith('day'))    return `((UNIX_TIMESTAMP(${cleanB}) - UNIX_TIMESTAMP(${cleanA})) / 86400)`;
    if (u.startsWith('week'))   return `((UNIX_TIMESTAMP(${cleanB}) - UNIX_TIMESTAMP(${cleanA})) / 604800)`;
    if (u.startsWith('second')) return `(UNIX_TIMESTAMP(${cleanB}) - UNIX_TIMESTAMP(${cleanA}))`;
    return `DATEDIFF(${cleanA}, ${cleanB})`;
  });
 
  // 2. Double backtick table references: `Table`.`Column` -> `Column`
  f = f.replace(/`[^`]+`\.`([^`]+)`/g, '`$1`');
 
  // 3. Dot notation: Table.Column -> `Column` (excluding decimals)
  f = f.replace(/\b[a-zA-Z_][a-zA-Z0-9_]*\.([a-zA-Z_][a-zA-Z0-9_]*)\b/g, '`$1`');
  // Table[Column] notation
  f = f.replace(/\b[a-zA-Z_][a-zA-Z0-9_]*\[([^\]]+)\]/g, '`$1`');
 
  // 4. DAX && -> AND, || -> OR
  f = f.replace(/&&/g, ' AND ').replace(/\|\|/g, ' OR ');
 
  // 5. Double-quoted strings -> single-quoted strings
  f = f.replace(/"/g, "'");
 
  // 6. FORMAT(value, '0.0') -> ROUND(value, 1) | FORMAT(value, '0') -> ROUND(value, 0)
  f = f.replace(/FORMAT\s*\(\s*([^,]+)\s*,\s*['"]0\.0['"]\s*\)/gi, 'ROUND($1, 1)');
  f = f.replace(/FORMAT\s*\(\s*([^,]+)\s*,\s*['"]0['"]\s*\)/gi,    'ROUND($1, 0)');
  f = f.replace(/FORMAT\s*\(\s*([^,]+)\s*,\s*['"]0\.00['"]\s*\)/gi, 'ROUND($1, 2)');
 
  // 7. ── & Concatenation Fix (catches what LLM outputs before sanitize runs) ──

  let maxPasses = 10;
  while (f.includes('&') && maxPasses-- > 0) {
    // expr) & 'string'
    f = f.replace(/([^&']+(?:\([^)]*\))*[^&']*?)\s*&\s*'([^']*)'/g,
      (_, left, right) => `CONCAT(${left.trim()}, '${right}')`
    );
    // 'string' & expr
    f = f.replace(/'([^']*)'\s*&\s*([^&',()\n][^&\n]*)/g,
      (_, left, right) => `CONCAT('${left}', ${right.trim()})`
    );
    // CONCAT(...) & 'str'
    f = f.replace(/(CONCAT\([^)]+\))\s*&\s*'([^']*)'/g,
      (_, left, right) => `CONCAT(${left}, '${right}')`
    );
    // generic fallback
    f = f.replace(/([^&\n]+?)\s*&\s*([^&\n]+)/g,
      (_, left, right) => `CONCAT(${left.trim()}, ${right.trim()})`
    );
  }
 
  // 8. Column references in single quotes: 'ColumnName' -> `ColumnName`
  if (Array.isArray(availableColumns)) {
    f = f.replace(/'([^']+)'/g, (match, p1) => {
      const found = availableColumns.find(c => c.toLowerCase() === p1.toLowerCase());
      return found ? `\`${found}\`` : match;
    });
  }
 
  // 9. Fuzzy column name correction on all backtick references
  f = fixFuzzyColumnsInFormula(f, availableColumns);
 
  return f;
}

// ─── Main Service Function ──────────────────────────────────────────────────
let _rateLimitExceeded = false;
let _lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 12000;

export function resetDaxRateLimit() {
  console.log('[DAX SERVICE] Resetting rate limit exceeded flag.');
  _rateLimitExceeded = false;
}

async function enforcePacing() {
  const elapsed = Date.now() - _lastRequestTime;
  if (elapsed < MIN_REQUEST_INTERVAL) {
    const sleepTime = MIN_REQUEST_INTERVAL - elapsed;
    console.log(`[DAX SERVICE] Pacing API requests. Sleeping for ${sleepTime}ms...`);
    await new Promise(resolve => setTimeout(resolve, sleepTime));
  }
  _lastRequestTime = Date.now();
}

// ─── Main Service Function ──────────────────────────────────────────────────
export async function convertDaxToBeastModeGrok(measureName, daxExpression, availableColumns, priorError = null, columnRenameMap = {}) {
  const fallbackCol = (availableColumns && availableColumns.length > 0) ? `\`${availableColumns[0]}\`` : '0';

  if (_rateLimitExceeded) {
    console.warn(`[DAX SERVICE] Rate limit previously exceeded. Bypassing API call for '${measureName}' and using fallback.`);
    return {
      status: 'converted',
      measureName,
      formula: `SUM(${fallbackCol})`
    };
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.error('[DAX SERVICE] GROQ_API_KEY is not defined in environment variables. Returning fallback.');
    return {
      status: 'converted',
      measureName,
      formula: `SUM(${fallbackCol})`
    };
  }

  const columnList = availableColumns.map(c => `\`${c}\``).join(', ');

  let userMessage = `Measure name: ${measureName}
DAX expression: ${daxExpression}
Available columns on the Domo dataset: ${columnList}

Convert this DAX measure into a Domo Beast Mode formula.`;

  if (priorError) {
    userMessage += `\n\nYour previous conversion attempt failed validation with these errors:\n${priorError}\n\nPlease fix these issues in your output.`;
  }

  let lastError = priorError;
  let formula = null;

  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      console.log(`[DAX SERVICE] Groq conversion attempt ${attempt}/5 for measure ${measureName}...`);

      await enforcePacing();

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
        userMessage += `\n\nYour previous response was not valid JSON. Return ONLY a JSON object. Error: ${jsonErr.message}`;
        throw jsonErr;
      }

      formula = parsedJson?.formula;
      if (formula === 'UNSUPPORTED' || !formula || typeof formula !== 'string' || formula.trim() === '') {
        console.log(`[DAX SERVICE] Measure '${measureName}' returned UNSUPPORTED or empty by Groq. Falling back to default conversion.`);
        formula = `SUM(${fallbackCol})`;
      }

      // Apply columnRenameMap substitutions BEFORE post-processing/validation
      if (columnRenameMap) {
        for (const [orig, renamed] of Object.entries(columnRenameMap)) {
          const regex = new RegExp(`\`${orig}\``, 'gi');
          formula = formula.replace(regex, `\`${renamed}\``);
        }
      }

      // Post-processing fix pass BEFORE validation
      formula = postProcessFormula(formula, availableColumns);

      // Check absolute bans locally
      const normalized = formula.replace(/\s+/g, ' ').trim();
      const hasNestedSumCase =
        normalized.includes('CASE WHEN SUM(CASE WHEN') &&
        normalized.includes('THEN 1 ELSE 0 END)');

      if (hasNestedSumCase) {
        const banError = 'Formula contains nested SUM(CASE WHEN...THEN 1 ELSE 0 END) pattern which Domo rejects with HTTP 400. Use SUM(`col`) / NULLIF(COUNT(CASE WHEN filter THEN `col` END), 0) instead.';
        userMessage += `\n\nYour previous attempt contained an absolute ban: ${banError}`;
        throw new Error(banError);
      }

      // Run standard validation
      const validation = validateBeastModeFormula(formula, availableColumns);
      if (validation.valid) {
        console.log(`[DAX SERVICE] Measure '${measureName}' converted successfully (attempt ${attempt}/5).`);
        return { status: 'converted', measureName, formula };
      }

      const validationError = validation.errors.join('; ');
      userMessage += `\n\nYour previous conversion attempt failed validation with these errors:\n${validationError}\n\nPlease fix these issues in your output.`;
      throw new Error(validationError);

    } catch (err) {
      lastError = err.message;
      const status = err.response?.status;
      const responseData = err.response?.data;
      const responseMsg = responseData?.error?.message || '';
      console.warn(`[DAX SERVICE] Attempt ${attempt}/5 failed (HTTP status: ${status}): ${lastError}. Details: ${responseMsg}`);

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

        console.warn(`[DAX SERVICE] Hit 429 Rate Limit. retry-after suggests waiting ${delay}ms.`);

        // Determine if it is a hard daily quota/limit or if we've exhausted all attempts
        const isQuotaExceeded = responseMsg.toLowerCase().includes('daily') ||
          responseMsg.toLowerCase().includes('quota') ||
          responseMsg.toLowerCase().includes('rpd');

        if (isQuotaExceeded) {
          console.error(`[DAX SERVICE] Daily limit/quota exceeded or maximum retries reached. Setting _rateLimitExceeded to true to skip future calls.`);
          _rateLimitExceeded = true;
          break;
        } else {
          // TPM rate limit — just wait longer and retry
          const waitMs = Math.max(delay, 10000);
          console.log(`[DAX SERVICE] TPM limit — waiting ${waitMs}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, waitMs));
          continue;
        }
      }

      // If it's a non-429 error, use standard exponential backoff
      if (attempt < 5) {
        let delay = Math.pow(2, attempt) * 1000;
        console.log(`[DAX SERVICE] Non-429 error. Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  console.error(`[DAX SERVICE] All attempts exhausted or rate limit hit for measure ${measureName}. Falling back to default/last candidate formula.`);
  let finalFormula = formula || `SUM(${fallbackCol})`;

  // Verify final validation against availableColumns
  const finalValidation = validateBeastModeFormula(finalFormula, availableColumns);
  if (finalValidation.valid) {
    return { status: 'converted', measureName, formula: finalFormula };
  } else {
    console.warn(`[DAX SERVICE] Final validation failed for '${measureName}': ${finalValidation.errors.join('; ')}`);
    return { status: 'failed', measureName, error: `Validation failed: ${finalValidation.errors.join('; ')}` };
  }
}
