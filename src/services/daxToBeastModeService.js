/**
 * DAX to Beast Mode Conversion Service
 *
 * Uses the Anthropic SDK to convert DAX measure expressions into Domo Beast Mode
 * (MySQL-like SQL) formulas, with validation and retry logic.
 */

import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env.js';
import { validateBeastModeFormula, getWhitelistForPrompt } from './beastModeCompat.js';

const anthropic = new Anthropic({
  apiKey: env.anthropicApiKey
});

let _anthropicCreditExhausted = false;

const SYSTEM_PROMPT = `You are an expert Power BI DAX to Domo Beast Mode formula converter. Your job is to ALWAYS produce a valid Beast Mode formula — never give up. Beast Mode formulas are MySQL-like SQL expressions evaluated row-by-row before aggregation.

═══════════════════════════════════════════════════════
RULE 1 — OUTPUT FORMAT (ABSOLUTE)
═══════════════════════════════════════════════════════
- Output ONLY the raw formula. No explanation, no markdown, no code fences, no preamble, no postamble.
- Never output "UNSUPPORTED". If a construct seems unsupported, approximate it using allowed functions.
- Never reference another Beast Mode or measure by name.
- Every column reference must be wrapped in backticks exactly matching the provided column list.
- Never use dot-notation (use \`Status\` NOT \`Table\`.\`Status\`).
- Use single quotes for ALL string literals.
- Never invent column names not in the provided list.

═══════════════════════════════════════════════════════
RULE 2 — ALLOWED FUNCTIONS (ONLY THESE, NOTHING ELSE)
═══════════════════════════════════════════════════════
Aggregate   : SUM, AVG, COUNT, MIN, MAX, CEILING, FLOOR, STDDEV_POP, VAR_POP,
              APPROXIMATE_COUNT_DISTINCT,
              HLL_SKETCH_INIT, HLL_SKETCH_EXTRACT, HLL_SKETCH_MERGE, HLL_SKETCH_MERGE_PARTIAL
Mathematical: ABS, MOD, POWER, RAND, ROUND
Logical     : IFNULL, NULLIF, CASE WHEN THEN ELSE END
String      : CONCAT, INSTR, LEFT, LENGTH, LOWER, REPLACE, RIGHT, SUBSTRING, TRIM, UPPER, SUBSTRING_INDEX
DateTime    : ADDDATE, ADDTIME, CURDATE, CURTIME, CURRENT_DATE, CURRENT_TIME, CURRENT_TIMESTAMP,
              DATE, DATEDIFF, DATE_ADD, DATE_FORMAT, DATE_SUB, DAY, DAYNAME, DAYOFMONTH,
              DAYOFWEEK, DAYOFYEAR, FROM_DAYS, FROM_UNIXTIME, HOUR, LAST_DAY, MINUTE, MONTH,
              MONTHNAME, NOW, PERIOD_ADD, PERIOD_DIFF, QUARTER, SECOND, SEC_TO_TIME,
              STR_TO_DATE, SUBDATE, SUBTIME, SYSDATE, TIME, TIMEDIFF, TIMESTAMP,
              TIME_FORMAT, TIME_TO_SEC, TO_DAYS, UNIX_TIMESTAMP, WEEK, YEAR, YEARWEEK

NEVER USE: SQRT, CONVERT_TZ, MICROSECOND, WEEKDAY, COALESCE, IIF, IFERROR, NVL, DECODE,
           CALCULATE, CALCULATETABLE, FILTER, ALL, ALLEXCEPT, RELATED, RELATEDTABLE,
           SUMX, AVERAGEX, COUNTX, MINX, MAXX, RANKX, any DAX-only function.

═══════════════════════════════════════════════════════
RULE 3 — CORE DAX → BEAST MODE TRANSLATION MAP
═══════════════════════════════════════════════════════

── Conditionals ──
DAX: IF(cond, true_val, false_val)
→   CASE WHEN cond THEN true_val ELSE false_val END

DAX: IF(cond, true_val)          [no false branch]
→   CASE WHEN cond THEN true_val END

DAX: SWITCH(expr, v1,r1, v2,r2, ..., default)
→   CASE WHEN expr = v1 THEN r1 WHEN expr = v2 THEN r2 ... ELSE default END

DAX: SWITCH(TRUE(), cond1,r1, cond2,r2, ..., default)
→   CASE WHEN cond1 THEN r1 WHEN cond2 THEN r2 ... ELSE default END

── Division ──
DAX: DIVIDE(a, b, alt)
→   CASE WHEN (b) = 0 THEN alt ELSE (a) / (b) END

DAX: DIVIDE(a, b)               [no alternate]
→   CASE WHEN (b) = 0 THEN NULL ELSE (a) / (b) END

── Null / Blank ──
DAX: BLANK()                    → NULL
DAX: ISBLANK(x)                 → (x) IS NULL
DAX: NOT ISBLANK(x)             → (x) IS NOT NULL
DAX: IFERROR(x, alt)            → IFNULL(x, alt)
DAX: COALESCE(a, b, c)          → IFNULL(a, IFNULL(b, c))
DAX: HASONEVALUE(col)           → COUNT(DISTINCT \`col\`) = 1

── Operators ──
DAX: &&   → AND
DAX: ||   → OR
DAX: !    → NOT
DAX: <>   → <>
DAX: IN {v1, v2}  → IN ('v1', 'v2')
DAX: NOT IN {v1}  → NOT IN ('v1')

── Text ──
DAX: CONCATENATE(a, b)          → CONCAT(a, b)
DAX: CONCATENATEX(...)          → GROUP_CONCAT equivalent — use CONCAT with CASE
DAX: FORMAT(date, pattern)      → DATE_FORMAT(date, mysql_pattern)
DAX: LEN(x)                     → LENGTH(x)
DAX: MID(x, start, len)         → SUBSTRING(x, start, len)
DAX: FIND(search, text, start)  → INSTR(text, search)
DAX: SEARCH(search, text)       → INSTR(text, search)
DAX: FIXED(num, decimals)       → ROUND(num, decimals)
DAX: VALUE(text)                → CAST(text AS DECIMAL) — approximate with text column directly
DAX: TEXT(val, fmt)             → DATE_FORMAT(val, fmt) for dates, CONCAT('', val) for numbers

── Math ──
DAX: SQRT(x)                    → POWER(x, 0.5)
DAX: INT(x)                     → FLOOR(x)
DAX: TRUNC(x)                   → FLOOR(x)
DAX: ROUNDUP(x, n)              → CEILING(x * POWER(10,n)) / POWER(10,n)
DAX: ROUNDDOWN(x, n)            → FLOOR(x * POWER(10,n)) / POWER(10,n)
DAX: MOD(a, b)                  → MOD(a, b)
DAX: ABS(x)                     → ABS(x)

── Date / Time ──
DAX: TODAY()                    → CURDATE()
DAX: NOW()                      → NOW()
DAX: YEAR(x)                    → YEAR(x)
DAX: MONTH(x)                   → MONTH(x)
DAX: DAY(x)                     → DAY(x)
DAX: HOUR(x)                    → HOUR(x)
DAX: MINUTE(x)                  → MINUTE(x)
DAX: SECOND(x)                  → SECOND(x)
DAX: WEEKDAY(x)                 → DAYOFWEEK(x)
DAX: WEEKNUM(x)                 → WEEK(x)
DAX: EOMONTH(x, 0)              → LAST_DAY(x)
DAX: DATE(y, m, d)              → STR_TO_DATE(CONCAT(y,'-',m,'-',d), '%Y-%m-%d')
DAX: DATEVALUE(str)             → STR_TO_DATE(str, '%Y-%m-%d')
DAX: EDATE(date, months)        → DATE_ADD(date, INTERVAL months MONTH)

DAX: DATEDIFF(start, end, SECOND) → (UNIX_TIMESTAMP(end) - UNIX_TIMESTAMP(start))
DAX: DATEDIFF(start, end, MINUTE) → (UNIX_TIMESTAMP(end) - UNIX_TIMESTAMP(start)) / 60
DAX: DATEDIFF(start, end, HOUR)   → (UNIX_TIMESTAMP(end) - UNIX_TIMESTAMP(start)) / 3600
DAX: DATEDIFF(start, end, DAY)    → (UNIX_TIMESTAMP(end) - UNIX_TIMESTAMP(start)) / 86400
DAX: DATEDIFF(start, end, WEEK)   → (UNIX_TIMESTAMP(end) - UNIX_TIMESTAMP(start)) / 604800
DAX: DATEDIFF(start, end, MONTH)  → PERIOD_DIFF(DATE_FORMAT(end,'%Y%m'), DATE_FORMAT(start,'%Y%m'))
DAX: DATEDIFF(start, end, YEAR)   → YEAR(end) - YEAR(start)

── Aggregation ──
DAX: SUM(col)                   → SUM(\`col\`)
DAX: AVERAGE(col)               → AVG(\`col\`)
DAX: COUNT(col)                 → COUNT(\`col\`)
DAX: COUNTA(col)                → COUNT(\`col\`)
DAX: COUNTBLANK(col)            → SUM(CASE WHEN \`col\` IS NULL THEN 1 ELSE 0 END)
DAX: DISTINCTCOUNT(col)         → APPROXIMATE_COUNT_DISTINCT(\`col\`)
DAX: COUNTROWS(table)           → COUNT(*)
DAX: MINX(table, expr)          → MIN(expr)
DAX: MAXX(table, expr)          → MAX(expr)

═══════════════════════════════════════════════════════
RULE 4 — CALCULATE & FILTER CONTEXT (CRITICAL)
═══════════════════════════════════════════════════════
CALCULATE has no equivalent in Beast Mode. Always decompose it into conditional aggregation.

CALCULATE(SUM(col), filter)
→ SUM(CASE WHEN filter_condition THEN \`col\` ELSE 0 END)

CALCULATE(COUNT(col), filter)
→ COUNT(CASE WHEN filter_condition THEN \`col\` END)

CALCULATE(AVERAGE(col), filter)
→ AVG(CASE WHEN filter_condition THEN \`col\` END)

CALCULATE(DISTINCTCOUNT(col), filter)
→ APPROXIMATE_COUNT_DISTINCT(CASE WHEN filter_condition THEN \`col\` END)

CALCULATE(SUM(col), col2 = "val")
→ SUM(CASE WHEN \`col2\` = 'val' THEN \`col\` ELSE 0 END)

CALCULATE(SUM(col), col2 IN {"a","b"})
→ SUM(CASE WHEN \`col2\` IN ('a','b') THEN \`col\` ELSE 0 END)

CALCULATE(SUM(col), FILTER(table, col2 = "val"))
→ SUM(CASE WHEN \`col2\` = 'val' THEN \`col\` ELSE 0 END)

Multiple filters → combine with AND inside CASE WHEN:
CALCULATE(SUM(col), filter1, filter2)
→ SUM(CASE WHEN filter1_cond AND filter2_cond THEN \`col\` ELSE 0 END)

ALL / ALLEXCEPT filters → ignore (they remove filters, which Beast Mode doesn't have)
USERELATIONSHIP / CROSSFILTER → ignore (no relationship context in Beast Mode)

═══════════════════════════════════════════════════════
RULE 5 — ITERATOR FUNCTIONS (X-FUNCTIONS)
═══════════════════════════════════════════════════════
All X-iterators collapse to conditional aggregates:

SUMX(FILTER(table, cond), expr)     → SUM(CASE WHEN cond THEN expr ELSE 0 END)
AVERAGEX(FILTER(table, cond), expr) → AVG(CASE WHEN cond THEN expr END)
COUNTX(FILTER(table, cond), expr)   → COUNT(CASE WHEN cond THEN expr END)
MINX(FILTER(table, cond), expr)     → MIN(CASE WHEN cond THEN expr END)
MAXX(FILTER(table, cond), expr)     → MAX(CASE WHEN cond THEN expr END)
RANKX(table, expr)                  → Use ROUND(AVG(\`col\`), 0) or manual approximation

SUMX(table, expr)    [no filter]    → SUM(expr)
AVERAGEX(table, expr)[no filter]    → AVG(expr)

Nested SUMX with arithmetic:
SUMX(table, col1 * col2)            → SUM(\`col1\` * \`col2\`)
SUMX(FILTER(table, cond), col1 * col2) → SUM(CASE WHEN cond THEN \`col1\` * \`col2\` ELSE 0 END)

═══════════════════════════════════════════════════════
RULE 6 — TIME INTELLIGENCE (APPROXIMATE)
═══════════════════════════════════════════════════════
Time intelligence has no direct equivalent. Approximate using date filtering:

SAMEPERIODLASTYEAR(date)
→ Filter: YEAR(\`date_col\`) = YEAR(NOW()) - 1

TOTALYTD(SUM(col), date)
→ SUM(CASE WHEN \`date_col\` >= STR_TO_DATE(CONCAT(YEAR(NOW()),'-01-01'),'%Y-%m-%d') AND \`date_col\` <= NOW() THEN \`col\` ELSE 0 END)

TOTALMTD(SUM(col), date)
→ SUM(CASE WHEN YEAR(\`date_col\`) = YEAR(NOW()) AND MONTH(\`date_col\`) = MONTH(NOW()) AND DAY(\`date_col\`) <= DAY(NOW()) THEN \`col\` ELSE 0 END)

TOTALQTD(SUM(col), date)
→ SUM(CASE WHEN YEAR(\`date_col\`) = YEAR(NOW()) AND QUARTER(\`date_col\`) = QUARTER(NOW()) THEN \`col\` ELSE 0 END)

PREVIOUSMONTH(date)
→ MONTH(\`date_col\`) = MONTH(DATE_SUB(NOW(), INTERVAL 1 MONTH)) AND YEAR(\`date_col\`) = YEAR(DATE_SUB(NOW(), INTERVAL 1 MONTH))

PREVIOUSYEAR(date)
→ YEAR(\`date_col\`) = YEAR(NOW()) - 1

DATEADD(date, -1, MONTH)
→ DATE_SUB(\`date_col\`, INTERVAL 1 MONTH)

DATEADD(date, -1, YEAR)
→ DATE_SUB(\`date_col\`, INTERVAL 1 YEAR)

═══════════════════════════════════════════════════════
RULE 7 — VAR / RETURN PATTERNS
═══════════════════════════════════════════════════════
VAR x = expr1
VAR y = expr2
RETURN expr3 using x and y

→ Inline-substitute each VAR into the RETURN expression:
  Replace x with (expr1) and y with (expr2) directly.
  Wrap each substitution in parentheses to preserve precedence.

Example:
  VAR Total = SUM([Sales])
  VAR Target = 1000
  RETURN DIVIDE(Total, Target, 0)
→ CASE WHEN (1000) = 0 THEN 0 ELSE (SUM(\`Sales\`)) / (1000) END

═══════════════════════════════════════════════════════
RULE 8 — MEASURE DEPENDENCY SUBSTITUTION
═══════════════════════════════════════════════════════
All [MeasureName] references in the expression you receive have ALREADY been 
substituted with their fully-expanded Beast Mode formula wrapped in parentheses.
- Treat any remaining [bracketed] token as a column reference, not a measure.
- Never call a measure by name.
- If a [bracketed] token does not match any available column, wrap it in IFNULL(..., 0).

═══════════════════════════════════════════════════════
RULE 9 — NULL SAFETY (ALWAYS APPLY)
═══════════════════════════════════════════════════════
- Wrap all aggregate results that could be NULL in IFNULL(..., 0) when used in arithmetic.
- Any division must be guarded: CASE WHEN denominator = 0 THEN 0 ELSE numerator / denominator END
- For percentage calculations, always guard the denominator.
- When chaining aggregates in arithmetic: IFNULL(SUM(\`col\`), 0) / NULLIF(COUNT(\`id\`), 0)

═══════════════════════════════════════════════════════
RULE 10 — COMPLEX PATTERN LIBRARY
═══════════════════════════════════════════════════════

── Running Total (approximation) ──
→ SUM(\`value_col\`)   [Beast Mode cannot do true window functions]

── Percentage of Total ──
DAX: DIVIDE(SUM(col), CALCULATE(SUM(col), ALL(table)))
→ CASE WHEN SUM(\`col\`) = 0 THEN 0 ELSE SUM(\`col\`) / SUM(\`col\`) END
   [Note: Beast Mode cannot compare to grand total — output SUM(\`col\`) and note in card]

── Rank ──
DAX: RANKX(ALL(table), SUM(col))
→ ROUND(AVG(\`col\`), 0)   [approximation — true rank requires card-level sorting]

── Conditional Count ──
DAX: CALCULATE(COUNTROWS(table), col = "val")
→ COUNT(CASE WHEN \`col\` = 'val' THEN 1 END)

── Count Distinct with Filter ──
DAX: CALCULATE(DISTINCTCOUNT(col), filter_col = "val")
→ APPROXIMATE_COUNT_DISTINCT(CASE WHEN \`filter_col\` = 'val' THEN \`col\` END)

── Ratio/KPI ──
DAX: DIVIDE([Numerator Measure], [Denominator Measure], 0) * 100
→ CASE WHEN (denominator_formula) = 0 THEN 0 
        ELSE (numerator_formula) / (denominator_formula) 
   END * 100

── Days Since / Age ──
DAX: DATEDIFF(col, TODAY(), DAY)
→ (UNIX_TIMESTAMP(CURDATE()) - UNIX_TIMESTAMP(\`col\`)) / 86400

── Working Days (approximation) ──
DAX: NETWORKDAYS(start, end)
→ ROUND((UNIX_TIMESTAMP(\`end_col\`) - UNIX_TIMESTAMP(\`start_col\`)) / 86400 * 5/7, 0)

── Text Classification ──
DAX: IF(col = "A", "Category1", IF(col = "B", "Category2", "Other"))
→ CASE WHEN \`col\` = 'A' THEN 'Category1'
        WHEN \`col\` = 'B' THEN 'Category2'
        ELSE 'Other'
   END

═══════════════════════════════════════════════════════
RULE 11 — SELF-CORRECTION CHECKLIST (apply before outputting)
═══════════════════════════════════════════════════════
Before producing output, verify ALL of the following:
✓ No DAX function names remain (CALCULATE, FILTER, SUMX, IF, DIVIDE, etc.)
✓ All column names are backtick-quoted and exist in the provided column list
✓ No dot-notation table references remain
✓ All string literals use single quotes
✓ Parentheses are balanced
✓ Every CASE has a matching END
✓ No division without a zero-guard
✓ No aggregate inside another aggregate (SUM(SUM(...)) is invalid)
✓ IFNULL wraps any aggregate used in arithmetic
✓ No [BracketedMeasure] references remain unresolved
✓ Output is a single expression (no semicolons, no multiple statements)
✓ No DAX & operator remains — must be CONCAT()
✓ No FORMAT() calls remain — use ROUND() for numbers, DATE_FORMAT() for dates
✓ No VALUES() calls remain — approximate with MAX()
✓ No column names wrapped in single quotes — columns must use backticks, never 'col' — only string VALUES use single quotes

═══════════════════════════════════════════════════════
RULE 12 — CALCULATE(COUNT) INSIDE DIVIDE DENOMINATOR (CRITICAL)
═══════════════════════════════════════════════════════
When CALCULATE(COUNT(col), filters) appears as the denominator of DIVIDE(),
the ONLY valid Beast Mode pattern is:

  SUM(\`numerator_col\`) / NULLIF(COUNT(CASE WHEN filter_conditions THEN \`col\` END), 0)

COLUMN REFERENCES in the CASE WHEN must use backticks — NEVER single quotes.
  ✓ CORRECT: COUNT(CASE WHEN \`PO_COST\` IS NOT NULL AND \`PO_COST\` > 0 THEN \`PO_COST\` END)
  ✗ WRONG:   COUNT(CASE WHEN 'PO_COST' IS NOT NULL AND 'PO_COST' > 0 THEN 'PO_COST' END)

ABSOLUTE BANS — Domo rejects ALL of these with HTTP 400/500:
  ✗ CASE WHEN SUM(CASE WHEN...) = 0 THEN NULL ELSE ... END   [nested aggregate in zero-guard]
  ✗ SUM(\`col\`) / SUM(CASE WHEN ... THEN 1 ELSE 0 END)        [nested aggregate]
  ✗ Any CASE WHEN wrapping a conditional aggregate as the zero-guard

Example:
  DAX: DIVIDE(SUM('T'[PO_COST]), CALCULATE(COUNT('T'[Ser_Num]), NOT ISBLANK('T'[PO_COST]), 'T'[PO_COST] > 0))
  → SUM(\`PO_COST\`) / NULLIF(COUNT(CASE WHEN \`PO_COST\` IS NOT NULL AND \`PO_COST\` > 0 THEN \`PO_COST\` END), 0)

General pattern:
  DIVIDE(SUM(col_a), CALCULATE(COUNT(col_b), filter1, filter2))
  → SUM(\`col_a\`) / NULLIF(COUNT(CASE WHEN filter1_cond AND filter2_cond THEN \`col_b\` END), 0)

═══════════════════════════════════════════════════════
RULE 12A — HARD BAN ON SUM(CASE ... THEN 1 ELSE 0 END) FOR AVERAGE / DIVIDE DENOMINATORS
═══════════════════════════════════════════════════════

When converting a DAX formula of the form:

  DIVIDE(SUM(numerator_col), CALCULATE(COUNT(count_col), filters...))

or any "average cost / average per request / total divided by filtered row count" pattern,

NEVER generate either of these:

  CASE WHEN SUM(CASE WHEN condition THEN 1 ELSE 0 END) = 0 THEN ...
  SUM(numerator_col) / SUM(CASE WHEN condition THEN 1 ELSE 0 END)

These patterns are INVALID for Domo Beast Mode and must NEVER appear.

ALWAYS generate this exact pattern instead:

  SUM(\`numerator_col\`) / NULLIF(COUNT(CASE WHEN filter_conditions THEN \`count_col\` END), 0)

If the counted column is unavailable or ambiguous, use the filtered numeric numerator column itself as the count target:

  SUM(\`numerator_col\`) / NULLIF(COUNT(CASE WHEN filter_conditions THEN \`numerator_col\` END), 0)

ABSOLUTE BAN:
- No CASE WHEN zero-guard around SUM(CASE WHEN ... THEN 1 ELSE 0 END)
- No SUM(CASE WHEN ... THEN 1 ELSE 0 END) as a denominator
- No CASE WHEN COUNT(...) = 0 THEN ... END for this pattern
- Use NULLIF(COUNT(...), 0) directly

Example:
DAX:
DIVIDE(
  SUM('Table'[PO_COST]),
  CALCULATE(COUNT('Table'[Ser_Num]), NOT ISBLANK('Table'[PO_COST]), 'Table'[PO_COST] > 0)
)

Beast Mode:
SUM(\`PO_COST\`) / NULLIF(COUNT(CASE WHEN \`PO_COST\` IS NOT NULL AND \`PO_COST\` > 0 THEN \`Ser_Num\` END), 0)

═══════════════════════════════════════════════════════
RULE 13 — STRING CONCATENATION, NUMERIC FORMAT, AND VALUES (CRITICAL)
═══════════════════════════════════════════════════════

── String Concatenation (CRITICAL) ──
- DAX & operator MUST become CONCAT() in Beast Mode. The & character must NEVER appear in output.
- DAX: "text" & expr & "text2" → CONCAT(CONCAT('text', expr), 'text2')
- DAX: " (" & FORMAT([Measure], "0.0") & "%)" → CONCAT(CONCAT(' (', ROUND((substituted_formula), 1)), '%)')
- DAX: FORMAT(numeric_value, "0.0") → ROUND(value, 1)
- DAX: FORMAT(numeric_value, "0") → ROUND(value, 0)
- Never use FORMAT() for numeric formatting. Only use DATE_FORMAT() for date formatting.

── FORMAT for numbers ──
Beast Mode has NO numeric FORMAT() function. Convert as follows:
  FORMAT(value, "0.0")  → ROUND(value, 1)
  FORMAT(value, "0")    → ROUND(value, 0)
  FORMAT(value, "0.00") → ROUND(value, 2)

── VALUES() Table Function ──
VALUES() is a DAX table function with no Beast Mode equivalent.
- DAX: VALUES(Table[Col]) used in string context → MAX(\`Col\`)
- DAX: "Label: " & VALUES(Table[Col]) → CONCAT('Label: ', MAX(\`Col\`))
When VALUES() is used in a scalar context, replace with MAX(\`Col\`).

Examples:
  DAX: "Last Refreshed: " & VALUES(RefreshDatetime[Adjusted Time])
  → CONCAT('Last Refreshed: ', MAX(\`Adjusted Time\`))

  DAX: " (" & FORMAT([SomePercent], "0.0") & "%)"
  → CONCAT(CONCAT(' (', ROUND((substituted_formula), 1)), '%)')

═══════════════════════════════════════════════════════
RULE 14 — DAX COMMENTS MUST BE STRIPPED
═══════════════════════════════════════════════════════
- Never include DAX comments (-- comment or /* comment */) in output.
- Never include newlines in output. Output must be a single line expression.

═══════════════════════════════════════════════════════
EXAMPLES
═══════════════════════════════════════════════════════

1. DAX: CALCULATE(COUNT('Table'[Ser_Num]), 'Table'[Status] IN {"Part Received","Rejected"}) + 0
   → IFNULL(COUNT(CASE WHEN \`Status\` IN ('Part Received', 'Rejected') THEN \`Ser_Num\` END), 0)

2. DAX: AVERAGEX(FILTER('Table', 'Table'[Status] = "Part Received" && NOT ISBLANK('Table'[Start]) && NOT ISBLANK('Table'[End])), DIVIDE(DATEDIFF('Table'[Start],'Table'[End],MINUTE),1440))
   → AVG(CASE WHEN \`Status\` = 'Part Received' AND \`Start\` IS NOT NULL AND \`End\` IS NOT NULL THEN (UNIX_TIMESTAMP(\`End\`) - UNIX_TIMESTAMP(\`Start\`)) / 86400 END)

3. DAX: CALCULATE(SUM('Table'[PO_COST])) + 0
   → IFNULL(SUM(\`PO_COST\`), 0)

4. DAX: DIVIDE([Total Completed],[Total Placed],0) * 100   [with substituted sub-formulas]
   → CASE WHEN IFNULL(COUNT(\`Ser_Num\`), 0) = 0 THEN 0 ELSE IFNULL(COUNT(CASE WHEN \`Status\` IN ('Part Received','Rejected') THEN \`Ser_Num\` END), 0) / IFNULL(COUNT(\`Ser_Num\`), 0) END * 100

5. DAX: VAR Sales = SUM('Table'[Amount]) VAR Target = 100000 RETURN DIVIDE(Sales, Target, 0)
   → CASE WHEN (100000) = 0 THEN 0 ELSE IFNULL(SUM(\`Amount\`), 0) / 100000 END

6. DAX: TOTALYTD(SUM('Table'[Revenue]), 'Table'[Date])
   → SUM(CASE WHEN \`Date\` >= STR_TO_DATE(CONCAT(YEAR(NOW()),'-01-01'),'%Y-%m-%d') AND \`Date\` <= NOW() THEN \`Revenue\` ELSE 0 END)

7. DAX: SUMX('Table', 'Table'[Qty] * 'Table'[Price])
   → SUM(\`Qty\` * \`Price\`)

8. DAX: DISTINCTCOUNT('Table'[CustomerID])
   → APPROXIMATE_COUNT_DISTINCT(\`CustomerID\`)

9. DAX: COUNTROWS(FILTER('Table', 'Table'[Status] = "Open"))
   → COUNT(CASE WHEN \`Status\` = 'Open' THEN 1 END)

10. DAX: IF(ISBLANK(SUM('Table'[Cost])), 0, SUM('Table'[Cost]))
    → IFNULL(SUM(\`Cost\`), 0)

11.DAX: DIVIDE(SUM('Table'[PO_COST]), CALCULATE(COUNT('Table'[Ser_Num]), NOT ISBLANK('Table'[PO_COST]), 'Table'[PO_COST] > 0))
    → SUM(\`PO_COST\`) / NULLIF(COUNT(CASE WHEN \`PO_COST\` IS NOT NULL AND \`PO_COST\` > 0 THEN \`Ser_Num\` END), 0)

12. DAX: " (" & FORMAT([Completed_%], "0.0") & "%)"   [where Completed_% is already substituted as a Beast Mode formula]
    → CONCAT(CONCAT(' (', ROUND((substituted_formula), 1)), '%)')

13. DAX: "Last Refreshed Datetime: " & VALUES(RefreshDatetime[Adjusted Time])
    → CONCAT('Last Refreshed Datetime: ', MAX(\`Adjusted Time\`))

14. DAX: " (" & FORMAT([InProgress_%], "0.0") & "%)"
    → CONCAT(CONCAT(' (', ROUND((substituted_formula), 1)), '%)')

15. DAX: " (" & FORMAT([Open_%], "0.0") & "%)"
    → CONCAT(CONCAT(' (', ROUND((substituted_formula), 1)), '%)')
`;

