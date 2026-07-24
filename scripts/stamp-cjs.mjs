// Marks each package's dist/cjs output as CommonJS. The packages are
// "type": "module", so without this nested package.json Node would parse
// the CJS build as ESM and require() would fail.
import { writeFile } from "node:fs/promises";

for (const name of ["server", "client", "next", "conform"]) {
  await writeFile(
    new URL(`../packages/${name}/dist/cjs/package.json`, import.meta.url),
    JSON.stringify({ type: "commonjs" }) + "\n",
  );
}
