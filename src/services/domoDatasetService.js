import axios from 'axios';

/**
 * Cleans a raw PowerBI column name like "[TableName].[ColumnName]" or "TableName[ColumnName]"
 * into a plain "ColumnName" string safe for CSV headers.
 */
function cleanColumnName(rawName) {
  let name = String(rawName || '').trim();
  const bracketMatch = name.match(/\[([^\]]+)\]$/);
  if (bracketMatch) {
    return bracketMatch[1];
  }
  const dotParts = name.split('.');
  if (dotParts.length > 1) {
    return dotParts[dotParts.length - 1].replace(/[\[\]']/g, '');
  }
  return name.replace(/[\[\]']/g, '');
}

/**
 * Map PowerBI types to Domo types:
 * Int64/Double/Decimal -> DECIMAL
 * DateTime -> DATETIME
 * Boolean -> STRING
 * everything else -> STRING
 */
function mapType(type) {
  const t = String(type || '').toLowerCase();
  if (t === 'int64' || t === 'double' || t === 'decimal' || t === 'long') {
    return 'DECIMAL';
  }
  if (t === 'datetime' || t === 'date') {
    return 'DATETIME';
  }
  if (t === 'boolean') {
    return 'STRING';
  }
  return 'STRING';
}

function getHeaders(token) {
  return {
    'Content-Type': 'application/json;charset=utf-8',
    Accept: 'application/json, text/plain, */*',
    'X-DOMO-DEVELOPER-TOKEN': token,
    'x-requested-with': 'XMLHttpRequest',
  };
}

/**
 * Calls POST to https://{DOMO_CLIENT_DOMAIN}/api/data/v3/datasources with v2 fallback.
 * Body contains: { name: tableName, schema: { columns } }
 */
export async function createDomoDataset(tableName, columns) {
  const domain = (process.env.DOMO_CLIENT_DOMAIN || '').trim();
  const token = (process.env.DOMO_CLIENT_TOKEN || '').trim();

  if (!domain || !token) {
    throw new Error('Domo domain or developer token environment variables are not set.');
  }

  const headers = getHeaders(token);

  const createPayload = {
    name: tableName,
    dataSourceName: tableName,
    datasourceName: tableName,
    displayName: tableName,
    dataProviderType: 'api',
    schema: {
      columns: columns.map(c => ({
        name: c.name,
        type: mapType(c.type)
      }))
    }
  };

  try {
    let response;
    try {
      response = await axios.post(
        `https://${domain}/api/data/v3/datasources`,
        createPayload,
        { headers, timeout: 30000 }
      );
    } catch (v3Err) {
      // Fallback to v2 if v3 returns 405 or 404
      const status = v3Err.response ? v3Err.response.status : null;
      if (status === 405 || status === 404) {
        response = await axios.post(
          `https://${domain}/api/data/v2/datasources`,
          createPayload,
          { headers, timeout: 30000 }
        );
      } else {
        throw v3Err;
      }
    }

    const datasetId = response.data?.dataSource?.dataSourceId || response.data?.dataSourceId || response.data?.id;
    if (!datasetId) {
      throw new Error(`Domo creation response did not contain dataset ID. Response: ${JSON.stringify(response.data)}`);
    }
    return datasetId;
  } catch (error) {
    const status = error.response ? error.response.status : 'N/A';
    const body = error.response ? JSON.stringify(error.response.data) : error.message;
    throw new Error(`Failed to create Domo dataset: HTTP Status ${status} - Response: ${body}`);
  }
}

/**
 * Converts the rows array into CSV format, then calls POST to
 * https://{DOMO_CLIENT_DOMAIN}/api/data/v3/datasources/{domoDatasetId}/data/import
 */
export async function uploadDataToDomoDataset(domoDatasetId, columns, rows) {
  const domain = (process.env.DOMO_CLIENT_DOMAIN || '').trim();
  const token = (process.env.DOMO_CLIENT_TOKEN || '').trim();

  if (!domain || !token) {
    throw new Error('Domo domain or developer token environment variables are not set.');
  }

  const escape = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  const header = columns.map(c => c.name).join(',');
  const dataLines = rows.map(row => {
    if (Array.isArray(row)) {
      return row.map(escape).join(',');
    }
    return columns.map(col => {
      const rawKey = Object.keys(row).find(k => cleanColumnName(k) === col.name);
      const val = rawKey !== undefined ? row[rawKey] : '';
      return escape(val);
    }).join(',');
  });

  const csvString = [header, ...dataLines].join('\n');

  // console.log('================================');
  // console.log('DATASET ID:', domoDatasetId);
  // console.log('ROWS COUNT:', rows.length);
  // console.log('CSV LENGTH:', csvString.length);
  // console.log('CSV PREVIEW:');
  // console.log(csvString.split('\n').slice(0, 5).join('\n'));
  // console.log('================================');

  const authHeaders = { 'X-DOMO-DEVELOPER-TOKEN': token };

  try {
    // STEP 1: Create upload session (no body needed)
    const sessionRes = await axios.post(
      `https://${domain}/api/data/v3/datasources/${domoDatasetId}/uploads`,
      {},
      { headers: { ...authHeaders, 'Content-Type': 'application/json' }, timeout: 30000 }
    );

    const uploadId = sessionRes.data?.uploadId;
    if (!uploadId) {
      throw new Error(`No uploadId returned. Response: ${JSON.stringify(sessionRes.data)}`);
    }
    // console.log('UPLOAD SESSION ID:', uploadId);

    // STEP 2: Upload CSV as a raw part (this is where the actual data goes)
    const partRes = await axios.put(
      `https://${domain}/api/data/v3/datasources/${domoDatasetId}/uploads/${uploadId}/parts/1`,
      csvString,
      {
        headers: {
          ...authHeaders,
          'Content-Type': 'text/csv',
        },
        timeout: 120000,
        maxBodyLength: Infinity,
        maxContentLength: Infinity
      }
    );
    // console.log('PART UPLOAD STATUS:', partRes.status);

    // STEP 3: Commit the upload session
    const commitRes = await axios.put(
      `https://${domain}/api/data/v3/datasources/${domoDatasetId}/uploads/${uploadId}/commit`,
      { index: true },
      { headers: { ...authHeaders, 'Content-Type': 'application/json' }, timeout: 60000 }
    );
    // console.log('COMMIT STATUS:', commitRes.status);
    // console.log('COMMIT RESPONSE:', JSON.stringify(commitRes.data, null, 2));

    // STEP 4: Verify
    await new Promise(resolve => setTimeout(resolve, 5000));
    const verify = await axios.get(
      `https://${domain}/api/data/v3/datasources/${domoDatasetId}`,
      { headers: authHeaders }
    );
    // console.log('VERIFIED ROW COUNT:', verify.data.rowCount);

    return true;

  } catch (error) {
    const status = error.response ? error.response.status : 'N/A';
    const body = error.response ? JSON.stringify(error.response.data) : error.message;
    throw new Error(`Failed to upload data to Domo dataset ${domoDatasetId}: HTTP Status ${status} - Response: ${body}`);
  }
}
