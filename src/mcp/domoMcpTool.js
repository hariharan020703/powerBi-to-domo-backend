import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import dotenv from 'dotenv';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });
if (!process.env.DOMO_CLIENT_DOMAIN) {
  dotenv.config({ path: path.join(__dirname, '../../.env') });
}

const CLIENT_DOMAIN = (process.env.DOMO_CLIENT_DOMAIN || '').trim();
const CLIENT_TOKEN = (process.env.DOMO_CLIENT_TOKEN || '').trim();
const AGENT_EMAIL = (process.env.DOMO_AGENT_EMAIL || '').toLowerCase().trim();
const TEAMS_WEBHOOK_URL = process.env.TEAMS_WEBHOOK_URL || '';

const SCRIPT_DIR = __dirname;
const AUDIT_DIR = path.join(SCRIPT_DIR, 'audit_log');

if (!fs.existsSync(AUDIT_DIR)) {
  fs.mkdirSync(AUDIT_DIR, { recursive: true });
}

const ROLE_HIERARCHY = ['viewer', 'analyst', 'editor', 'deployer', 'admin'];

const TOOL_ROLES = {
  check_token_health: 'viewer',
  list_datasets: 'viewer',
  search_dataset: 'viewer',
  inspect_schema: 'viewer',
  preview_data: 'analyst',
  create_card: 'deployer',
  list_dashboards: 'viewer',
  inspect_dashboard: 'viewer',
  read_card: 'viewer',
  notify_teams: 'viewer',
  test_teams_webhook: 'viewer',
  view_audit_log: 'admin',
  list_role_permissions: 'viewer',
  create_dataset: 'deployer',
  create_dashboard: 'deployer',
};

const _agentRole = (process.env.DOMO_AGENT_ROLE || 'analyst').toLowerCase().trim();

const AGENT_ROLES = {
  [AGENT_EMAIL]: ROLE_HIERARCHY.includes(_agentRole) ? _agentRole : 'analyst',
};

class AccessDeniedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AccessDeniedError';
  }
}

function checkAccess(email, tool) {
  const e = email.toLowerCase().trim();
  const role = AGENT_ROLES[e];
  const required = TOOL_ROLES[tool] || 'admin';
  if (role === undefined) {
    throw new AccessDeniedError(
      `[ACCESS DENIED] Unrecognised email: ${e}\n` +
      `   Contact the administrator to request access.`
    );
  }
  const userLevel = ROLE_HIERARCHY.includes(role) ? ROLE_HIERARCHY.indexOf(role) : -1;
  const reqLevel = ROLE_HIERARCHY.includes(required) ? ROLE_HIERARCHY.indexOf(required) : 99;
  if (userLevel < reqLevel) {
    throw new AccessDeniedError(
      `[ACCESS DENIED] ${e} has role '${role}' but '${tool}' requires '${required}'.`
    );
  }
}

function requireConfig() {
  if (!CLIENT_DOMAIN) {
    throw new Error('[CONFIG ERROR] DOMO_CLIENT_DOMAIN is not set.');
  }
  if (!CLIENT_TOKEN) {
    throw new Error('[CONFIG ERROR] DOMO_CLIENT_TOKEN is not set.');
  }
}

function getHeaders() {
  requireConfig();
  return {
    'Content-Type': 'application/json;charset=utf-8',
    Accept: 'application/json, text/plain, */*',
    'X-DOMO-DEVELOPER-TOKEN': CLIENT_TOKEN,
    'x-requested-with': 'XMLHttpRequest',
  };
}

function logOp(tool, status, options = {}) {
  const { dataset_id = '', etl_id = '', extra = null } = options;
  try {
    const record = {
      timestamp: new Date().toISOString().slice(0, 19).replace('T', ' '),
      operator: AGENT_EMAIL,
      instance: CLIENT_DOMAIN,
      tool,
      dataset_id,
      etl_id,
      status,
    };
    if (extra) {
      Object.assign(record, extra);
    }
    const dateStr = new Date().toISOString().slice(0, 10);
    const logFile = path.join(AUDIT_DIR, `audit_${dateStr}.jsonl`);
    fs.appendFileSync(logFile, JSON.stringify(record) + '\n', 'utf-8');
  } catch (_e) {
  }
}

function fmtTs(ms) {
  if (!ms) return '—';
  try {
    return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
  } catch (_e) {
    return String(ms);
  }
}

function formatDataset(ds) {
  return [
    `  Dataset ID : ${ds.id || '?'}`,
    `  Name       : ${ds.name || 'Unnamed'}`,
    `  Type       : ${ds.type || '?'}`,
    `  Rows       : ${ds.rowCount !== undefined ? ds.rowCount : '?'}`,
    `  Columns    : ${ds.columnCount !== undefined ? ds.columnCount : '?'}`,
    `  Owner      : ${(ds.owner || {}).displayName || 'Unknown'}`,
    `  Updated    : ${fmtTs(ds.lastUpdated)}`,
    `  URL        : https://${CLIENT_DOMAIN}/datasources/${ds.id || '?'}/details`,
  ].join('\n');
}

async function resolveDatasetId(query, headers = null) {
  const h = headers || getHeaders();
  const q = query.trim();
  if (/^[0-9a-f-]{8,}$/i.test(q)) {
    return q;
  }
  const resp = await axios.get(`https://${CLIENT_DOMAIN}/api/data/v3/datasources`, {
    headers: h,
    params: { nameLike: query, limit: 5 },
    timeout: 15000,
    validateStatus: () => true,
  });
  if (resp.status !== 200) return null;
  const data = resp.data;
  const sources = Array.isArray(data) ? data : data.dataSources || [];
  return sources.length ? sources[0].id : null;
}

