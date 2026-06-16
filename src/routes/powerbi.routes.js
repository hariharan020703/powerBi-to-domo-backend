import { Router } from 'express';
import {
  getWorkspaces,
  getDatasets,
  getReports,
  getDashboards,
  getDashboardTiles,
  executeQuery
} from '../services/powerbiService.js';

const router = Router();

/**
 * Utility helper to wrap async route handlers and forward exceptions to Express error handler.
 */
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

/**
 * GET /api/powerbi/workspaces
 * Fetches workspaces (groups) for the authenticated credentials.
 */
router.get('/workspaces', asyncHandler(async (req, res) => {
  const workspaces = await getWorkspaces();
  res.status(200).json(workspaces);
}));

/**
 * GET /api/powerbi/workspaces/:groupId/datasets
 * Fetches the list of datasets inside the given workspace.
 */
router.get('/workspaces/:groupId/datasets', asyncHandler(async (req, res) => {
  const { groupId } = req.params;
  const datasets = await getDatasets(groupId);
  res.status(200).json(datasets);
}));

/**
 * GET /api/powerbi/workspaces/:groupId/reports
 * Fetches the list of reports inside the given workspace.
 */
router.get('/workspaces/:groupId/reports', asyncHandler(async (req, res) => {
  const { groupId } = req.params;
  const reports = await getReports(groupId);
  res.status(200).json(reports);
}));

/**
 * GET /api/powerbi/workspaces/:groupId/dashboards
 * Fetches the list of dashboards inside the given workspace.
 */
router.get('/workspaces/:groupId/dashboards', asyncHandler(async (req, res) => {
  const { groupId } = req.params;
  const dashboards = await getDashboards(groupId);
  res.status(200).json(dashboards);
}));

/**
 * GET /api/powerbi/workspaces/:groupId/dashboards/:dashboardId/tiles
 * Fetches the list of tiles inside the given dashboard.
 */
router.get('/workspaces/:groupId/dashboards/:dashboardId/tiles', asyncHandler(async (req, res) => {
  const { groupId, dashboardId } = req.params;
  const tiles = await getDashboardTiles(groupId, dashboardId);
  res.status(200).json(tiles);
}));


/**
 * POST /api/powerbi/datasets/:datasetId/query
 * Executes a DAX query on a dataset.
 * Accepts body structure: { "query": "EVALUATE 'TableName'", "serializerSettings": { "includeNulls": true } }
 */
router.post('/datasets/:datasetId/query', asyncHandler(async (req, res) => {
  const { datasetId } = req.params;
  const { query, serializerSettings } = req.body;
  const result = await executeQuery(datasetId, query, serializerSettings);
  res.status(200).json(result);
}));

export default router;
