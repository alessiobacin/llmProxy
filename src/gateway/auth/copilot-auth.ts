// V11 Copilot auth — GitHub device-flow OAuth for Copilot provider.
// This is a legacy compatibility module. Provider auth should
// eventually be governed by auth-gateway.

const CLIENT_ID = "Ov23li8tweQw6odWQebz";
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";

interface DeviceFlowResult {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface TokenData {
  access_token: string;
  token_type: string;
  scope: string;
  created_at: number;
}

interface PollResult {
  success: boolean;
  token?: TokenData;
  error?: string;
}

interface DeviceFlowOptions {
  fetchFn?: typeof fetch;
}

interface PollOptions {
  fetchFn?: typeof fetch;
  store?: { save: (data: TokenData) => void } | null;
  sleep?: (ms: number) => Promise<void>;
}

async function startDeviceFlow(options: DeviceFlowOptions = {}): Promise<DeviceFlowResult> {
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

  return response.json() as Promise<DeviceFlowResult>;
}

async function pollForToken(
  deviceCode: string,
  interval: number,
  options: PollOptions = {},
): Promise<PollResult> {
  const fetchFn = options.fetchFn || fetch;
  const store = options.store;
  const sleep = options.sleep || ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));

  let effectiveInterval = Number.isFinite(Number(interval)) && Number(interval) >= 0 ? Number(interval) : 5;

  // eslint-disable-next-line no-constant-condition
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

    const payload = (await response.json()) as Record<string, unknown>;

    if (payload.access_token) {
      const data: TokenData = {
        access_token: payload.access_token as string,
        token_type: (payload.token_type as string) || "bearer",
        scope: (payload.scope as string) || "read:user",
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

    return { success: false, error: (payload.error as string) || "unknown_error" };
  }
}

export {
  CLIENT_ID,
  DEVICE_CODE_URL,
  ACCESS_TOKEN_URL,
  startDeviceFlow,
  pollForToken,
};

export type {
  DeviceFlowResult,
  TokenData,
  PollResult,
  DeviceFlowOptions,
  PollOptions,
};