async function sendTeams(payload) {
  if (!TEAMS_WEBHOOK_URL) return false;
  try {
    const resp = await axios.post(TEAMS_WEBHOOK_URL, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000,
      validateStatus: () => true,
    });
    return resp.status === 200 || resp.status === 202;
  } catch (_e) {
    return false;
  }
}

function teamsCard(title, status, rows, etlId = null) {
  const prefix = { OK: '[SUCCESS]', FAILED: '[FAILED]', WARN: '[WARNING]', INFO: '[INFO]' }[status] || '[INFO]';
  const lines = [`${prefix} ${title}`, ''];
  for (const [label, value] of rows) {
    lines.push(`${label}: ${value}`);
  }
  if (etlId) {
    lines.push('', `View: https://${CLIENT_DOMAIN}/datacenter/dataflows/${etlId}/details`);
  }
  return { text: lines.join('\n') };
}

const server = new McpServer({
  name: 'Domo MCP Tool',
  version: '1.0.0',
});

server.tool(
  'check_token_health',
  'Verify the access token is valid and show scope. Role required: viewer',
  {},
  async () => {
    try {
      checkAccess(AGENT_EMAIL, 'check_token_health');
      if (!CLIENT_DOMAIN) return text('[ERR] DOMO_CLIENT_DOMAIN is not set.');
      if (!CLIENT_TOKEN) return text('[ERR] DOMO_CLIENT_TOKEN is not set.');
      const headers = getHeaders();
      const lines = [
        'Token Health Check',
        '─'.repeat(60),
        `  Instance : ${CLIENT_DOMAIN}`,
        `  Operator : ${AGENT_EMAIL}`,
        `  Token    : ***${CLIENT_TOKEN.slice(-6)}`,
        '',
      ];
      const meResp = await axios.get(`https://${CLIENT_DOMAIN}/api/content/v2/users/me`, {
        headers,
        timeout: 15000,
        validateStatus: () => true,
      });
      if (meResp.status === 401) {
        lines.push('[FAIL] Token INVALID or EXPIRED (HTTP 401).');
        lines.push(`   Regenerate at: https://${CLIENT_DOMAIN}/admin/security/accesstokens`);
        return text(lines.join('\n'));
      }
      if (meResp.status !== 200) {
        lines.push(`[FAIL] Unexpected response: HTTP ${meResp.status}`);
        return text(lines.join('\n'));
      }
      const me = meResp.data;
      lines.push('[OK] Token VALID');
      lines.push(`  Authenticated as : ${me.displayName || me.name || 'Unknown'}`);
      lines.push(`  Domo Role ID     : ${me.roleId || me.role || 'Unknown'}`);
      lines.push('');
      const dsResp = await axios.get(`https://${CLIENT_DOMAIN}/api/data/v3/datasources`, {
        headers,
        params: { limit: 1 },
        timeout: 15000,
        validateStatus: () => true,
      });
      lines.push('SCOPE CHECK');
      lines.push(
        dsResp.status === 200
          ? '  [OK] Data API — dataset read confirmed'
          : `  [WARN] Data API — HTTP ${dsResp.status}`
      );
      logOp('check_token_health', 'OK', { extra: { user: me.displayName || '' } });
      return text(lines.join('\n'));
    } catch (e) {
      if (e instanceof AccessDeniedError) return text(e.message);
      if (e.code === 'ECONNREFUSED' || e.code === 'ENOTFOUND') {
        return text(`[ERR] Cannot reach ${CLIENT_DOMAIN}. Check DOMO_CLIENT_DOMAIN and network.`);
      }
      return text(`[ERR] ${e.message}`);
    }
  }
);

server.tool(
  'list_datasets',
  'List datasets in the Domo instance. Role required: viewer',
  {
    limit: z.number().int().optional().default(50).describe('Number to return (default 50, max 500)'),
    offset: z.number().int().optional().default(0).describe('Pagination offset'),
    sort: z.string().optional().default('lastUpdated').describe('lastUpdated | name | rowCount'),
  },
  async ({ limit = 50, offset = 0, sort = 'lastUpdated' }) => {
    try {
      checkAccess(AGENT_EMAIL, 'list_datasets');
      const resp = await axios.get(`https://${CLIENT_DOMAIN}/api/data/v3/datasources`, {
        headers: getHeaders(),
        params: { limit: Math.min(limit, 500), offset, sort, order: 'desc' },
        timeout: 30000,
        validateStatus: () => true,
      });
      if (resp.status !== 200) return text(`[ERR] HTTP ${resp.status}`);
      const data = resp.data;
      const datasets = Array.isArray(data) ? data : data.dataSources || [];
      if (!datasets.length) return text('No datasets found.');
      const lines = [
        `Instance : ${CLIENT_DOMAIN}`,
        `Returned : ${datasets.length} (offset ${offset})`,
        '─'.repeat(60),
        '',
      ];
      for (const ds of datasets) {
        lines.push(`  [${ds.id || '?'}]  ${ds.name || 'Unnamed'}`);
        lines.push(
          `       Rows: ${ds.rowCount !== undefined ? ds.rowCount : '?'} | ` +
          `Cols: ${ds.columnCount !== undefined ? ds.columnCount : '?'} | ` +
          `Owner: ${(ds.owner || {}).displayName || 'Unknown'} | ` +
          `Updated: ${fmtTs(ds.lastUpdated)}`
        );
      }
      logOp('list_datasets', 'OK', { extra: { returned: datasets.length } });
      return text(lines.join('\n'));
    } catch (e) {
      if (e instanceof AccessDeniedError) return text(e.message);
      return text(`[ERR] ${e.message}`);
    }
  }
);

