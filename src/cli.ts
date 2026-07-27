#!/usr/bin/env node
import { renderShellHook, resolveShell } from "./shell.js";

interface ShellHookRequest {
  shell?: string;
}

function shellHookRequest(args: string[]): ShellHookRequest | undefined {
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "-p" || argument === "--project") {
      if (index + 1 >= args.length) return undefined;
      index += 1;
      continue;
    }
    if (argument.startsWith("--project=") && argument.length > "--project=".length) continue;
    if (argument.startsWith("-p") && argument.length > 2) continue;
    positional.push(argument);
  }

  if (
    positional[0] !== "shell" ||
    positional[1] !== "hook" ||
    positional.length > 3 ||
    positional[2]?.startsWith("-")
  ) return undefined;
  return positional[2] === undefined ? {} : { shell: positional[2] };
}

const request = shellHookRequest(process.argv.slice(2));
if (request) {
  try {
    process.stdout.write(renderShellHook(resolveShell(request.shell)));
  } catch (error) {
    console.error(`harness: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
} else {
  // Keep ordinary shell startup independent from Commander and the Environment/Package graph.
  const main = new URL("./cli-main.js", import.meta.url);
  // Preserve cache-busting queries used by embedded CLI callers.
  main.search = new URL(import.meta.url).search;
  await import(main.href);
}
