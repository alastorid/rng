import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const RECORD_SIZE = 28;
export const HASH160_SIZE = 20;

export function parseArgs(argv, defaults = {}) {
  const args = { ...defaults };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const needValue = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      i += 1;
      return value;
    };

    if (arg === '--input') args.input = needValue();
    else if (arg === '--out') args.out = needValue();
    else if (arg === '--dataset') args.dataset = needValue();
    else if (arg === '--hash160') args.hash160 = needValue();
    else if (arg === '--lookups') args.lookups = Number.parseInt(needValue(), 10);
    else if (arg === '--count') args.count = Number.parseInt(needValue(), 10);
    else if (arg === '--mode') args.mode = needValue();
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return args;
}

export function normalizeHash160(value) {
  const clean = value.trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(clean)) {
    throw new Error(`Invalid hash160: ${value}`);
  }
  return clean;
}

export function parseBalance(value) {
  if (!/^[0-9]+$/.test(String(value).trim())) {
    throw new Error(`Invalid balance_sats: ${value}`);
  }
  return BigInt(value);
}

export function writeRecord(buffer, offset, hashHex, balance) {
  Buffer.from(hashHex, 'hex').copy(buffer, offset);
  buffer.writeBigUInt64BE(balance, offset + HASH160_SIZE);
}

export function readRecord(buffer, index) {
  const offset = index * RECORD_SIZE;
  return {
    hash160: buffer.subarray(offset, offset + HASH160_SIZE).toString('hex'),
    balanceSats: buffer.readBigUInt64BE(offset + HASH160_SIZE)
  };
}

export function compareHashAt(buffer, index, targetHashBuffer) {
  const offset = index * RECORD_SIZE;
  return Buffer.compare(
    buffer.subarray(offset, offset + HASH160_SIZE),
    targetHashBuffer
  );
}

export function binaryLookup(buffer, hash160) {
  const target = Buffer.from(normalizeHash160(hash160), 'hex');
  let low = 0;
  let high = Math.floor(buffer.length / RECORD_SIZE) - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const cmp = compareHashAt(buffer, mid, target);
    if (cmp === 0) {
      return { exists: true, ...readRecord(buffer, mid) };
    }
    if (cmp < 0) low = mid + 1;
    else high = mid - 1;
  }

  return { exists: false, hash160, balanceSats: 0n };
}

export function loadHashMap(buffer) {
  const map = new Map();
  const count = Math.floor(buffer.length / RECORD_SIZE);
  for (let i = 0; i < count; i += 1) {
    const record = readRecord(buffer, i);
    map.set(record.hash160, record.balanceSats);
  }
  return map;
}

export function hashMapLookup(map, hash160) {
  const normalized = normalizeHash160(hash160);
  const balanceSats = map.get(normalized);
  return {
    exists: balanceSats !== undefined,
    hash160: normalized,
    balanceSats: balanceSats ?? 0n
  };
}

export function formatBigIntJson(_key, value) {
  return typeof value === 'bigint' ? value.toString() : value;
}

export function datasetStats(records) {
  const buckets = [
    ['dust_to_9999_sats', 0n, 9_999n],
    ['10k_to_99k_sats', 10_000n, 99_999n],
    ['100k_to_999k_sats', 100_000n, 999_999n],
    ['0_01_to_0_099_btc', 1_000_000n, 9_999_999n],
    ['0_1_to_0_999_btc', 10_000_000n, 99_999_999n],
    ['1_to_9_999_btc', 100_000_000n, 999_999_999n],
    ['10_to_99_999_btc', 1_000_000_000n, 9_999_999_999n],
    ['100_plus_btc', 10_000_000_000n, null]
  ];
  const distribution = Object.fromEntries(buckets.map(([name]) => [name, 0]));
  let totalBalanceSats = 0n;
  let maxBalanceSats = 0n;
  const topBalances = [];

  for (const record of records) {
    totalBalanceSats += record.balanceSats;
    if (record.balanceSats > maxBalanceSats) maxBalanceSats = record.balanceSats;
    for (const [name, min, max] of buckets) {
      if (record.balanceSats >= min && (max === null || record.balanceSats <= max)) {
        distribution[name] += 1;
        break;
      }
    }
    topBalances.push(record.balanceSats);
  }

  topBalances.sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));

  return {
    addressCount: records.length,
    totalBalanceSats,
    maxBalanceSats,
    largestHolders: {
      top10Count: Math.min(10, records.length),
      top100Count: Math.min(100, records.length),
      threshold_1_btc_count: records.filter((r) => r.balanceSats >= 100_000_000n).length,
      threshold_10_btc_count: records.filter((r) => r.balanceSats >= 1_000_000_000n).length,
      threshold_100_btc_count: records.filter((r) => r.balanceSats >= 10_000_000_000n).length
    },
    balanceDistribution: distribution
  };
}

export function fileSha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function storageStats(file) {
  const rawSizeBytes = fs.statSync(file).size;
  return {
    rawSizeBytes,
    compressedEstimateBytes: 'run gzip/zstd on final dataset; synthetic/sample data is misleading',
    ramRequirementBinaryLookupBytes: rawSizeBytes,
    ramRequirementHashMapApproxBytes: `${Math.ceil(rawSizeBytes * 3.0)} to ${Math.ceil(rawSizeBytes * 5.0)}`,
    ssdRequirementBytes: rawSizeBytes
  };
}

export function writeManifest(file, manifest) {
  fs.writeFileSync(file, `${JSON.stringify({
    ...manifest,
    host: {
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      node: process.version
    }
  }, formatBigIntJson, 2)}\n`);
}

export function ensureDirFor(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}
