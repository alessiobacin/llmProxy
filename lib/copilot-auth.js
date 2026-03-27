const CLIENT_ID = "Ov23li8tweQw6odWQebz";
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";

async function startDeviceFlow(options = {}) {
  const fetchFn = options.fetchFn || fetch;
  const response = await fetchFn(DEVICE_CODE_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "llmproxy/0.1.0",
    },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      scope: "read:user",
    }),
  });

  if (!response.ok) {
    const errorText = typeof response.text === "function" ? await response.text() : "request_failed";
    throw new Error(`Device code request failed (${response.status}): ${errorText}`);
  }

  return response.json();
}

async function pollForToken(deviceCode, interval, options = {}) {
  const fetchFn = options.fetchFn || fetch;
  const store = options.store;
  const sleep = options.sleep || ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  const parsedInterval = Number(interval);
  let effectiveInterval = Number.isFinite(parsedInterval) && parsedInterval >= 0 ? parsedInterval : 5;

  while (true) {
    await sleep(Math.max(0, effectiveInterval + 1) * 1000);

    const response = await fetchFn(ACCESS_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "llmproxy/0.1.0",
      },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });

    if (!response.ok) {
      return { success: false, error: "request_failed" };
    }

    const payload = await response.json();

    if (payload.access_token) {
      const data = {
        access_token: payload.access_token,
        token_type: payload.token_type || "bearer",
        scope: payload.scope || "read:user",
        created_at: Date.now(),
      };
      if (store?.save) store.save(data);
      return { success: true, token: data };
    }

    if (payload.error === "authorization_pending") {
      continue;
    }

    if (payload.error === "slow_down") {
      effectiveInterval += 5;
      continue;
    }

    return { success: false, error: payload.error || "unknown_error" };
  }
}

module.exports = {
  CLIENT_ID,
  DEVICE_CODE_URL,
  ACCESS_TOKEN_URL,
  startDeviceFlow,
  pollForToken,
};