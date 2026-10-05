import { cp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const publicDir = resolve(projectRoot, "public");
const buildPublicDir = resolve(projectRoot, "build", "public");

await mkdir(buildPublicDir, { recursive: true });

for (const file of ["index.html", "styles.css", "favicon.svg"]) {
  await cp(resolve(publicDir, file), resolve(buildPublicDir, file));
}
