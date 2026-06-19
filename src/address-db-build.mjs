#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  ensureDirFor,
  parseArgs,
  parseBalance,
  writeManifest
} from './dataset-lib.mjs';

function usage() {
  return `
Build simple local address balance DB.

Input CSV:
  address,balance_sats,balance_btc,explorer_url,source

Usage:
  npm run address-db:build -- --input data/real-address-balances.csv --db data/real-address-balances.sqlite
`;
}

function main() {
  const args = parseArgs(process.argv.slice(2), {
    input: 'data/real-address-balances.csv',
    db: 'data/real-address-balances.sqlite'
  });
  if (args.help) {
    console.log(usage().trim());
    return;
  }

  const input = path.resolve(args.input);
  const dbFile = path.resolve(args.db);
  ensureDirFor(dbFile);
  if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);

  const db = new DatabaseSync(dbFile);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE address_balances (
      address TEXT PRIMARY KEY,
      balance_sats INTEGER NOT NULL,
      balance_btc TEXT NOT NULL,
      explorer_url TEXT NOT NULL,
      source TEXT NOT NULL
    );
  `);

  const insert = db.prepare(`
    INSERT INTO address_balances(address, balance_sats, balance_btc, explorer_url, source)
    VALUES(?, ?, ?, ?, ?)
  `);
  const text = fs.readFileSync(input, 'utf8');
  let count = 0;
  let totalBalanceSats = 0n;
  let maxBalanceSats = 0n;

  db.exec('BEGIN');
  let lineNo = 0;
  for (const line of text.split(/\r?\n/)) {
    lineNo += 1;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (lineNo === 1 && trimmed.toLowerCase().startsWith('address,balance_sats')) continue;
    const [address, balanceRaw, balanceBtc, explorerUrl, source] = trimmed.split(',');
    if (!address || !balanceRaw || !balanceBtc || !explorerUrl || !source) {
      throw new Error(`Invalid address balance CSV line ${lineNo}: ${line}`);
    }
    const balanceSats = parseBalance(balanceRaw);
    totalBalanceSats += balanceSats;
    if (balanceSats > maxBalanceSats) maxBalanceSats = balanceSats;
    insert.run(address, Number(balanceSats), balanceBtc, explorerUrl, source);
    count += 1;
  }
  db.exec('COMMIT');

  writeManifest(`${dbFile}.manifest.json`, {
    createdAt: new Date().toISOString(),
    input,
    output: dbFile,
    format: 'SQLite table address_balances(address primary key, balance_sats, balance_btc, explorer_url, source)',
    recordCount: count,
    totalBalanceSats,
    maxBalanceSats
  });

  console.log(`Built address DB with ${count} real address rows: ${dbFile}`);
}

main();