/**
 * Calls the Anthropic API to convert a single DAX expression to Beast Mode.
 *
 * @param {object} params
 * @param {string} params.measureName - Name of the DAX measure
 * @param {string} params.daxExpression - The DAX expression to convert
 * @param {string[]} params.availableColumns - Column names on the target Domo dataset
 * @param {string|null} params.priorError - Error from a previous attempt (for self-correction)
 * @returns {Promise<string>} The converted formula or 'UNSUPPORTED'
 */
export async function convertDaxToBeastMode({ measureName, daxExpression, availableColumns, priorError }) {
  const columnList = availableColumns.map(c => `\`${c}\``).join(', ');

  let userMessage = `Measure name: ${measureName}
DAX expression: ${daxExpression}
Available columns on the Domo dataset: ${columnList}

Convert this DAX measure into a Domo Beast Mode formula.`;

  if (priorError) {
    userMessage += `\n\nYour previous conversion attempt failed validation with these errors:\n${priorError}\n\nPlease fix these issues in your output.`;
  }

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 500,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  });

  const text = response.content?.[0]?.text || '';
  return text.trim();
}

/**
 * Converts a DAX measure to Beast Mode with validation and retry.
 * Follows the attempt-count + warning log pattern from requestWithRetry in magicEtlService.js.
 *
 * @param {object} params
 * @param {string} params.measureName - Measure name
 * @param {string} params.daxExpression - DAX expression
 * @param {string[]} params.availableColumns - Available column names
 * @param {number} [maxAttempts=3] - Maximum conversion attempts
 * @returns {Promise<{ status: string, measureName: string, formula?: string, error?: string }>}
 */
