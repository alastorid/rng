#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  binaryLookup,
  formatBigIntJson,
  hashMapLookup,
  loadHashMap,
  parseArgs
} from './dataset-lib.mjs';

function usage() {
  return `
Lookup hash160 in local dataset

Usage:
  node src/dataset-lookup.mjs --dataset data/address_dataset.bin --hash160 <40 hex chars> --mode binary
  node src/dataset-lookup.mjs --dataset data/address_dataset.bin --hash160 <40 hex chars> --mode hashmap
`;
}

function main() {
  const args = parseArgs(process.argv.slice(2), {
    dataset: 'data/address_dataset.bin',
    mode: 'binary'
  });
  if (args.help || !args.hash160) {
    console.log(usage().trim());
    return;
  }
  const buffer = fs.readFileSync(path.resolve(args.dataset));
  const result = args.mode === 'hashmap'
    ? hashMapLookup(loadHashMap(buffer), args.hash160)
    : binaryLookup(buffer, args.hash160);
  console.log(JSON.stringify(result, formatBigIntJson, 2));
}

main();