server.tool(
  'search_dataset',
  'Find a dataset by name (partial match) or exact dataset ID. Role required: viewer',
  {
    query: z.string().describe('Dataset name or UUID'),
  },
  async ({ query }) => {
    try {
      checkAccess(AGENT_EMAIL, 'search_dataset');
      const headers = getHeaders();
      const q = query.trim();
      if (/^[0-9a-f-]{8,}$/i.test(q) || /^\d+$/.test(q)) {
        const resp = await axios.get(`https://${CLIENT_DOMAIN}/api/data/v3/datasources/${q}`, {
          headers,
          timeout: 30000,
          validateStatus: () => true,
        });
        if (resp.status === 200) {
          logOp('search_dataset', 'OK', { dataset_id: q });
          return text(formatDataset(resp.data));
        }
        return text(`[ERR] Dataset '${query}' not found: HTTP ${resp.status}`);
      }
      const resp = await axios.get(`https://${CLIENT_DOMAIN}/api/data/v3/datasources`, {
        headers,
        params: { nameLike: query, limit: 50 },
        timeout: 30000,
        validateStatus: () => true,
      });
      if (resp.status !== 200) return text(`[ERR] Search failed: HTTP ${resp.status}`);
      const data = resp.data;
      const datasets = Array.isArray(data) ? data : data.dataSources || [];
      const matches = datasets.filter((d) => (d.name || '').toLowerCase().includes(query.toLowerCase()));
      if (!matches.length) return text(`No datasets found matching '${query}'.`);
      const lines = [`Found ${matches.length} match(es) for '${query}':`, ''];
      for (const ds of matches) {
        lines.push(formatDataset(ds));
        lines.push('');
      }
      logOp('search_dataset', 'OK', { extra: { query, matches: matches.length } });
      return text(lines.join('\n'));
    } catch (e) {
      if (e instanceof AccessDeniedError) return text(e.message);
      return text(`[ERR] ${e.message}`);
    }
  }
);

server.tool(
  'inspect_schema',
  'Return the full column schema of a dataset with real column types. Role required: viewer',
  {
    dataset_id: z.string().describe('Dataset UUID or name'),
  },
  async ({ dataset_id }) => {
    try {
      checkAccess(AGENT_EMAIL, 'inspect_schema');
      const headers = getHeaders();
      const datasetId = (await resolveDatasetId(dataset_id, headers)) || dataset_id;
      const resp = await axios.get(`https://${CLIENT_DOMAIN}/api/data/v3/datasources/${datasetId}`, {
        headers,
        timeout: 30000,
        validateStatus: () => true,
      });
      if (resp.status !== 200) return text(`[ERR] Dataset not found: HTTP ${resp.status}`);
      const ds = resp.data;
      console.log(
        'DATASET METADATA',
        JSON.stringify(ds, null, 2)
      );
      const name = ds.name || 'Unnamed';
      let columns = (ds.schema || {}).columns || [];
      let source = 'metadata API';

      if (!columns.length) {
        const sr = await axios.get(
          `https://${CLIENT_DOMAIN}/api/data/v2/datasources/${datasetId}/schemas/latest`,
          { headers, timeout: 30000, validateStatus: () => true }
        );
        if (sr.status === 200) {
          const schemaWrap = sr.data.schema || {};
          columns = schemaWrap.columns || [];
          if (columns.length) source = 'v2 schemas/latest API';
        }
      }

      if (!columns.length) {
        try {
          const qr = await axios.post(
            `https://${CLIENT_DOMAIN}/api/query/v1/execute/${datasetId}`,
            { sql: 'SELECT * FROM table LIMIT 1' },
            { headers, timeout: 60000, validateStatus: () => true }
          );
          if (qr.status === 200) {
            columns = (qr.data.columns || []).map((c) => ({ name: c, type: 'UNKNOWN' }));
            source = 'SQL fallback  [CREDIT CONSUMED]';
          }
        } catch (_e) {
          // ignore
        }
      }

      const rowCount = ds.rowCount;
      const lines = [
        `Schema: ${name}`,
        '─'.repeat(60),
        `  Dataset ID : ${datasetId}`,
        `  Row count  : ${typeof rowCount === 'number' ? rowCount.toLocaleString() : rowCount !== undefined ? rowCount : '?'}`,
        `  Columns    : ${columns.length}`,
        `  Source     : ${source}`,
        '',
      ];
      if (!columns.length) {
        lines.push('  [ERR] Could not retrieve schema via any method.');
      } else {
        lines.push(`  ${'#'.padEnd(4)}  ${'Column Name'.padEnd(35)}  ${'Type'.padEnd(15)}`);
        lines.push(`  ${'─'.repeat(4)}  ${'─'.repeat(35)}  ${'─'.repeat(15)}`);
        columns.forEach((col, i) => {
          lines.push(`  ${String(i + 1).padEnd(4)}  ${(col.name || '?').padEnd(35)}  ${(col.type || '?').padEnd(15)}`);
        });
      }
      logOp('inspect_schema', 'OK', { dataset_id: datasetId, extra: { columns: columns.length, source } });
      return text(lines.join('\n'));
    } catch (e) {
      if (e instanceof AccessDeniedError) return text(e.message);
      return text(`[ERR] ${e.message}`);
    }
  }
);

