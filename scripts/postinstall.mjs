if (!process.env.CI) {
  process.stdout.write(`
Woma installed.

Initialize shell integration:
  woma init

Then restart your shell.

`);
}
