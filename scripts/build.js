import { readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");
const commandsSource = join(root, "src/commands");

await rm(dist, { recursive: true, force: true });

const commandEntrypoints = (await readdir(commandsSource))
  .filter((name) => name.endsWith(".js"))
  .map((name) => join(commandsSource, name));

const commonOptions = {
  target: "bun",
  minify: true,
  sourcemap: "none",
};

const npmLauncher = await Bun.build({
  entrypoints: [join(root, "bin/npm.js")],
  outdir: join(dist, "bin"),
  target: "node",
  minify: true,
  sourcemap: "none",
});

const runtimeLauncher = await Bun.build({
  ...commonOptions,
  entrypoints: [join(root, "bin/bnu.js")],
  outdir: join(dist, "runtime"),
});

const commands = await Bun.build({
  ...commonOptions,
  entrypoints: commandEntrypoints,
  outdir: join(dist, "commands"),
  root: commandsSource,
  splitting: false,
});

if (!npmLauncher.success || !runtimeLauncher.success || !commands.success) {
  for (const log of [...npmLauncher.logs, ...runtimeLauncher.logs, ...commands.logs]) console.error(log);
  process.exit(1);
}
