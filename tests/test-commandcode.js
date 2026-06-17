const { probeApiKeyProviderModel } = require("./lib/copilot-proxy");

const apiKey = "user_35n4S32aVTqgeadEW4ygx2zdtVs8sf7vwWoevkV5cWRcK6YTmfZTy8RWQJrfZqfXdCVvs55YNhDZq95f2VSY6J5W";
const provider = { provider: "commandcode" };

async function test() {
  console.log("🔄 Testing Command Code provider with API key...");
  const result = await probeApiKeyProviderModel({
    provider,
    apiKey,
    model: "deepseek/deepseek-v4-flash",
    fetchFn: fetch,
  });

  if (result.ok) {
    console.log("✅ SUCCESS: Command Code API is reachable and authenticated.");
    console.log("Response:", result);
  } else {
    console.error("❌ FAILED: Command Code API test failed.");
    console.error("Status:", result.status);
    console.error("Error:", result.error);
  }
}

test().catch(console.error);
