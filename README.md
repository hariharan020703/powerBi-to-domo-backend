# Power BI Express Integration Backend

This is a production-ready Node.js Express backend designed to securely authenticate with Azure AD using Service Principal Client Credentials flow, interface with the Power BI REST API, cache and auto-refresh credentials, and expose structured endpoints to the frontend migration tool.

## Features
- **Azure AD OAuth2 Integration**: Secure Client Credentials flow with automatic token refresh 5 minutes before expiry.
- **Robust API Routing**: Endpoints to fetch Power BI workspaces, datasets, reports, dashboards, and execute queries.
- **Production-grade Security**: Equipped with `helmet` for secure HTTP headers, `cors` configured for specific origins, and IP-based rate limiting.
- **Failover & Retries**: Automatic exponential backoff retry mechanism (max 3 retries) for Power BI REST API calls on rate limits (429) or server errors (5xx).
- **Structured Error Handling**: Centralized error middleware returning clean, sanitized JSON responses.

---

## Prerequisites
- **Node.js**: version 18 or higher.
- **Azure AD App Registration**: A service principal registered in Azure AD with permissions to access Power BI APIs.

---

## Getting Started

### 1. Installation
Navigate to the `backend` folder and install the dependencies:
```bash
cd backend
npm install
```
*(On Windows systems where script execution is disabled in PowerShell, use `npm.cmd install` instead).*

### 2. Configuration
Copy the template `.env.example` to `.env`:
```bash
cp .env.example .env
```
Open `.env` and fill in your Azure Active Directory credentials:
- `AZURE_TENANT_ID`: Your Azure Active Directory Tenant ID.
- `AZURE_CLIENT_ID`: The App Registration Client (Application) ID.
- `AZURE_CLIENT_SECRET`: The Service Principal Client Secret.
- `POWERBI_WORKSPACE_ID`: (Optional) If you have a default workspace ID.
- `PORT`: Server port (default is `5000`).
- `NODE_ENV`: Set to `production` or `development`.
- `FRONTEND_URL`: URL of the frontend (default `http://localhost:5173`) to configure CORS.

### 3. Running the Server

#### Development Mode
```bash
npm run dev
```

#### Production Mode
```bash
npm start
```

---

## API Documentation

### 1. Health Check
- **URL**: `GET /health`
- **Description**: Returns server status.

### 2. Workspaces
- **URL**: `GET /api/powerbi/workspaces`
- **Description**: Retrieves a list of workspaces (groups) that the Service Principal has access to.
- **Power BI Call**: `GET /v1.0/myorg/groups`

### 3. Datasets
- **URL**: `GET /api/powerbi/workspaces/:groupId/datasets`
- **Description**: Retrieves a list of datasets in a specific workspace.
- **Power BI Call**: `GET /v1.0/myorg/groups/:groupId/datasets`

### 4. Reports
- **URL**: `GET /api/powerbi/workspaces/:groupId/reports`
- **Description**: Retrieves a list of reports in a specific workspace.
- **Power BI Call**: `GET /v1.0/myorg/groups/:groupId/reports`

### 5. Dashboards
- **URL**: `GET /api/powerbi/workspaces/:groupId/dashboards`
- **Description**: Retrieves a list of dashboards in a specific workspace.
- **Power BI Call**: `GET /v1.0/myorg/groups/:groupId/dashboards`

### 6. Execute Dataset Queries
- **URL**: `POST /api/powerbi/datasets/:datasetId/query`
- **Headers**: `Content-Type: application/json`
- **Body**:
  ```json
  {
    "query": "EVALUATE 'TableName'",
    "serializerSettings": {
      "includeNulls": true
    }
  }
  ```
- **Description**: Executes a DAX query against the specified dataset and returns rows.
- **Power BI Call**: `POST /v1.0/myorg/datasets/:datasetId/executeQueries`

---

## Deployment Instructions

For deploying this Node.js Express backend to a production environment:

1. **Environment Variables**: Never commit the `.env` file. Inject configuration variables securely through your hosting platform (e.g., AWS ECS, Heroku, Azure App Service, PM2, Docker).
2. **Reverse Proxy / SSL**: Set up a reverse proxy like Nginx or use a cloud load balancer to handle SSL termination, and enable the `trust proxy` setting in Express if deploying behind a proxy:
   ```javascript
   app.set('trust proxy', 1);
   ```
3. **Process Managers**: Run the application under a process manager like **PM2** to ensure automatic restarts on crashes:
   ```bash
   pm2 start src/app.js --name "powerbi-backend"
   ```
4. **CORS Configuration**: Explicitly set the `FRONTEND_URL` in your production environment variables to your hosted frontend domain (e.g., `https://migrator.acmecorp.com`) to restrict unauthorized domain access.
