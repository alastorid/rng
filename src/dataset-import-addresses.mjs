#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  decodeAddressScriptKey,
  ensureDirFor,
  parseArgs,
  parseBalance,
  writeManifest
} from './dataset-lib.mjs';

function usage() {
  return `
Import real public addresses into a script-key dataset CSV

Input CSV:
  address,balance_sats,source

Usage:
  node src/dataset-import-addresses.mjs --input data/real-addresses.csv --out data/real-script_dataset.csv

Output CSV:
  script_key,address_type,address,balance_sats,balance_btc,explorer_url,source
`;
}

function csvEscape(value) {
  const text = String(value);
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

function formatBtc(sats) {
  const whole = sats / 100_000_000n;
  const fraction = (sats % 100_000_000n).toString().padStart(8, '0');
  return `${whole}.${fraction}`;
}

function explorerUrl(address, network) {
  const base = network === 'mainnet'
    ? 'https://blockstream.info/address/'
    : 'https://blockstream.info/testnet/address/';
  return `${base}${address}`;
}

function main() {
  const args = parseArgs(process.argv.slice(2), {
    input: 'data/real-addresses.csv',
    out: 'data/real-script_dataset.csv'
  });
  if (args.help) {
    console.log(usage().trim());
    return;
  }

  const input = path.resolve(args.input);
  const out = path.resolve(args.out);
  const text = fs.readFileSync(input, 'utf8');
  const rows = [];
  let lineNo = 0;

  for (const line of text.split(/\r?\n/)) {
    lineNo += 1;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (lineNo === 1 && trimmed.toLowerCase().startsWith('address,balance_sats')) continue;
    const [address, balanceRaw, source = 'manual'] = trimmed.split(',');
    if (!address || !balanceRaw) throw new Error(`Invalid line ${lineNo}: ${line}`);
    const decoded = decodeAddressScriptKey(address);
    rows.push({
      scriptKey: decoded.scriptKey,
      addressType: decoded.addressType,
      address,
      balanceSats: parseBalance(balanceRaw),
      source
    });
  }

  rows.sort((a, b) => a.scriptKey.localeCompare(b.scriptKey));

  const lines = ['script_key,address_type,address,balance_sats,balance_btc,explorer_url,source'];
  for (const row of rows) {
    lines.push([
      row.scriptKey,
      row.addressType,
      row.address,
      row.balanceSats.toString(),
      formatBtc(row.balanceSats),
      explorerUrl(row.address, row.address.startsWith('tb1') ? 'testnet' : 'mainnet'),
      row.source
    ].map(csvEscape).join(','));
  }

  ensureDirFor(out);
  fs.writeFileSync(out, `${lines.join('\n')}\n`);
  writeManifest(`${out}.manifest.json`, {
    createdAt: new Date().toISOString(),
    input,
    output: out,
    recordCount: rows.length,
    supportedAddressTypes: ['p2pkh', 'p2sh', 'p2wpkh', 'p2wsh', 'p2tr'],
    note: 'Real public-address dataset. P2PKH/P2SH/P2WPKH use 20-byte script keys; P2WSH/P2TR use 32-byte script keys.'
  });
  console.log(`Wrote ${rows.length} real script-key rows to ${out}`);
}

main();
