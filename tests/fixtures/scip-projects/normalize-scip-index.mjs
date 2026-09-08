import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fromBinary, toBinary } from '@bufbuild/protobuf';
import {
  DocumentSchema,
  IndexSchema,
  OccurrenceSchema,
  SymbolInformationSchema,
} from '../../../dist/scip/scip_pb.js';

const [indexPath] = process.argv.slice(2);
if (!indexPath) {
  throw new Error('usage: node normalize-scip-index.mjs <index.scip>');
}

const index = fromBinary(IndexSchema, fs.readFileSync(indexPath));
if (!index.metadata) {
  throw new Error(`SCIP index has no metadata: ${indexPath}`);
}

// scip-clang records absolute invocation and checkout paths. They do not
// affect document semantics, so canonicalize them to make committed fixture
// bytes reproducible from any checkout.
index.metadata.projectRoot = '.';
if (index.metadata.toolInfo) {
  index.metadata.toolInfo.arguments = [];
}

const compareBytes = (left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right));
const compareText = (left, right) => Buffer.compare(
  Buffer.from(left, 'utf8'),
  Buffer.from(right, 'utf8'),
);
const compareMessages = (schema) => (left, right) => compareBytes(
  toBinary(schema, left),
  toBinary(schema, right),
);
const compareSymbols = (left, right) => compareText(left.symbol, right.symbol)
  || compareMessages(SymbolInformationSchema)(left, right);
const compareRelationships = (left, right) => compareText(left.symbol, right.symbol)
  || Number(left.isReference) - Number(right.isReference)
  || Number(left.isImplementation) - Number(right.isImplementation)
  || Number(left.isTypeDefinition) - Number(right.isTypeDefinition)
  || Number(left.isDefinition) - Number(right.isDefinition);

for (const document of index.documents) {
  for (const symbol of document.symbols) {
    symbol.relationships.sort(compareRelationships);
  }
  document.occurrences.sort(compareMessages(OccurrenceSchema));
  document.symbols.sort(compareSymbols);
}
index.documents.sort((left, right) => compareText(left.relativePath, right.relativePath)
  || compareMessages(DocumentSchema)(left, right));
for (const symbol of index.externalSymbols) {
  symbol.relationships.sort(compareRelationships);
}
index.externalSymbols.sort(compareSymbols);

const normalized = toBinary(IndexSchema, index);
const tempPath = path.join(
  path.dirname(indexPath),
  `.${path.basename(indexPath)}.${process.pid}.${randomUUID()}.tmp`,
);
try {
  fs.writeFileSync(tempPath, normalized, { flag: 'wx' });
  const fd = fs.openSync(tempPath, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tempPath, indexPath);
} finally {
  fs.rmSync(tempPath, { force: true });
}