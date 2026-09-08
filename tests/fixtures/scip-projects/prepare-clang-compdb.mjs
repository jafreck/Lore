import fs from 'node:fs';
import path from 'node:path';

const [inputPath, outputPath, projectPath] = process.argv.slice(2);
if (!inputPath || !outputPath || !projectPath) {
  throw new Error('usage: node prepare-clang-compdb.mjs <input> <output> <project-root>');
}

const projectRoot = path.resolve(projectPath);
const entries = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
if (!Array.isArray(entries)) {
  throw new Error('fixture compilation database must contain an array');
}

for (const entry of entries) {
  if (!entry || typeof entry !== 'object' || typeof entry.file !== 'string') {
    throw new Error('fixture compilation database contains an invalid entry');
  }
  const workingDirectory = path.resolve(projectRoot, entry.directory ?? '.');
  entry.directory = workingDirectory;
  entry.file = path.isAbsolute(entry.file)
    ? entry.file
    : path.resolve(workingDirectory, entry.file);
}

fs.writeFileSync(outputPath, `${JSON.stringify(entries, null, 2)}\n`);