server.tool(
  'preview_data',
  'Preview the first 20 rows of a dataset. Role required: analyst',
  {
    dataset_id: z.string().describe('Dataset UUID or name'),
  },
  async ({ dataset_id }) => {
    try {
      checkAccess(AGENT_EMAIL, 'preview_data');
      const headers = getHeaders();
      const datasetId = (await resolveDatasetId(dataset_id, headers)) || dataset_id;
      const metaResp = await axios.get(`https://${CLIENT_DOMAIN}/api/data/v3/datasources/${datasetId}`, {
        headers,
        timeout: 30000,
        validateStatus: () => true,
      });
      if (metaResp.status !== 200) return text(`[ERR] Dataset not found: HTTP ${metaResp.status}`);
      const ds = metaResp.data;
      const name = ds.name || datasetId;
      let colHeaders = [];
      let dataRows = [];
      let source = 'preview API';

      const previewResp = await axios.get(
        `https://${CLIENT_DOMAIN}/api/data/v1/datasources/${datasetId}/data`,
        {
          headers,
          params: { includeHeaders: 'true', numRows: 20, offset: 0 },
          timeout: 30000,
          validateStatus: () => true,
        }
      );
      if (previewResp.status === 200) {
        const raw = previewResp.data;
        colHeaders = raw.columns || [];
        dataRows = raw.rows || [];
      }

      if (!dataRows.length) {
        source = 'SQL fallback  [CREDIT CONSUMED]';
        const qr = await axios.post(
          `https://${CLIENT_DOMAIN}/api/query/v1/execute/${datasetId}`,
          { sql: 'SELECT * FROM table LIMIT 20' },
          { headers, timeout: 60000, validateStatus: () => true }
        );
        if (qr.status !== 200) return text(`[ERR] Preview failed: HTTP ${qr.status}`);
        const result = qr.data;
        colHeaders = result.columns || [];
        dataRows = result.rows || [];
      }

      if (!dataRows.length) return text(`Dataset '${name}' returned 0 rows.`);

      const piiKeywords = ['email', 'phone', 'name', 'id', 'ssn', 'address', 'dob'];
      const piiIndices = new Set(
        colHeaders
          .map((h, i) => (piiKeywords.some((kw) => String(h).toLowerCase().includes(kw)) ? i : -1))
          .filter((i) => i !== -1)
      );
      const colWidths = colHeaders.map((h) => Math.max(String(h).length, 12));

      const lines = [
        `Preview: ${name}`,
        '─'.repeat(60),
        `  Source     : ${source}`,
        `  Total rows : ${ds.rowCount !== undefined ? ds.rowCount : '?'}`,
        `  Columns    : ${colHeaders.length}`,
        `  Showing    : ${Math.min(dataRows.length, 20)} rows`,
        '',
        '  ' + colHeaders.map((h, i) => String(h).slice(0, colWidths[i]).padEnd(colWidths[i])).join(' | '),
        '  ' + '-'.repeat(colWidths.reduce((a, w) => a + w + 3, 0)),
      ];
      for (const row of dataRows.slice(0, 20)) {
        const values = Array.isArray(row) ? row : Object.values(row);
        lines.push(
          '  ' +
          values
            .map((v, i) => {
              const w = colWidths[i] || 12;
              const val = piiIndices.has(i) ? '***' : String(v);
              return val.slice(0, w).padEnd(w);
            })
            .join(' | ')
        );
      }
      logOp('preview_data', 'OK', {
        dataset_id: datasetId,
        extra: { rows_shown: Math.min(dataRows.length, 20), source },
      });
      return text(lines.join('\n'));
    } catch (e) {
      if (e instanceof AccessDeniedError) return text(e.message);
      return text(`[ERR] ${e.message}`);
    }
  }
);

