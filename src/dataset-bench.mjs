#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  RECORD_SIZE,
  binaryLookup,
  formatBigIntJson,
  hashMapLookup,
  loadHashMap,
  parseArgs,
  readRecord
} from './dataset-lib.mjs';

function usage() {
  return `
Benchmark local hash160 lookup

Usage:
  node src/dataset-bench.mjs --dataset data/address_dataset.bin --lookups 100000 --mode hashmap
  node src/dataset-bench.mjs --dataset data/address_dataset.bin --lookups 100000 --mode binary
`;
}

function memoryMb() {
  const mem = process.memoryUsage();
  return Object.fromEntries(
    Object.entries(mem).map(([key, value]) => [key, Number((value / 1024 / 1024).toFixed(2))])
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2), {
    dataset: 'data/address_dataset.bin',
    lookups: 100_000,
    mode: 'hashmap'
  });
  if (args.help) {
    console.log(usage().trim());
    return;
  }
  const dataset = path.resolve(args.dataset);
  const buffer = fs.readFileSync(dataset);
  const count = Math.floor(buffer.length / RECORD_SIZE);
  const queries = [];
  for (let i = 0; i < args.lookups; i += 1) {
    if (i % 2 === 0 && count > 0) {
      queries.push(readRecord(buffer, i % count).hash160);
    } else {
      queries.push(crypto.randomBytes(20).toString('hex'));
    }
  }

  const beforeLoad = memoryMb();
  const loadStart = process.hrtime.bigint();
  const map = args.mode === 'hashmap' ? loadHashMap(buffer) : null;
  const loadMs = Number(process.hrtime.bigint() - loadStart) / 1e6;
  const afterLoad = memoryMb();

  let hits = 0;
  const cpuStart = process.cpuUsage();
  const start = process.hrtime.bigint();
  for (const query of queries) {
    const result = map ? hashMapLookup(map, query) : binaryLookup(buffer, query);
    if (result.exists) hits += 1;
  }
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  const cpu = process.cpuUsage(cpuStart);
  const afterBench = memoryMb();

  const result = {
    dataset,
    mode: args.mode,
    records: count,
    lookups: args.lookups,
    hits,
    loadMs: Number(loadMs.toFixed(3)),
    totalLookupMs: Number(elapsedMs.toFixed(3)),
    singleLookupLatencyMicros: Number(((elapsedMs * 1000) / args.lookups).toFixed(3)),
    lookupsPerSec: Number(((args.lookups / elapsedMs) * 1000).toFixed(0)),
    cpuUsageMs: {
      user: Number((cpu.user / 1000).toFixed(3)),
      system: Number((cpu.system / 1000).toFixed(3))
    },
    memoryMb: {
      beforeLoad,
      afterLoad,
      afterBench
    }
  };

  console.log(JSON.stringify(result, formatBigIntJson, 2));
}

main();
