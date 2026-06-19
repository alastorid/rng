#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ensureDirFor, parseArgs } from './dataset-lib.mjs';

function main() {
  const args = parseArgs(process.argv.slice(2), {
    count: 10_000,
    out: 'data/sample-address_dataset.csv'
  });
  const out = path.resolve(args.out);
  ensureDirFor(out);

  const lines = ['hash160,balance_sats'];
  for (let i = 0; i < args.count; i += 1) {
    const hash160 = crypto.randomBytes(20).toString('hex');
    const balance = BigInt(1 + crypto.randomInt(100_000_000));
    lines.push(`${hash160},${balance}`);
  }
  fs.writeFileSync(out, `${lines.join('\n')}\n`);
  console.log(`Wrote ${args.count} sample records to ${out}`);
}

main();
