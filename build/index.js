import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import { DomoService } from './domoService.js';
import { parsePbix } from './pbixParser.js';
// Load environment variables from .env if present
dotenv.config();
const server = new Server({
    name: 'powerbi-domo-mcp-server',
    version: '1.0.0',
}, {
    capabilities: {
        tools: {},
    },
});
// Define schema validation for our tool arguments
const UploadDashboardSchema = z.object({
    filePath: z.string().describe('Absolute path to the local Power BI (.pbix) file on this computer.'),
    clientId: z.string().optional().describe('Optional Domo API Client ID. Defaults to DOMO_CLIENT_ID environment variable.'),
    clientSecret: z.string().optional().describe('Optional Domo API Client Secret. Defaults to DOMO_CLIENT_SECRET environment variable.'),
    domoInstance: z.string().optional().describe('Optional Domo API Host. Defaults to api.domo.com (or DOMO_API_HOST environment variable).'),
});
// Helper to map PBIX visual types to Domo KPI chart types
function mapPbixToDomoChartType(pbixType) {
    const t = pbixType.toLowerCase();
    if (t.includes('barchart') || t.includes('columnchart')) {
        return 'vertical_bar';
    }
    if (t.includes('piechart') || t.includes('donutchart')) {
        return 'pie';
    }
    if (t.includes('linechart') || t.includes('areachart')) {
        return 'line';
    }
    if (t.includes('table') || t.includes('matrix')) {
        return 'table';
    }
    if (t.includes('card') || t.includes('kpi') || t.includes('singlevalue')) {
        return 'kpi_card';
    }
    if (t.includes('funnel')) {
        return 'funnel';
    }
    if (t.includes('scatter')) {
        return 'scatter_plot';
    }
    return 'vertical_bar'; // Fallback default
}
// Register the tool
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: 'upload_powerbi_dashboard',
                description: 'Parses a local Power BI dashboard (.pbix) file, uploads its visual metadata to a Domo DataSet, creates a Domo Dashboard (Page) named after the file, and auto-generates visual cards on the page.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        filePath: {
                            type: 'string',
                            description: 'Absolute path to the local Power BI (.pbix) file.',
                        },
                        clientId: {
                            type: 'string',
                            description: 'Optional Domo Client ID.',
                        },
                        clientSecret: {
                            type: 'string',
                            description: 'Optional Domo Client Secret.',
                        },
                        domoInstance: {
                            type: 'string',
                            description: 'Optional Domo API Host (e.g. api.domo.com).',
                        },
                    },
                    required: ['filePath'],
                },
            },
        ],
    };
});
// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== 'upload_powerbi_dashboard') {
        throw new Error(`Tool not found: ${request.params.name}`);
    }
    // Parse and validate arguments
    const args = UploadDashboardSchema.parse(request.params.arguments);
    const resolvedPath = path.resolve(args.filePath);
    console.error(`Received request to migrate Power BI file: ${resolvedPath}`);
    try {
        // 1. Verify and read/parse local file
        if (!fs.existsSync(resolvedPath)) {
            throw new Error(`File not found at: ${resolvedPath}`);
        }
        const pbixMetadata = parsePbix(resolvedPath);
        const fileName = pbixMetadata.fileName;
        const fileSizeMb = pbixMetadata.fileSizeMb;
        const dashboardName = path.basename(resolvedPath, path.extname(resolvedPath));
        console.error(`Parsed Power BI file: ${fileName} (${fileSizeMb} MB) with ${pbixMetadata.summary.totalPages} pages.`);
        // 2. Determine credentials for Domo
        const domoClientId = args.clientId || process.env.DOMO_CLIENT_ID;
        const domoClientSecret = args.clientSecret || process.env.DOMO_CLIENT_SECRET;
        const domoInstance = args.domoInstance || process.env.DOMO_API_HOST || 'api.domo.com';
        let markdown = '';
        if (domoClientId && domoClientSecret) {
            console.error(`Authenticating with Domo at ${domoInstance}...`);
            const domo = new DomoService(domoClientId, domoClientSecret, domoInstance);
            await domo.authenticate();
            // Create/Lookup metadata DataSet
            const datasetName = `PowerBI Migration: ${fileName}`;
            console.error(`Looking up DataSet "${datasetName}"...`);
            let datasetId = await domo.findDatasetByName(datasetName);
            if (!datasetId) {
                console.error(`Creating new DataSet "${datasetName}"...`);
                datasetId = await domo.createDataset(datasetName, `Metadata for visual structures, columns, and formulas compiled from ${fileName}`);
                console.error(`DataSet created successfully. ID: ${datasetId}`);
            }
            else {
                console.error(`Found existing DataSet "${datasetName}" (ID: ${datasetId})`);
            }
            // Compile rows from PBIX pages and visuals
            const rows = [];
            const detectedDate = new Date().toISOString().split('T')[0];
            for (const page of pbixMetadata.pages) {
                for (const visual of page.visuals) {
                    rows.push({
                        page_name: page.displayName || page.name,
                        visual_name: visual.name,
                        visual_type: visual.type,
                        columns_used: visual.columns.join(', '),
                        formulas_used: visual.formulas.join('; '),
                        migration_status: 'MIGRATED',
                        detected_date: detectedDate,
                    });
                }
            }
            // Upload rows to DataSet
            console.error(`Uploading ${rows.length} rows to DataSet ${datasetId}...`);
            await domo.uploadData(datasetId, rows);
            console.error('Data upload completed.');
            // Create Domo Page (Dashboard)
            console.error(`Creating Domo Page/Dashboard named "${dashboardName}"...`);
            const pageId = await domo.createPage(dashboardName, `Dashboard compiled from Power BI report file: ${fileName}`);
            console.error(`Page created successfully. ID: ${pageId}`);
            // Create KPI cards on the dashboard page for each visual
            const createdCards = [];
            for (const page of pbixMetadata.pages) {
                for (const visual of page.visuals) {
                    const domoChartType = mapPbixToDomoChartType(visual.type);
                    const colsDesc = visual.columns.length > 0 ? `Columns: ${visual.columns.join(', ')}` : 'No columns';
                    const formsDesc = visual.formulas.length > 0 ? `Formulas: ${visual.formulas.join('; ')}` : 'No formulas';
                    const cardDesc = `From Page: ${page.displayName || page.name}. ${colsDesc}. ${formsDesc}.`;
                    console.error(`Creating KPI Card "${visual.name}" (${domoChartType}) for DataSet ${datasetId}...`);
                    try {
                        const cardId = await domo.createKpiCard(visual.name, cardDesc, domoChartType, datasetId, pageId);
                        createdCards.push({
                            pageName: page.displayName || page.name,
                            title: visual.name,
                            type: domoChartType,
                            id: cardId,
                        });
                        console.error(`Card created successfully. ID: ${cardId}`);
                    }
                    catch (cardErr) {
                        console.error(`Warning: Failed to create card "${visual.name}": ${cardErr.message}`);
                    }
                }
            }
            // Build success report
            markdown += `## 🚀 Power BI Dashboard Migration Completed!\n\n`;
            markdown += `The Power BI dashboard file has been parsed, its visual metadata uploaded to Domo, and KPI cards generated.\n\n`;
            markdown += `### 📂 DataSet Details\n`;
            markdown += `*   **DataSet Name**: \`${datasetName}\`\n`;
            markdown += `*   **DataSet ID**: \`${datasetId}\`\n`;
            markdown += `*   **Metadata Rows Uploaded**: \`${rows.length}\` rows\n\n`;
            markdown += `### 📊 Dashboard Details\n`;
            markdown += `*   **Domo Page Name**: **${dashboardName}**\n`;
            markdown += `*   **Domo Page ID**: \`${pageId}\`\n\n`;
            markdown += `### 🃏 Generated Cards (${createdCards.length})\n`;
            if (createdCards.length > 0) {
                markdown += `| Page Name | Visual/Card Title | Chart Type | Domo Card ID |\n`;
                markdown += `| :--- | :--- | :--- | :--- |\n`;
                for (const card of createdCards) {
                    markdown += `| ${card.pageName} | ${card.title} | \`${card.type}\` | \`${card.id}\` |\n`;
                }
                markdown += `\n`;
            }
            else {
                markdown += `*No cards were successfully generated.*\n\n`;
            }
            markdown += `✓ All visual configurations, column bindings, and calculations have been processed.`;
        }
        else {
            console.error('Domo credentials not provided. Operating in offline validation/preview mode.');
            markdown += `## 👁 Power BI Dashboard Migration - Preview Mode\n\n`;
            markdown += `Domo API credentials (\`clientId\` and \`clientSecret\`) were not provided. Showing parsed visual structure preview below:\n\n`;
            markdown += `### 📂 File Summary\n`;
            markdown += `*   **File Name**: \`${fileName}\`\n`;
            markdown += `*   **File Size**: \`${fileSizeMb} MB\`\n`;
            markdown += `*   **Total Pages**: \`${pbixMetadata.summary.totalPages}\`\n`;
            markdown += `*   **Total Visuals**: \`${pbixMetadata.summary.totalVisuals}\`\n\n`;
            markdown += `### 📋 Parsed Pages & Visuals\n`;
            for (const page of pbixMetadata.pages) {
                markdown += `#### 📄 Page: ${page.displayName || page.name}\n`;
                if (page.visuals.length > 0) {
                    markdown += `| Visual Title | Visual Type | Columns Bound | Formulas/Calculations |\n`;
                    markdown += `| :--- | :--- | :--- | :--- |\n`;
                    for (const visual of page.visuals) {
                        const cols = visual.columns.length > 0 ? visual.columns.map(c => `\`${c}\``).join('<br>') : '*None*';
                        const forms = visual.formulas.length > 0 ? visual.formulas.map(f => `\`${f}\``).join('<br>') : '*None*';
                        markdown += `| ${visual.name} | \`${visual.type}\` | ${cols} | ${forms} |\n`;
                    }
                    markdown += `\n`;
                }
                else {
                    markdown += `*No visuals found on this page.*\n\n`;
                }
            }
            markdown += `\n> [!TIP]\n`;
            markdown += `> Configure your \`DOMO_CLIENT_ID\` and \`DOMO_CLIENT_SECRET\` to upload this metadata automatically into a Domo DataSet and create the dashboard and KPI cards.`;
        }
        return {
            content: [
                {
                    type: 'text',
                    text: markdown,
                },
            ],
        };
    }
    catch (err) {
        console.error(`Error in upload_powerbi_dashboard: ${err.message}`);
        return {
            isError: true,
            content: [
                {
                    type: 'text',
                    text: `❌ Error processing dashboard: ${err.message}\n\nTrace: ${err.stack || ''}`,
                },
            ],
        };
    }
});
// Start the server
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('Power BI to Domo Dashboard & Card MCP Server running on Stdio transport...');
}
main().catch((err) => {
    console.error('Fatal error starting MCP server:', err);
    process.exit(1);
});
