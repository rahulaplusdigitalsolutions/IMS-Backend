const DEFAULT_LOGIN_URL = "https://ltl-clients-api.delhivery.com/ums/login";

function setupDelhiveryRoutes(app, requireAuth) {
  let cachedAuth = null;

  function getConfig() {
    return {
      loginUrl: process.env.DELHIVERY_LOGIN_URL || DEFAULT_LOGIN_URL,
      username: process.env.DELHIVERY_USERNAME,
      password: process.env.DELHIVERY_PASSWORD,
    };
  }

  function extractToken(payload) {
    if (!payload || typeof payload !== "object") return null;
    return (
      payload.token ||
      payload.access_token ||
      payload.accessToken ||
      payload.jwt ||
      payload.data?.token ||
      payload.data?.access_token ||
      payload.data?.accessToken ||
      payload.data?.jwt ||
      null
    );
  }

  function sanitizeLoginResponse(payload) {
    if (!payload || typeof payload !== "object") return payload;
    const json = JSON.parse(JSON.stringify(payload));
    const scrub = (obj) => {
      if (!obj || typeof obj !== "object") return;
      for (const key of Object.keys(obj)) {
        if (/token|jwt|password|secret/i.test(key)) {
          obj[key] = "[hidden]";
        } else {
          scrub(obj[key]);
        }
      }
    };
    scrub(json);
    return json;
  }

  async function loginToDelhivery({ force = false } = {}) {
    if (!force && cachedAuth?.token) return cachedAuth;

    const config = getConfig();
    if (!config.username || !config.password) {
      throw new Error("DELHIVERY_USERNAME and DELHIVERY_PASSWORD are required in backend environment.");
    }

    const response = await fetch(config.loginUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: config.username,
        password: config.password,
      }),
    });

    const text = await response.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { raw: text };
    }

    if (!response.ok) {
      const message = payload?.message || payload?.error || `Delhivery login failed with HTTP ${response.status}`;
      const error = new Error(message);
      error.status = response.status;
      error.payload = sanitizeLoginResponse(payload);
      throw error;
    }

    const token = extractToken(payload);
    if (!token) {
      const error = new Error("Delhivery login succeeded but token was not found in response.");
      error.payload = sanitizeLoginResponse(payload);
      throw error;
    }

    cachedAuth = {
      token,
      loggedInAt: new Date().toISOString(),
      raw: payload,
    };

    return cachedAuth;
  }

  app.post("/api/delhivery/login", requireAuth, async (req, res) => {
    try {
      const auth = await loginToDelhivery({ force: req.body?.force === true });
      res.json({
        message: "Delhivery login successful",
        loggedInAt: auth.loggedInAt,
        tokenAvailable: Boolean(auth.token),
        response: sanitizeLoginResponse(auth.raw),
      });
    } catch (err) {
      res.status(err.status || 500).json({
        message: err.message,
        response: err.payload || null,
      });
    }
  });

  app.get("/api/delhivery/config-status", requireAuth, (req, res) => {
    const config = getConfig();
    res.json({
      loginUrl: config.loginUrl,
      usernameConfigured: Boolean(config.username),
      passwordConfigured: Boolean(config.password),
      tokenCached: Boolean(cachedAuth?.token),
      loggedInAt: cachedAuth?.loggedInAt || null,
    });
  });

  return {
    loginToDelhivery,
    getCachedToken: () => cachedAuth?.token || null,
  };
}

module.exports = { setupDelhiveryRoutes };
