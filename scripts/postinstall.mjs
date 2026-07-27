if (!process.env.CI) {
  process.stdout.write(`
Harness Conda installed.

Initialize shell integration:
  harness init

Then restart your shell.

`);
}
