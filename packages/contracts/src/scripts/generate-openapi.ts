import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildOpenApiDocument } from "../openapi.js";

const here = dirname(fileURLToPath(import.meta.url));
const outputPath = resolve(here, "../../../api-client/openapi.json");

async function main(): Promise<void> {
  const document = buildOpenApiDocument();
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  process.stdout.write(`OpenAPI written to ${outputPath}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