server.tool(
  'create_card',
  'Create a Domo card from a dataset. Dry run by default. Role required: deployer',
  {
    dataset_id: z.string().describe('Dataset UUID or name'),
    card_title: z.string().describe('Card title'),
    chart_type: z.string().optional().default('BAR').describe('BAR | LINE | PIE | TABLE | COLUMN | AREA | SCATTER'),
    x_column: z.string().optional().default('').describe('Dimension column'),
    y_column: z.string().optional().default('').describe('Measure column'),
    confirm: z.boolean().optional().default(false).describe('Set true to create. Default is dry run.'),
  },
  async ({ dataset_id, card_title, chart_type = 'BAR', x_column = '', y_column = '', confirm = false }) => {
    try {
      checkAccess(AGENT_EMAIL, 'create_card');
      const headers = getHeaders();
      const datasetId = (await resolveDatasetId(dataset_id, headers)) || dataset_id;
      const metaResp = await axios.get(`https://${CLIENT_DOMAIN}/api/data/v3/datasources/${datasetId}`, {
        headers,
        timeout: 30000,
        validateStatus: () => true,
      });

      if (metaResp.status !== 200) return text(`[ERR] Dataset not found: HTTP ${metaResp.status}`);
      const ds = metaResp.data;
      const validTypes = new Set(['BAR', 'LINE', 'PIE', 'TABLE', 'COLUMN', 'AREA', 'SCATTER']);
      if (!validTypes.has(chart_type.toUpperCase())) {
        return text(`[ERR] Invalid chart_type. Valid: ${Array.from(validTypes).sort().join(', ')}`);
      }
      const lines = [
        `Create Card — ${confirm ? 'LIVE' : 'DRY RUN'}`,
        '─'.repeat(60),
        `  Dataset    : ${ds.name || '?'} (${datasetId})`,
        `  Title      : ${card_title}`,
        `  Chart type : ${chart_type.toUpperCase()}`,
        `  X column   : ${x_column || '(not specified)'}`,
        `  Y column   : ${y_column || '(not specified)'}`,
        '',
      ];
      if (!confirm) {
        lines.push('[DRY RUN] No changes made.', '--> Set confirm=True to create.');
        return text(lines.join('\n'));
      }
      const payload = {
        title: card_title,
        type: 'kpi',
        cardMetadata: { chartType: chart_type.toUpperCase(), datasourceId: datasetId },
      };
      if (x_column) payload.cardMetadata.xColumn = x_column;
      if (y_column) payload.cardMetadata.yColumn = y_column;
      const resp = await axios.post(`https://${CLIENT_DOMAIN}/api/content/v1/cards`, payload, {
        headers,
        timeout: 30000,
        validateStatus: () => true,
      });

      console.log('====================');
      console.log('DOMO CARD PAYLOAD');
      console.log(JSON.stringify(payload, null, 2));

      console.log('====================');
      console.log('DOMO RESPONSE STATUS');
      console.log(resp.status);

      console.log('====================');
      console.log('DOMO RESPONSE BODY');
      console.log(JSON.stringify(resp.data, null, 2));
      if (resp.status === 200 || resp.status === 201) {
        const cardId = resp.data.id || '?';
        logOp('create_card', 'OK', { dataset_id: datasetId, extra: { card_id: cardId } });
        lines.push(
          '[OK] Card created.',
          `  Card ID : ${cardId}`,
          `  URL     : https://${CLIENT_DOMAIN}/cards/${cardId}`
        );
      } else {
        lines.push(
          `[ERR] Creation failed: HTTP ${resp.status}`,
          JSON.stringify(resp.data, null, 2)
        );
      }
      return text(lines.join('\n'));
    } catch (e) {
      if (e instanceof AccessDeniedError) return text(e.message);
      return text(`[ERR] ${e.message}`);
    }
  }
);

server.tool(
  'list_dashboards',
  'List all dashboards/pages in your Domo instance. Role required: viewer',
  {
    limit: z.number().int().optional().default(50).describe('How many to return (default 50, max 200)'),
    offset: z.number().int().optional().default(0).describe('Pagination offset'),
  },
  async ({ limit = 50, offset = 0 }) => {
    try {
      checkAccess(AGENT_EMAIL, 'list_dashboards');
      const headers = getHeaders();
      const resp = await axios.get(`https://${CLIENT_DOMAIN}/api/content/v1/pages`, {
        headers,
        params: { limit: Math.min(limit, 200), offset },
        timeout: 30000,
        validateStatus: () => true,
      });
      if (resp.status !== 200) return text(`[ERR] Failed to list dashboards: HTTP ${resp.status}`);
      const data = resp.data;
      const pages = Array.isArray(data) ? data : data.pages || [];
      if (!pages.length) return text('No dashboards found.');
      const lines = [`Dashboards: ${CLIENT_DOMAIN}`, '─'.repeat(60), `  Found : ${pages.length} (offset ${offset})`, ''];
      for (const p of pages) {
        const pageId = p.pageId !== undefined ? p.pageId : p.id !== undefined ? p.id : '?';
        const title = p.title || p.name || 'Untitled';
        const pageType = p.type || '?';
        const cardCount = (p.cardIds || []).length;
        lines.push(`  [${pageId}]  ${title}`);
        lines.push(`       Type: ${pageType} | Cards: ${cardCount}`);
      }
      logOp('list_dashboards', 'OK', { extra: { count: pages.length } });
      return text(lines.join('\n'));
    } catch (e) {
      if (e instanceof AccessDeniedError) return text(e.message);
      return text(`[ERR] ${e.message}`);
    }
  }
);

server.tool(
  'inspect_dashboard',
  'Get full details of a dashboard -- cards, layout, owners. Role required: viewer',
  {
    page_id: z.number().int().describe('Dashboard/page ID (numeric)'),
  },
  async ({ page_id }) => {
    try {
      checkAccess(AGENT_EMAIL, 'inspect_dashboard');
      const headers = getHeaders();
      const resp = await axios.get(`https://${CLIENT_DOMAIN}/api/content/v1/pages/${page_id}`, {
        headers,
        timeout: 15000,
        validateStatus: () => true,
      });
      if (resp.status !== 200) return text(`[ERR] Dashboard ${page_id} not found: HTTP ${resp.status}`);
      const page = resp.data;
      const title = page.title || page.name || 'Untitled';
      const ptype = page.type || '?';

      const cardsResp = await axios.get(`https://${CLIENT_DOMAIN}/api/content/v1/pages/${page_id}/cards`, {
        headers,
        params: { limit: 50 },
        timeout: 15000,
        validateStatus: () => true,
      });
      let cards = [];
      if (cardsResp.status === 200) {
        cards = cardsResp.data;
        if (!Array.isArray(cards)) cards = cards.cards || [];
      }

      const lines = [
        `Dashboard: ${title}`,
        '─'.repeat(60),
        '',
        `  Page ID  : ${page_id}`,
        `  Type     : ${ptype}`,
        `  Cards    : ${cards.length} card(s)`,
        '',
      ];
      if (cards.length) {
        lines.push(`CARDS (${cards.length})`);
        for (const c of cards) {
          const cardId = c.id !== undefined ? c.id : '?';
          const cardTitle = c.title || 'Untitled';
          const chartType = c.chartType || c.type || '?';
          lines.push(`  [${cardId}]  ${cardTitle}`);
          lines.push(`       Type: ${chartType}`);
          lines.push(`       URL : https://${CLIENT_DOMAIN}/kpis/details/${cardId}`);
        }
        lines.push('', '--> Use read_card(card_id) to inspect any card in detail');
      }
      logOp('inspect_dashboard', 'OK', { extra: { page_id } });
      return text(lines.join('\n'));
    } catch (e) {
      if (e instanceof AccessDeniedError) return text(e.message);
      return text(`[ERR] ${e.message}`);
    }
  }
);

