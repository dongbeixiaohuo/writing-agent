#!/usr/bin/env node

import process from "node:process";
import { fileURLToPath } from "node:url";
import { inspectNavigationUrl } from "./remote_url_policy.js";

export async function main(argv = process.argv.slice(2)) {
  const [value] = argv;
  if (!value) {
    console.error("Usage: node validate_remote_url.js <http-or-https-url>");
    return 2;
  }

  try {
    const result = await inspectNavigationUrl(value);
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    console.error(`Unsafe remote URL: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

const entryPath = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (entryPath) {
  process.exitCode = await main();
}
