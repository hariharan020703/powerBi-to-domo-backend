import axios from 'axios';

let _cachedCookie = null;
let _cachedCsrfToken = null;
let _cookieExpiresAt = 0;
let _cachedRequestContext = null;

function parseCookieHeaders(setCookieHeaders) {
  const map = new Map();
  for (const raw of setCookieHeaders || []) {
    const pair = raw.split(';')[0].trim();
    const eqIdx = pair.indexOf('=');
    if (eqIdx > 0) {
      const name = pair.substring(0, eqIdx);
      map.set(name, pair);
    }
  }
  return map;
}

function cookieMapToString(map) {
  return [...map.values()].join('; ');
}

export function getCachedRequestContext() {
  return _cachedRequestContext;
}

export async function getAutomatedDomoCookie() {
  const now = Date.now();
  if (_cachedCookie && now < _cookieExpiresAt) {
    console.log('[COOKIE SERVICE] Using cached Domo cookie.');
    return _cachedCookie;
  }

  const domain = (process.env.DOMO_CLIENT_DOMAIN || '').trim();
  const email = (process.env.DOMO_LOGIN_EMAIL || '').trim();
  const password = (process.env.DOMO_LOGIN_PASSWORD || '').trim();

  if (!domain || !email || !password) {
    console.error('[COOKIE SERVICE] DOMO_CLIENT_DOMAIN, DOMO_LOGIN_EMAIL, DOMO_LOGIN_PASSWORD must all be set.');
    return null;
  }

  console.log('[COOKIE SERVICE] Logging into Domo via HTTP to obtain session cookie...');

  try {
    // ── Step 1: GET login page to collect initial session cookies ────────────
    const initRes = await axios.get(`https://${domain}/auth/index?login`, {
      maxRedirects: 5,
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });

    const cookieJar = parseCookieHeaders(initRes.headers['set-cookie']);
    console.log('[COOKIE SERVICE] Init cookies:', cookieMapToString(cookieJar) || 'none');

    // ── Step 2: POST login with init cookies ────────────────────────────────
    const loginUrl = `https://${domain}/api/domoweb/auth/login`;
    console.log(`[COOKIE SERVICE] Trying: POST ${loginUrl}`);

    const loginRes = await axios.post(loginUrl, { username: email, password }, {
      maxRedirects: 0,                              // don't follow — capture cookies first
      validateStatus: s => s < 400 || s === 302,    // treat 302 as success
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Referer': `https://${domain}/auth/index?login`,
        'Origin': `https://${domain}`,
        'Cookie': cookieMapToString(cookieJar),
      },
    });

    console.log(`[COOKIE SERVICE] ✅ Login response: status ${loginRes.status}`);
    console.log('[COOKIE SERVICE] Response data:', JSON.stringify(loginRes.data)?.slice(0, 300));

    // Merge login cookies INTO the jar (overrides init cookies with same name)
    const loginCookieMap = parseCookieHeaders(loginRes.headers['set-cookie']);
    console.log('[COOKIE SERVICE] Login set-cookie:', cookieMapToString(loginCookieMap) || 'none');
    for (const [name, pair] of loginCookieMap) {
      cookieJar.set(name, pair);
    }

    // ── Step 3: If the login returned a redirect, follow it to collect more cookies
    if (loginRes.status === 302 && loginRes.headers['location']) {
      const redirectUrl = loginRes.headers['location'].startsWith('http')
        ? loginRes.headers['location']
        : `https://${domain}${loginRes.headers['location']}`;

      console.log(`[COOKIE SERVICE] Following redirect: ${redirectUrl}`);
      const redirectRes = await axios.get(redirectUrl, {
        maxRedirects: 5,
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
          'Cookie': cookieMapToString(cookieJar),
        },
      });

      const redirectCookies = parseCookieHeaders(redirectRes.headers['set-cookie']);
      for (const [name, pair] of redirectCookies) {
        cookieJar.set(name, pair);
      }
    }

    // ── Final: serialize deduplicated cookie jar ────────────────────────────
    const finalCookies = cookieMapToString(cookieJar);

    if (!finalCookies) {
      console.error('[COOKIE SERVICE] No cookies after login flow.');
      return null;
    }

    // ── Step 4: Verify the session is actually authenticated ────────────────
    try {
      const verifyRes = await axios.get(`https://${domain}/api/content/v1/cards?limit=1`, {
        timeout: 10000,
        validateStatus: () => true,
        headers: {
          'Cookie': finalCookies,
          'Accept': 'application/json',
        },
      });
      console.log(`[COOKIE SERVICE] Session verification: HTTP ${verifyRes.status}`);
      if (verifyRes.status === 401 || verifyRes.status === 403) {
        console.error('[COOKIE SERVICE] Session cookie is NOT authenticated despite login success. Cookie:', finalCookies.slice(0, 80));
        return null;
      }
    } catch (verifyErr) {
      console.warn('[COOKIE SERVICE] Session verification request failed:', verifyErr.message);
      // Continue anyway — the cookie might still work for POST
    }

    _cachedCookie = finalCookies;
    _cookieExpiresAt = now + 50 * 60 * 1000;

    // Extract the CSRF token — required as a header for POST/PUT/DELETE
    const csrfPair = cookieJar.get('csrf-token');      // "csrf-token=xxxx"
    _cachedCsrfToken = csrfPair ? csrfPair.split('=').slice(1).join('=') : null;
    console.log('[COOKIE SERVICE] CSRF token:', _cachedCsrfToken ? `${_cachedCsrfToken.slice(0, 12)}...` : 'NOT FOUND');

    // Extract SESSION_TOE to build x-domo-requestcontext
    const toePair = cookieJar.get('SESSION_TOE');
    const sessionToe = toePair ? toePair.split('=').slice(1).join('=') : 'UNKNOWN';
    _cachedRequestContext = JSON.stringify({ clientToe: `${sessionToe}-AUTO` });
    console.log('[COOKIE SERVICE] Request context:', _cachedRequestContext);

    console.log('[COOKIE SERVICE] Successfully obtained authenticated Domo session cookie.');
    console.log('[COOKIE SERVICE] Cookie names:', [...cookieJar.keys()].join(', '));
    return _cachedCookie;

  } catch (err) {
    const status = err.response?.status;
    const detail = JSON.stringify(err.response?.data ?? err.message);
    console.error(`[COOKIE SERVICE] HTTP login failed (HTTP ${status ?? 'N/A'}): ${detail}`);
    return null;
  }
}

export function resetDomoCookieCache() {
  _cachedCookie = null;
  _cachedCsrfToken = null;
  _cachedRequestContext = null;
  _cookieExpiresAt = 0;
}

export function getCachedCsrfToken() {
  return _cachedCsrfToken;
}