server.tool(
  'read_card',
  'Get full details of a card -- type, dataset link, chart config. Searches all pages to find the card. Role required: viewer',
  {
    card_id: z.number().int().describe('Card ID (numeric)'),
  },
  async ({ card_id }) => {
    try {
      checkAccess(AGENT_EMAIL, 'read_card');
      const headers = getHeaders();
      let card = null;

      const pagesResp = await axios.get(`https://${CLIENT_DOMAIN}/api/content/v1/pages`, {
        headers,
        params: { limit: 200 },
        timeout: 15000,
        validateStatus: () => true,
      });
      let pages = pagesResp.status === 200 ? pagesResp.data : [];
      if (!Array.isArray(pages)) pages = pages.pages || [];

      for (const page of pages) {
        const pageIdVal = page.pageId !== undefined ? page.pageId : page.id;
        const cardIds = page.cardIds || [];
        const hasCard = cardIds.some((c) => c === card_id || String(c) === String(card_id));
        if (hasCard) {
          const cr = await axios.get(`https://${CLIENT_DOMAIN}/api/content/v1/pages/${pageIdVal}/cards`, {
            headers,
            params: { limit: 100 },
            timeout: 15000,
            validateStatus: () => true,
          });
          if (cr.status === 200) {
            let pageCards = cr.data;
            if (!Array.isArray(pageCards)) pageCards = pageCards.cards || [];
            for (const c of pageCards) {
              if (String(c.id) === String(card_id)) {
                card = c;
                card._page_id = pageIdVal;
                card._page_title = page.title || '?';
                break;
              }
            }
          }
          break;
        }
      }

      if (!card) {
        return text(
          [
            `Card ${card_id} -- Not Found`,
            '─'.repeat(60),
            '',
            `  Card ID  : ${card_id}`,
            '  Card not found on any accessible dashboard.',
            '',
            'Workarounds:',
            '  --> list_dashboards() -- browse available dashboards',
            '  --> inspect_dashboard(page_id) -- see all cards on a page',
          ].join('\n')
        );
      }

      const title = card.title || 'Untitled';
      const chartType = card.chartType || '?';
      const owners = card.owners || [];
      const ownerName = owners.length ? owners[0].displayName || 'Unknown' : 'Unknown';
      const pageTitle = card._page_title || '?';
      const pageIdV = card._page_id !== undefined ? card._page_id : '?';
      const datasource = card.datasourceId || '?';

      const lines = [
        `Card: ${title}`,
        '─'.repeat(60),
        '',
        `  Card ID    : ${card_id}`,
        `  Chart type : ${chartType}`,
        `  Owner      : ${ownerName}`,
        `  Dashboard  : ${pageTitle} (ID: ${pageIdV})`,
        `  Dataset ID : ${datasource}`,
        `  URL        : https://${CLIENT_DOMAIN}/kpis/details/${card_id}`,
        '',
      ];
      if (datasource && datasource !== '?') {
        lines.push(
          `--> inspect_schema('${datasource}') -- see columns`,
          `--> preview_data('${datasource}')   -- see data`
        );
      }
      logOp('read_card', 'OK', { extra: { card_id } });
      return text(lines.join('\n'));
    } catch (e) {
      if (e instanceof AccessDeniedError) return text(e.message);
      return text(`[ERR] ${e.message}`);
    }
  }
);

server.tool(
  'notify_teams',
  'Send a custom notification to your Teams channel. Role required: viewer',
  {
    message: z.string().describe('Text to send'),
    status: z.string().optional().default('INFO').describe('OK | FAILED | WARN | INFO'),
  },
  async ({ message, status = 'INFO' }) => {
    try {
      checkAccess(AGENT_EMAIL, 'notify_teams');
      if (!TEAMS_WEBHOOK_URL) return text('[ERR] TEAMS_WEBHOOK_URL not set in env vars.');
      const card = teamsCard(message, status.toUpperCase(), [
        ['Sent by', AGENT_EMAIL],
        ['Time', new Date().toISOString().slice(0, 19).replace('T', ' ')],
        ['Instance', CLIENT_DOMAIN],
      ]);
      const ok = await sendTeams(card);
      logOp('notify_teams', ok ? 'OK' : 'FAILED', { extra: { message: message.slice(0, 100) } });
      return text(ok ? '[OK] Teams notification sent.' : '[ERR] Failed to send -- check TEAMS_WEBHOOK_URL');
    } catch (e) {
      if (e instanceof AccessDeniedError) return text(e.message);
      return text(`[ERR] ${e.message}`);
    }
  }
);

