#!/usr/bin/env node

const main = new URL("./cli-main.js", import.meta.url);
// Preserve cache-busting queries used by embedded CLI callers.
main.search = new URL(import.meta.url).search;
await import(main.href);
