#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  ensureDirFor,
  parseArgs,
  writeManifest
} from './dataset-lib.mjs';

function usage() {
  return `
Export aggregate real script dataset from the Bitcoin UTXO SQLite database.

Usage:
  npm run utxo:export -- --db data/bitcoin-utxo.sqlite --out data/real-script_dataset.csv
`;
}

function csvEscape(value) {
  const text = String(value);
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

function formatBtc(sats) {
  const value = BigInt(sats);
  const whole = value / 100_000_000n;
  const fraction = (value % 100_000_000n).toString().padStart(8, '0');
  return `${whole}.${fraction}`;
}

function explorerUrl(address) {
  return `https://blockstream.info/address/${address}`;
}

function main() {
  const args = parseArgs(process.argv.slice(2), {
    db: 'data/bitcoin-utxo.sqlite',
    out: 'data/real-script_dataset.csv'
  });
  if (args.help) {
    console.log(usage().trim());
    return;
  }

  const dbFile = path.resolve(args.db);
  const out = path.resolve(args.out);
  const db = new DatabaseSync(dbFile);
  const query = db.prepare(`
    SELECT
      script_key,
      address_type,
      MIN(address) AS address,
      SUM(value_sats) AS balance_sats,
      COUNT(*) AS utxo_count
    FROM utxos
    GROUP BY address_type, script_key
    HAVING balance_sats > 0
    ORDER BY script_key
  `);

  ensureDirFor(out);
  const stream = fs.createWriteStream(out);
  stream.write('script_key,address_type,address,balance_sats,balance_btc,explorer_url,source\n');

  let count = 0;
  let totalBalanceSats = 0n;
  let maxBalanceSats = 0n;
  for (const row of query.iterate()) {
    const balance = BigInt(row.balance_sats);
    totalBalanceSats += balance;
    if (balance > maxBalanceSats) maxBalanceSats = balance;
    count += 1;
    stream.write([
      row.script_key,
      row.address_type,
      row.address,
      balance.toString(),
      formatBtc(balance),
      explorerUrl(row.address),
      `bitcoin-core-utxo-sqlite-utxos-${row.utxo_count}`
    ].map(csvEscape).join(','));
    stream.write('\n');
  }
  stream.end();

  stream.on('finish', () => {
    const metaRows = db.prepare('SELECT key, value FROM meta ORDER BY key').all();
    writeManifest(`${out}.manifest.json`, {
      createdAt: new Date().toISOString(),
      input: dbFile,
      output: out,
      source: 'Bitcoin Core block scan -> SQLite live UTXO set -> aggregate by script key',
      recordCount: count,
      totalBalanceSats,
      maxBalanceSats,
      bitcoinCoreMeta: Object.fromEntries(metaRows.map((row) => [row.key, row.value]))
    });
    console.log(`Exported ${count} real funded script records to ${out}`);
  });
}

main();
