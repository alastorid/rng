#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  decodeAddressScriptKey,
  ensureDirFor,
  parseArgs
} from './dataset-lib.mjs';

function usage() {
  return `
Build a full real UTXO SQLite database from local Bitcoin Core.

Requirements:
  - Fully synced Bitcoin Core node.
  - bitcoin-cli available.
  - Enough SSD for the UTXO SQLite database.

Usage:
  npm run utxo:sync -- --db data/bitcoin-utxo.sqlite --bitcoin-cli bitcoin-cli

Optional:
  --from-height <n>     Start height. Default: resume checkpoint or 0
  --to-height <n>       Stop height. Default: bitcoin-cli getblockcount
  --batch-blocks <n>    Commit every N blocks. Default: 100
`;
}

function btcToSats(value) {
  const [whole, frac = ''] = String(value).split('.');
  return BigInt(whole) * 100_000_000n + BigInt(frac.padEnd(8, '0').slice(0, 8));
}

function cliJson(bitcoinCli, args) {
  const output = execFileSync(bitcoinCli, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 512 * 1024 * 1024
  });
  return JSON.parse(output);
}

function cliText(bitcoinCli, args) {
  return execFileSync(bitcoinCli, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

function initDb(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA temp_store = MEMORY;
    CREATE TABLE IF NOT EXISTS utxos (
      txid TEXT NOT NULL,
      vout INTEGER NOT NULL,
      value_sats INTEGER NOT NULL,
      address_type TEXT NOT NULL,
      script_key TEXT NOT NULL,
      address TEXT NOT NULL,
      height INTEGER NOT NULL,
      PRIMARY KEY (txid, vout)
    );
    CREATE INDEX IF NOT EXISTS idx_utxos_script ON utxos(address_type, script_key);
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

function metaGet(db, key) {
  return db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
}

function metaSet(db, key, value) {
  db.prepare(`
    INSERT INTO meta(key, value) VALUES(?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

function scriptAddress(scriptPubKey) {
  if (scriptPubKey?.address) return scriptPubKey.address;
  if (Array.isArray(scriptPubKey?.addresses) && scriptPubKey.addresses.length === 1) {
    return scriptPubKey.addresses[0];
  }
  return null;
}

function main() {
  const args = parseArgs(process.argv.slice(2), {
    db: 'data/bitcoin-utxo.sqlite',
    bitcoinCli: 'bitcoin-cli',
    batchBlocks: 100
  });
  if (args.help) {
    console.log(usage().trim());
    return;
  }

  const dbFile = path.resolve(args.db);
  ensureDirFor(dbFile);
  const db = new DatabaseSync(dbFile);
  initDb(db);

  const bestHeight = args.toHeight ?? Number(cliText(args.bitcoinCli, ['getblockcount']));
  const checkpoint = Number(metaGet(db, 'height') ?? -1);
  const startHeight = args.fromHeight ?? checkpoint + 1;
  const insert = db.prepare(`
    INSERT OR REPLACE INTO utxos(txid, vout, value_sats, address_type, script_key, address, height)
    VALUES(?, ?, ?, ?, ?, ?, ?)
  `);
  const del = db.prepare('DELETE FROM utxos WHERE txid = ? AND vout = ?');
  let processed = 0;

  console.log(`UTXO sync db=${dbFile}`);
  console.log(`Scanning blocks ${startHeight}..${bestHeight}`);

  db.exec('BEGIN');
  for (let height = startHeight; height <= bestHeight; height += 1) {
    const hash = cliText(args.bitcoinCli, ['getblockhash', String(height)]);
    const block = cliJson(args.bitcoinCli, ['getblock', hash, '2']);

    for (const tx of block.tx) {
      const isCoinbase = tx.vin?.some((input) => input.coinbase);
      if (!isCoinbase) {
        for (const input of tx.vin ?? []) {
          if (input.txid !== undefined && input.vout !== undefined) {
            del.run(input.txid, input.vout);
          }
        }
      }

      for (const output of tx.vout ?? []) {
        const address = scriptAddress(output.scriptPubKey);
        if (!address) continue;
        let decoded;
        try {
          decoded = decodeAddressScriptKey(address);
        } catch {
          continue;
        }
        insert.run(
          tx.txid,
          output.n,
          Number(btcToSats(output.value)),
          decoded.addressType,
          decoded.scriptKey,
          address,
          height
        );
      }
    }

    metaSet(db, 'height', height);
    metaSet(db, 'block_hash', hash);
    processed += 1;

    if (processed % args.batchBlocks === 0) {
      db.exec('COMMIT');
      const count = db.prepare('SELECT COUNT(*) AS count FROM utxos').get().count;
      console.log(JSON.stringify({ height, blockHash: hash, utxos: count, at: new Date().toISOString() }));
      db.exec('BEGIN');
    }
  }

  db.exec('COMMIT');
  metaSet(db, 'completed_at', new Date().toISOString());
  const count = db.prepare('SELECT COUNT(*) AS count FROM utxos').get().count;
  console.log(`Completed. UTXOs stored: ${count}`);
}

main();
