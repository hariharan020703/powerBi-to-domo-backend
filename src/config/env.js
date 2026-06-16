import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env file from the backend root directory
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const requiredEnvVars = [
  'AZURE_TENANT_ID',
  'AZURE_CLIENT_ID',
  'AZURE_CLIENT_SECRET',
  'ANTHROPIC_API_KEY',
  'DOMO_CLIENT_DOMAIN',
  'DOMO_CLIENT_TOKEN'
];

const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingVars.length > 0) {
  console.error(`[CONFIG ERROR] Missing required environment variables: ${missingVars.join(', ')}`);
  console.error('Please configure your .env file with the necessary Azure AD, Anthropic, and Domo details.');
  if (process.env.NODE_ENV === 'production') {
    process.exit(1);
  }
}

export const env = {
  azureTenantId: process.env.AZURE_TENANT_ID,
  azureClientId: process.env.AZURE_CLIENT_ID,
  azureClientSecret: process.env.AZURE_CLIENT_SECRET,
  powerBiApiUrl: process.env.POWERBI_API_URL || 'https://api.powerbi.com',
  powerBiScope: process.env.POWERBI_SCOPE || 'https://analysis.windows.net/powerbi/api/.default',
  powerBiWorkspaceId: process.env.POWERBI_WORKSPACE_ID,
  port: parseInt(process.env.PORT || '5000', 10),
  nodeEnv: process.env.NODE_ENV || 'production',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
  
  // Anthropic and Domo MCP configurations
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  domoMcpScriptPath: path.resolve(__dirname, '../mcp/domoMcpTool.js'),
  domoClientDomain: process.env.DOMO_CLIENT_DOMAIN,
  domoClientToken: process.env.DOMO_CLIENT_TOKEN,
  domoAgentEmail: process.env.DOMO_AGENT_EMAIL || 'your_email@gwcdata.ai',
  domoAgentRole: process.env.DOMO_AGENT_ROLE || 'deployer'
};
