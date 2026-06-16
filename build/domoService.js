import axios from 'axios';
/**
 * Escapes strings for a standard CSV format.
 */
function escapeCsvValue(val) {
    if (val === undefined || val === null) {
        return '';
    }
    const str = String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
        return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
}
/**
 * Handles communication with the Domo REST API.
 */
export class DomoService {
    clientId;
    clientSecret;
    apiHost;
    accessToken = null;
    constructor(clientId, clientSecret, apiHost = 'api.domo.com') {
        this.clientId = clientId;
        this.clientSecret = clientSecret;
        this.apiHost = apiHost.replace(/^https?:\/\//, ''); // Strip http/https prefix if any
    }
    /**
     * Retrieves an OAuth access token requesting both 'data' and 'dashboard' scopes.
     * Authentication is always sent to api.domo.com.
     */
    async authenticate() {
        if (this.accessToken) {
            return this.accessToken;
        }
        const authHeader = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
        const url = 'https://api.domo.com/oauth/token?grant_type=client_credentials&scope=data%20dashboard';
        try {
            const response = await axios.get(url, {
                headers: {
                    'Authorization': `Basic ${authHeader}`,
                    'Accept': 'application/json',
                },
            });
            if (response.data && response.data.access_token) {
                this.accessToken = response.data.access_token;
                return this.accessToken;
            }
            else {
                throw new Error('Domo OAuth response did not contain an access_token.');
            }
        }
        catch (err) {
            const status = err.response?.status;
            const data = err.response?.data;
            throw new Error(`Failed to authenticate with Domo (HTTP ${status || 'unknown'}): ${data ? JSON.stringify(data) : err.message}`);
        }
    }
    /**
     * Searches for an existing dataset by name. Returns the ID if found, or null.
     */
    async findDatasetByName(name) {
        const token = await this.authenticate();
        const url = `https://${this.apiHost}/v1/datasets?limit=50`;
        try {
            const response = await axios.get(url, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/json',
                },
            });
            if (Array.isArray(response.data)) {
                const matchingDataset = response.data.find((ds) => ds.name && ds.name.toLowerCase() === name.toLowerCase());
                return matchingDataset ? matchingDataset.id : null;
            }
            return null;
        }
        catch (err) {
            console.error('Error listing Domo datasets:', err.response?.data || err.message);
            return null;
        }
    }
    /**
     * Creates a new DataSet in Domo to store dashboard compiled visual metadata.
     */
    async createDataset(name, description) {
        const token = await this.authenticate();
        const url = `https://${this.apiHost}/v1/datasets`;
        const body = {
            name,
            description,
            schema: {
                columns: [
                    { type: 'STRING', name: 'page_name' },
                    { type: 'STRING', name: 'visual_name' },
                    { type: 'STRING', name: 'visual_type' },
                    { type: 'STRING', name: 'columns_used' },
                    { type: 'STRING', name: 'formulas_used' },
                    { type: 'STRING', name: 'migration_status' },
                    { type: 'STRING', name: 'detected_date' },
                ],
            },
        };
        try {
            const response = await axios.post(url, body, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                },
            });
            if (response.data && response.data.id) {
                return response.data.id;
            }
            else {
                throw new Error('Domo DataSet creation response did not contain an ID.');
            }
        }
        catch (err) {
            const status = err.response?.status;
            const data = err.response?.data;
            throw new Error(`Failed to create Domo DataSet (HTTP ${status || 'unknown'}): ${data ? JSON.stringify(data) : err.message}`);
        }
    }
    /**
     * Uploads visual metadata rows to a Domo DataSet.
     */
    async uploadData(datasetId, rows) {
        const token = await this.authenticate();
        const url = `https://${this.apiHost}/v1/datasets/${datasetId}/data?updateMethod=REPLACE`;
        // Convert rows to CSV format
        const csvHeaders = 'page_name,visual_name,visual_type,columns_used,formulas_used,migration_status,detected_date';
        const csvLines = rows.map((row) => `${escapeCsvValue(row.page_name)},${escapeCsvValue(row.visual_name)},${escapeCsvValue(row.visual_type)},${escapeCsvValue(row.columns_used)},${escapeCsvValue(row.formulas_used)},${escapeCsvValue(row.migration_status)},${escapeCsvValue(row.detected_date)}`);
        const csvContent = [csvHeaders, ...csvLines].join('\n');
        try {
            await axios.put(url, csvContent, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'text/csv',
                },
            });
        }
        catch (err) {
            const status = err.response?.status;
            const data = err.response?.data;
            throw new Error(`Failed to upload data to Domo DataSet (HTTP ${status || 'unknown'}): ${data ? JSON.stringify(data) : err.message}`);
        }
    }
    /**
     * Creates a new Page (Dashboard) in Domo.
     */
    async createPage(name, description = '') {
        const token = await this.authenticate();
        const url = `https://${this.apiHost}/v1/pages`;
        const body = {
            name,
            description,
            parentId: 0,
        };
        try {
            const response = await axios.post(url, body, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                },
            });
            if (response.data && response.data.id) {
                return String(response.data.id);
            }
            else {
                throw new Error('Domo page creation response did not contain an ID.');
            }
        }
        catch (err) {
            const status = err.response?.status;
            const data = err.response?.data;
            throw new Error(`Failed to create Domo Page/Dashboard (HTTP ${status || 'unknown'}): ${data ? JSON.stringify(data) : err.message}`);
        }
    }
    /**
     * Creates a KPI Card backed by a DataSet and associates it with a Dashboard Page.
     */
    async createKpiCard(title, description, chartType, dataSourceId, pageId) {
        const token = await this.authenticate();
        const url = `https://${this.apiHost}/v1/cards`;
        const body = {
            title,
            description,
            type: 'kpi',
            chartType,
            dataSourceId,
            pageIds: [pageId],
        };
        try {
            const response = await axios.post(url, body, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                },
            });
            if (response.data && response.data.id) {
                return String(response.data.id);
            }
            else {
                throw new Error('Domo Card creation response did not contain an ID.');
            }
        }
        catch (err) {
            const status = err.response?.status;
            const data = err.response?.data;
            throw new Error(`Failed to create Card (HTTP ${status || 'unknown'}): ${data ? JSON.stringify(data) : err.message}`);
        }
    }
}
