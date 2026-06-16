import axios from 'axios';
import { env } from '../config/env.js';

let cachedToken = null;
let expiryTime = null;
let refreshTimeout = null;
let fetchPromise = null;

/**
 * Fetches a new Bearer token from Azure AD OAuth2 Client Credentials endpoint.
 */
async function fetchToken() {
  const { azureTenantId, azureClientId, azureClientSecret, powerBiScope } = env;
  
  if (!azureTenantId || !azureClientId || !azureClientSecret) {
    throw new Error('Azure AD credentials are not fully configured in environment variables.');
  }

  const url = `https://login.microsoftonline.com/${azureTenantId}/oauth2/v2.0/token`;
  
  const params = new URLSearchParams();
  params.append('grant_type', 'client_credentials');
  params.append('client_id', azureClientId);
  params.append('client_secret', azureClientSecret);
  params.append('scope', powerBiScope);

  console.log('[AUTH] Fetching new access token from Azure AD...');
  
  const response = await axios.post(url, params, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  });

  const { access_token, expires_in } = response.data;
  if (!access_token) {
    throw new Error('No access token received from Azure AD.');
  }

  cachedToken = access_token;
  const expiresInMs = (expires_in || 3600) * 1000;
  expiryTime = Date.now() + expiresInMs;

  console.log(`[AUTH] Access token fetched successfully. Expires in ${expires_in}s.`);

  // Schedule auto-refresh 5 minutes (300 seconds) before expiry
  const refreshDelay = expiresInMs - (5 * 60 * 1000);
  scheduleRefresh(refreshDelay > 0 ? refreshDelay : 1000);

  return cachedToken;
}

/**
 * Schedules a background refresh timer.
 */
function scheduleRefresh(delayMs) {
  if (refreshTimeout) {
    clearTimeout(refreshTimeout);
  }
  
  console.log(`[AUTH] Scheduling token auto-refresh in ${(delayMs / 1000).toFixed(0)}s`);
  refreshTimeout = setTimeout(async () => {
    try {
      fetchPromise = fetchToken();
      await fetchPromise;
    } catch (err) {
      console.error('[AUTH ERROR] Token auto-refresh failed:', err.message);
      // Retry refresh in 30 seconds if it fails
      scheduleRefresh(30000);
    } finally {
      fetchPromise = null;
    }
  }, delayMs);
}

/**
 * Retrieves the current valid Access Token (from cache or via AAD).
 */
export async function getAccessToken() {
  // If we have a cached token and it is valid (with at least 1 minute buffer remaining)
  if (cachedToken && expiryTime && Date.now() < (expiryTime - 60000)) {
    return cachedToken;
  }

  // If a fetch is currently in progress, wait for it
  if (fetchPromise) {
    return fetchPromise;
  }

  try {
    fetchPromise = fetchToken();
    const token = await fetchPromise;
    return token;
  } finally {
    fetchPromise = null;
  }
}

/**
 * Clears the cache and timeouts (mainly for teardown or manual reset).
 */
export function clearCache() {
  if (refreshTimeout) {
    clearTimeout(refreshTimeout);
    refreshTimeout = null;
  }
  cachedToken = null;
  expiryTime = null;
  fetchPromise = null;
}
