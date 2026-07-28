import { main } from "./shared/runtime.js";

export { commandNames } from "./shared/catalog.js";
export { executeCommand, main } from "./shared/runtime.js";

if (import.meta.main) {
  globalThis[Symbol.for("bnu.cli")] = true;
  process.exit(await main(Bun.argv.slice(2)));
}
