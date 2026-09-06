import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildPostmanArtifacts,
  listGeneratedPostmanFiles,
  stringifyPostmanArtifact,
} from "./postman.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const insomniaDir = join(rootDir, "insomnia");
const postmanDir = join(rootDir, "postman");
const checkOnly = process.argv.includes("--check");
const artifacts = buildPostmanArtifacts(insomniaDir);
const expectedFiles = [...artifacts.keys()].sort();

if (checkOnly) {
  const errors = [];
  for (const [relativePath, artifact] of artifacts) {
    const outputPath = join(postmanDir, relativePath);
    const expected = stringifyPostmanArtifact(artifact);
    if (!existsSync(outputPath)) {
      errors.push(
        `Missing generated Postman artifact: postman/${relativePath}`,
      );
    } else if (readFileSync(outputPath, "utf8") !== expected) {
      errors.push(`Stale generated Postman artifact: postman/${relativePath}`);
    }
  }

  if (existsSync(postmanDir)) {
    for (const relativePath of listGeneratedPostmanFiles(postmanDir)) {
      if (!artifacts.has(relativePath)) {
        errors.push(
          `Unexpected generated Postman artifact: postman/${relativePath}`,
        );
      }
    }
  }

  if (errors.length > 0) {
    console.error(`${errors.join("\n")}\n\nRun npm run postman:generate.`);
    process.exitCode = 1;
  } else {
    console.log(
      `All ${expectedFiles.length} Postman artifacts match Insomnia.`,
    );
  }
} else {
  for (const [relativePath, artifact] of artifacts) {
    const outputPath = join(postmanDir, relativePath);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, stringifyPostmanArtifact(artifact));
  }
  console.log(
    `Generated ${expectedFiles.length} Postman artifacts from Insomnia.`,
  );
}
