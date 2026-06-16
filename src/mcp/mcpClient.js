import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { env } from '../config/env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mcpClient = null;
let mcpTransport = null;

/**
 * Creates and returns/caches a singleton MCP Client connected to domoMcpTool.js via StdioClientTransport.
 */
export async function getMcpClient() {
  if (mcpClient) {
    return mcpClient;
  }

  console.log('[MIGRATION] Initializing singleton MCP Client...');

  const scriptPath = path.resolve(__dirname, 'domoMcpTool.js');
  console.log(`[MIGRATION] Connecting to local Domo MCP server at: ${scriptPath}`);

  mcpClient = new Client(
    {
      name: 'domo-migration-client',
      version: '1.0.0',
    },
    {
      capabilities: {},
    }
  );

  mcpTransport = new StdioClientTransport({
    command: 'node',
    args: [scriptPath],
    env: {
      ...process.env,
      DOMO_CLIENT_DOMAIN: env.domoClientDomain,
      DOMO_CLIENT_TOKEN: env.domoClientToken,
      DOMO_AGENT_EMAIL: env.domoAgentEmail,
      DOMO_AGENT_ROLE: env.domoAgentRole,
    },
  });

  try {
    await mcpClient.connect(mcpTransport);
    console.log('[MIGRATION] MCP Client successfully connected to Domo MCP Server subprocess.');
  } catch (err) {
    console.error('[MIGRATION ERROR] Failed to connect to MCP Client:', err);
    mcpClient = null;
    mcpTransport = null;
    throw err;
  }

  return mcpClient;
}

/**
 * Gracefully closes the cached MCP client and subprocess.
 */
export async function closeMcpClient() {
  if (mcpClient) {
    console.log('[MIGRATION] Closing MCP Client subprocess...');
    try {
      await mcpClient.close();
      console.log('[MIGRATION] MCP Client successfully closed.');
    } catch (err) {
      console.error('[MIGRATION ERROR] Error closing MCP Client:', err);
    } finally {
      mcpClient = null;
      mcpTransport = null;
    }
  }
}

/**
 * Helper function to extract card ID and URL from the create_card tool's output text.
 * Returns an object with { success, domoCardId, domoCardUrl, message }.
 */
export function parseCreateCardResult(resultText) {
  const normalizedText = resultText || '';

  if (normalizedText.startsWith('[ERR]') || normalizedText.includes('[DRY RUN]')) {
    return {
      success: false,
      message: normalizedText.trim()
    };
  }

  const lines = normalizedText.split('\n');
  let domoCardId = '';
  let domoCardUrl = '';

  for (const line of lines) {
    if (line.includes('Card ID :')) {
      const parts = line.split('Card ID :');
      if (parts.length > 1) {
        domoCardId = parts[1].trim();
      }
    }
    if (line.includes('URL     :')) {
      const parts = line.split('URL     :');
      if (parts.length > 1) {
        domoCardUrl = parts[1].trim();
      }
    }
  }

  if (!domoCardId) {
    return {
      success: false,
      message: `Failed to extract Card ID from response: ${normalizedText}`
    };
  }

  return {
    success: true,
    domoCardId,
    domoCardUrl: domoCardUrl || `https://${env.domoClientDomain}/cards/${domoCardId}`
  };
}

/**
 * Helper function to extract dataset ID from the create_dataset tool's output text.
 * Returns an object with { success, datasetId, message }.
 */
export function parseCreateDatasetResult(resultText) {
  const normalizedText = resultText || '';

  if (normalizedText.startsWith('[ERR]')) {
    return {
      success: false,
      message: normalizedText.trim()
    };
  }

  const lines = normalizedText.split('\n');
  let datasetId = '';

  for (const line of lines) {
    if (line.includes('Dataset ID :')) {
      const parts = line.split('Dataset ID :');
      if (parts.length > 1) {
        datasetId = parts[1].trim();
      }
    }
  }

  if (!datasetId) {
    return {
      success: false,
      message: `Failed to extract Dataset ID from response: ${normalizedText}`
    };
  }

  return {
    success: true,
    datasetId
  };
}

/**
 * Helper function to extract dashboard ID and URL from the create_dashboard tool's output text.
 * Returns an object with { success, dashboardId, dashboardUrl, message }.
 */
export function parseCreateDashboardResult(resultText) {
  const normalizedText = resultText || '';

  if (normalizedText.startsWith('[ERR]')) {
    return {
      success: false,
      message: normalizedText.trim()
    };
  }

  const lines = normalizedText.split('\n');
  let dashboardId = '';
  let dashboardUrl = '';

  for (const line of lines) {
    if (line.includes('Dashboard ID :')) {
      const parts = line.split('Dashboard ID :');
      if (parts.length > 1) {
        dashboardId = parts[1].trim();
      }
    }
    if (line.includes('URL          :')) {
      const parts = line.split('URL          :');
      if (parts.length > 1) {
        dashboardUrl = parts[1].trim();
      }
    }
  }

  if (!dashboardId) {
    return {
      success: false,
      message: `Failed to extract Dashboard ID from response: ${normalizedText}`
    };
  }

  return {
    success: true,
    dashboardId,
    dashboardUrl: dashboardUrl || `https://${env.domoClientDomain}/pages/${dashboardId}`
  };
}

