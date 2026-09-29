if (!process.env.CI) {
  process.stdout.write(`
Woma installed.

Enable woma activate/deactivate in your shell:
  woma init

Then open a new shell and create an environment:
  woma create -n research claude codex

`);
}
