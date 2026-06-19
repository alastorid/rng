#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  RECORD_SIZE,
  datasetStats,
  ensureDirFor,
  fileSha256,
  formatBigIntJson,
  normalizeHash160,
  parseArgs,
  parseBalance,
  storageStats,
  writeManifest,
  writeRecord
} from './dataset-lib.mjs';

function usage() {
  return `
Build local Bitcoin address dataset

Input CSV:
  hash160,balance_sats
  00112233445566778899aabbccddeeff00112233,150000

Usage:
  node src/dataset-build.mjs --input data/address_dataset.csv --out data/address_dataset.bin
`;
}

function parseCsv(file) {
  const text = fs.readFileSync(file, 'utf8');
  const aggregate = new Map();
  let lineNo = 0;

  for (const line of text.split(/\r?\n/)) {
    lineNo += 1;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (lineNo === 1 && trimmed.toLowerCase() === 'hash160,balance_sats') continue;

    const [hashRaw, balanceRaw, extra] = trimmed.split(',');
    if (extra !== undefined || !hashRaw || !balanceRaw) {
      throw new Error(`Invalid CSV line ${lineNo}: ${line}`);
    }
    const hash160 = normalizeHash160(hashRaw);
    const balance = parseBalance(balanceRaw);
    if (balance === 0n) continue;
    aggregate.set(hash160, (aggregate.get(hash160) ?? 0n) + balance);
  }

  return [...aggregate.entries()]
    .map(([hash160, balanceSats]) => ({ hash160, balanceSats }))
    .sort((a, b) => a.hash160.localeCompare(b.hash160));
}

function main() {
  const args = parseArgs(process.argv.slice(2), {
    input: 'data/address_dataset.csv',
    out: 'data/address_dataset.bin'
  });
  if (args.help) {
    console.log(usage().trim());
    return;
  }

  const input = path.resolve(args.input);
  const out = path.resolve(args.out);
  const manifestFile = `${out}.manifest.json`;

  const records = parseCsv(input);
  const buffer = Buffer.alloc(records.length * RECORD_SIZE);
  records.forEach((record, index) => {
    writeRecord(buffer, index * RECORD_SIZE, record.hash160, record.balanceSats);
  });

  ensureDirFor(out);
  fs.writeFileSync(out, buffer);

  const stats = datasetStats(records);
  const manifest = {
    createdAt: new Date().toISOString(),
    input,
    output: out,
    format: 'sorted fixed-width binary records: 20-byte hash160 + uint64_be balance_sats',
    recordSizeBytes: RECORD_SIZE,
    datasetSha256: fileSha256(out),
    datasetSize: storageStats(out),
    ...stats
  };

  writeManifest(manifestFile, manifest);
  console.log(JSON.stringify(manifest, formatBigIntJson, 2));
  console.log(`Manifest: ${manifestFile}`);
}

main();