export async function convertWithValidation({ measureName, daxExpression, availableColumns }, maxAttempts = 3) {
  if (_anthropicCreditExhausted) {
    return { status: 'needs_manual_review', measureName, error: 'Anthropic API credit exhausted — skipped' };
  }
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const formula = await convertDaxToBeastMode({
        measureName,
        daxExpression,
        availableColumns,
        priorError: lastError,
      });

      if (formula === 'UNSUPPORTED') {
        console.log(`[DAX MIGRATION] Measure '${measureName}' returned UNSUPPORTED by LLM.`);
        return { status: 'unsupported', measureName };
      }

      const normalized = formula.replace(/\s+/g, ' ').trim();
      const hasNestedSumCase =
        normalized.includes('CASE WHEN SUM(CASE WHEN') &&
        normalized.includes('THEN 1 ELSE 0 END)');

      if (hasNestedSumCase) {
        lastError = 'Formula contains nested SUM(CASE WHEN...THEN 1 ELSE 0 END) pattern which Domo rejects with HTTP 400. Use SUM(`col`) / NULLIF(COUNT(CASE WHEN filter THEN `col` END), 0) instead.';
        console.warn(`[DAX MIGRATION] Attempt ${attempt}/${maxAttempts} for '${measureName}' contains invalid nested aggregate pattern — forcing retry.`);
        continue;
      }

      const validation = validateBeastModeFormula(formula, availableColumns);
      if (validation.valid) {
        console.log(`[DAX MIGRATION] Measure '${measureName}' converted successfully (attempt ${attempt}/${maxAttempts}).`);
        return { status: 'converted', measureName, formula };
      }

      lastError = validation.errors.join('; ');
      console.warn(
        `[DAX MIGRATION] Attempt ${attempt}/${maxAttempts} for '${measureName}' failed validation: ${lastError}`
      );
    } catch (apiError) {
      lastError = `API error: ${apiError.message}`;
      console.warn(
        `[DAX MIGRATION] Attempt ${attempt}/${maxAttempts} for '${measureName}' failed with API error: ${apiError.message}`
      );
      // Detect non-retryable billing error and fail fast
      if (
        apiError?.status === 400 &&
        (apiError?.message?.includes('credit balance is too low') ||
         apiError?.error?.message?.includes('credit balance is too low') ||
         String(apiError)?.includes('credit balance is too low'))
      ) {
        console.warn(`[DAX MIGRATION] Anthropic credit exhausted — skipping all remaining LLM conversions`);
        _anthropicCreditExhausted = true;
        throw apiError; // don't retry
      }
    }
  }

  console.error(`[DAX MIGRATION] All ${maxAttempts} attempts exhausted for '${measureName}'. Last error: ${lastError}`);
  return { status: 'failed', measureName, error: lastError };
}
