// Backfill coding_score for all existing providers
// Usage: node scripts/backfill-coding-scores.js

const path = require("path");
const { createTokenStore } = require("../lib/token-store");
const { fetchCodingScore } = require("../lib/cloudprice-client");

const RUNTIME_ROOT =
  process.env.LLMPROXY_DATA_ROOT ||
  path.join(
    process.env.HOME,
    "Library/Application Support/llmProxy"
  );

async function main() {
  const tokenPath = path.join(RUNTIME_ROOT, "copilot-token.json");
  const store = createTokenStore({ filePath: tokenPath });
  const providers = store.listProviders();

  console.log(`Found ${providers.length} providers. Backfilling coding_score...\n`);

  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const provider of providers) {
    const model = provider.default_model;
    if (!model) {
      console.log(`  ⏭  ${provider.id}: no default_model, skipped`);
      skipped++;
      continue;
    }

    if (typeof provider.coding_score === "number") {
      console.log(`  ✔ ${provider.id} (${model}): already has score ${provider.coding_score}`);
      skipped++;
      continue;
    }

    const spinner = `  ℹ ${provider.id} (${model}): fetching...`;
    process.stdout.write(spinner);

    try {
      const score = await fetchCodingScore(model, fetch);
      if (score != null && Number.isFinite(score)) {
        store.saveProvider(provider.id, { coding_score: score });
        process.stdout.write(`\r  ✔ ${provider.id} (${model}): coding_score=${score}\n`);
        updated++;
      } else {
        process.stdout.write(`\r  ⚠ ${provider.id} (${model}): no score returned from API\n`);
        skipped++;
      }
    } catch (err) {
      process.stdout.write(`\r  ✗ ${provider.id} (${model}): ${err.message}\n`);
      failed++;
    }
  }

  console.log(
    `\nDone. Updated=${updated}, Skipped=${skipped}, Failed=${failed}`
  );
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