server.tool(
  'test_teams_webhook',
  'Send a test message to Teams to verify the webhook is working. Role required: viewer',
  {},
  async () => {
    try {
      checkAccess(AGENT_EMAIL, 'test_teams_webhook');
      if (!TEAMS_WEBHOOK_URL) {
        return text(
          [
            '[ERR] TEAMS_WEBHOOK_URL not set.',
            '   Steps:',
            '   1. Open your Teams channel',
            '   2. Click ... -> Connectors -> Incoming Webhook',
            "   3. Name it 'Domo ETL Monitor', copy the URL",
            '   4. Add TEAMS_WEBHOOK_URL=https://... to your env vars',
            '   5. Restart and run this test again',
          ].join('\n')
        );
      }
      const card = teamsCard('Domo MCP Tool -- Connection Test', 'OK', [
        ['Status', 'Webhook connected successfully'],
        ['Instance', CLIENT_DOMAIN],
        ['User', AGENT_EMAIL],
        ['Time', new Date().toISOString().slice(0, 19).replace('T', ' ')],
        ['Tools', '13 tools loaded'],
      ]);
      const ok = await sendTeams(card);
      logOp('test_teams_webhook', ok ? 'OK' : 'FAILED');
      if (ok) return text('[OK] Teams webhook test successful! Test card posted to your channel.');
      return text('[ERR] Webhook test failed. Check TEAMS_WEBHOOK_URL is correct and not expired.');
    } catch (e) {
      if (e instanceof AccessDeniedError) return text(e.message);
      return text(`[ERR] ${e.message}`);
    }
  }
);

server.tool(
  'view_audit_log',
  'View the local audit log. Admin only.',
  {
    date: z.string().optional().default('').describe('YYYY-MM-DD (default: today)'),
    last_n: z.number().int().optional().default(50).describe('Most recent N entries to show (default 50)'),
  },
  async ({ date = '', last_n = 50 }) => {
    try {
      checkAccess(AGENT_EMAIL, 'view_audit_log');
      const logDate = date.trim() || new Date().toISOString().slice(0, 10);
      const logFile = path.join(AUDIT_DIR, `audit_${logDate}.jsonl`);
      if (!fs.existsSync(logFile)) return text(`No audit log found for ${logDate}.`);
      const content = fs.readFileSync(logFile, 'utf-8');
      let entries = content
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l));
      entries = entries.slice(-last_n);
      const lines = [
        `Audit Log — ${logDate}`,
        '─'.repeat(60),
        `  Instance : ${CLIENT_DOMAIN}`,
        `  Entries  : ${entries.length}`,
        '',
        `  ${'Timestamp'.padEnd(20)}  ${'Tool'.padEnd(30)}  ${'Status'.padEnd(8)}  ID`,
        `  ${'─'.repeat(20)}  ${'─'.repeat(30)}  ${'─'.repeat(8)}  ${'─'.repeat(20)}`,
      ];
      for (const e of entries) {
        const refId = e.etl_id || e.dataset_id || '';
        lines.push(
          `  ${(e.timestamp || '?').padEnd(20)}  ${(e.tool || '?').padEnd(30)}  ${(e.status || '?').padEnd(8)}  ${refId}`
        );
      }
      return text(lines.join('\n'));
    } catch (e) {
      if (e instanceof AccessDeniedError) return text(e.message);
      return text(`[ERR] ${e.message}`);
    }
  }
);

server.tool(
  'create_dataset',
  'Create a new dataset in Domo and upload CSV data. Role required: deployer',
  {
    name: z.string().describe('Dataset name'),
    schema_columns: z.array(z.object({
      name: z.string(),
      type: z.string()
    })).describe('Columns schema: [{ name, type }]'),
    csv_data: z.string().describe('CSV formatted data rows'),
  },
  async ({ name, schema_columns, csv_data }) => {
    try {
      checkAccess(AGENT_EMAIL, 'create_dataset');
      const headers = getHeaders();
      
      // Step 1: Create dataset metadata
      const createPayload = {
        name: name,
        dataSourceName: name,
        datasourceName: name,
        displayName: name,
        dataProviderType: 'api',
        schema: {
          columns: schema_columns
        }
      };
      
      const createResp = await axios.post(`https://${CLIENT_DOMAIN}/api/data/v2/datasources`, createPayload, {
        headers,
        timeout: 30000,
        validateStatus: () => true
      });
      
      if (createResp.status !== 200) {
        return text(`[ERR] Failed to create dataset: HTTP ${createResp.status}\n${JSON.stringify(createResp.data)}`);
      }
      
      const datasetId = createResp.data.dataSource.dataSourceId;
      
      // Step 2: Init upload session
      const initResp = await axios.post(
        `https://${CLIENT_DOMAIN}/api/data/v3/datasources/${datasetId}/uploads`,
        { action: 'REPLACE' },
        { headers, timeout: 30000, validateStatus: () => true }
      );
      
      if (initResp.status !== 200 && initResp.status !== 201) {
        return text(`[ERR] Failed to initiate upload: HTTP ${initResp.status}\n${JSON.stringify(initResp.data)}`);
      }
      
      const uploadId = initResp.data.uploadId || initResp.data.id;
      
      // Step 3: Upload CSV data parts
      const uploadDataResp = await axios.put(
        `https://${CLIENT_DOMAIN}/api/data/v3/datasources/${datasetId}/uploads/${uploadId}/parts/1`,
        csv_data,
        {
          headers: {
            ...headers,
            'Content-Type': 'text/csv'
          },
          timeout: 60000,
          validateStatus: () => true
        }
      );
      
      if (uploadDataResp.status !== 200 && uploadDataResp.status !== 204) {
        return text(`[ERR] Failed to upload data: HTTP ${uploadDataResp.status}\n${JSON.stringify(uploadDataResp.data)}`);
      }
      
      // Step 4: Commit
      const commitResp = await axios.put(
        `https://${CLIENT_DOMAIN}/api/data/v3/datasources/${datasetId}/uploads/${uploadId}/commit`,
        { index: true },
        { headers, timeout: 30000, validateStatus: () => true }
      );
      
      if (commitResp.status !== 200 && commitResp.status !== 204) {
        return text(`[ERR] Failed to commit upload: HTTP ${commitResp.status}\n${JSON.stringify(commitResp.data)}`);
      }
      
      logOp('create_dataset', 'OK', { dataset_id: datasetId, extra: { name } });
      
      const lines = [
        '[OK] Dataset created and populated.',
        `  Dataset ID : ${datasetId}`,
        `  Name       : ${name}`,
        `  Rows       : ${commitResp.data?.size?.rowCount || '?'}`
      ];
      
      return text(lines.join('\n'));
    } catch (e) {
      if (e instanceof AccessDeniedError) return text(e.message);
      return text(`[ERR] ${e.message}`);
    }
  }
);

