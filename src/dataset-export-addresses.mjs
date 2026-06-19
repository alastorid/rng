#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  RECORD_SIZE,
  ensureDirFor,
  hash160ToAddresses,
  parseArgs,
  readRecord
} from './dataset-lib.mjs';

function usage() {
  return `
Export manual-check CSV from local hash160 dataset

Usage:
  node src/dataset-export-addresses.mjs --dataset data/address_dataset.bin --out data/address_balances.csv

Output columns:
  hash160,address_type,address,balance_sats,explorer_url
`;
}

function csvEscape(value) {
  const text = String(value);
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

function explorerUrl(address, network) {
  const base = network === 'mainnet'
    ? 'https://blockstream.info/address/'
    : 'https://blockstream.info/testnet/address/';
  return `${base}${address}`;
}

function main() {
  const args = parseArgs(process.argv.slice(2), {
    dataset: 'data/address_dataset.bin',
    out: 'data/address_balances.csv',
    network: 'mainnet'
  });
  if (args.help) {
    console.log(usage().trim());
    return;
  }

  const dataset = path.resolve(args.dataset);
  const out = path.resolve(args.out);
  const buffer = fs.readFileSync(dataset);
  const count = Math.floor(buffer.length / RECORD_SIZE);
  const lines = ['hash160,address_type,address,balance_sats,explorer_url'];

  for (let i = 0; i < count; i += 1) {
    const record = readRecord(buffer, i);
    for (const candidate of hash160ToAddresses(record.hash160, args.network)) {
      lines.push([
        record.hash160,
        candidate.addressType,
        candidate.address,
        record.balanceSats.toString(),
        explorerUrl(candidate.address, args.network)
      ].map(csvEscape).join(','));
    }
  }

  ensureDirFor(out);
  fs.writeFileSync(out, `${lines.join('\n')}\n`);
  console.log(`Wrote ${count * 2} address rows to ${out}`);
}

main();