server.tool(
  'list_role_permissions',
  'Show current role assignments and what each role can do. Role required: viewer',
  {},
  async () => {
    try {
      checkAccess(AGENT_EMAIL, 'list_role_permissions');
      const myRole = AGENT_ROLES[AGENT_EMAIL] || 'unknown';
      const lines = [
        'Role Permissions Overview',
        '─'.repeat(60),
        '',
        'YOUR IDENTITY',
        `   Email : ${AGENT_EMAIL}`,
        `   Role  : ${myRole}`,
        '',
        'ROLE PERMISSIONS',
        '   viewer   -- list, search, inspect, dashboards',
        '   analyst  -- above + preview_data',
        '   deployer -- above + create_card',
        '   admin    -- everything + view_audit_log',
        '',
        'ALL USERS',
      ];
      for (const [email, role] of Object.entries(AGENT_ROLES).sort()) {
        const me = email === AGENT_EMAIL ? ' <-- you' : '';
        lines.push(`   ${role.padEnd(12)} ${email}${me}`);
      }
      return text(lines.join('\n'));
    } catch (e) {
      if (e instanceof AccessDeniedError) return text(e.message);
      return text(`[ERR] ${e.message}`);
    }
  }
);

server.tool(
  'create_dashboard',
  'Create a Domo dashboard (page) with KPI cards. Role required: deployer',
  {
    name: z.string().describe('Dashboard name'),
    parentId: z.number().int().optional().describe('Parent page ID (optional)'),
    locked: z.boolean().optional().default(false).describe('Whether the page is locked (default: false)'),
    cardIds: z.array(z.number().int()).describe('List of card IDs to put in the dashboard'),
    visibility: z.object({
      userIds: z.array(z.number().int()).optional().default([]),
      groupIds: z.array(z.number().int()).optional().default([]),
    }).optional().describe('Visibility access list'),
    confirm: z.boolean().optional().default(false).describe('Set true to perform execution. Default is dry run.'),
  },
  async ({ name, parentId, locked = false, cardIds, visibility = { userIds: [], groupIds: [] }, confirm = false }) => {
    try {
      checkAccess(AGENT_EMAIL, 'create_dashboard');
      const headers = getHeaders();

      const lines = [
        `Create Dashboard — ${confirm ? 'LIVE' : 'DRY RUN'}`,
        '─'.repeat(60),
        `  Name       : ${name}`,
        `  Parent ID  : ${parentId !== undefined ? parentId : '(none)'}`,
        `  Locked     : ${locked}`,
        `  Card IDs   : ${cardIds.join(', ')}`,
        `  Visibility : ${JSON.stringify(visibility)}`,
        '',
      ];

      if (!confirm) {
        lines.push('[DRY RUN] No changes made.', '--> Set confirm=True to create.');
        return text(lines.join('\n'));
      }

      const payload = {
        name,
        locked,
        cardIds,
        visibility,
      };
      if (parentId !== undefined) {
        payload.parentId = parentId;
      }

      const resp = await axios.post(`https://${CLIENT_DOMAIN}/api/content/v1/pages`, payload, {
        headers,
        timeout: 30000,
        validateStatus: () => true,
      });

      console.log('====================');
      console.log('DOMO DASHBOARD PAYLOAD');
      console.log(JSON.stringify(payload, null, 2));

      console.log('====================');
      console.log('DOMO DASHBOARD STATUS');
      console.log(resp.status);

      console.log('====================');
      console.log('DOMO DASHBOARD BODY');
      console.log(JSON.stringify(resp.data, null, 2));

      if (resp.status === 200 || resp.status === 201) {
        const dashboardId = resp.data.id || resp.data.pageId || '?';
        logOp('create_dashboard', 'OK', { extra: { dashboard_id: dashboardId, card_count: cardIds.length } });
        lines.push(
          '[OK] Dashboard created.',
          `  Dashboard ID : ${dashboardId}`,
          `  URL          : https://${CLIENT_DOMAIN}/pages/${dashboardId}`
        );
      } else {
        lines.push(
          `[ERR] Dashboard creation failed: HTTP ${resp.status}`,
          JSON.stringify(resp.data, null, 2)
        );
      }
      return text(lines.join('\n'));
    } catch (e) {
      if (e instanceof AccessDeniedError) return text(e.message);
      return text(`[ERR] ${e.message}`);
    }
  }
);

function text(content) {
  return { content: [{ type: 'text', text: content }] };
}

async function main() {
  console.error('Domo MCP Tool starting...');
  console.error(`   Instance : ${CLIENT_DOMAIN}`);
  console.error(`   Operator : ${AGENT_EMAIL}`);
  console.error('   Sections : Datasets(6) | Dashboards(3) | Notifications(2) | Admin(2)');
  console.error('   Tools    : 14 tools loaded');
  console.error('');

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
