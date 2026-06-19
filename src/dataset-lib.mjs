import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bech32 } from '@scure/base';

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
    else if (arg === '--network') args.network = needValue();
    else if (arg === '--addresses') args.addresses = needValue();
    else if (arg === '--db') args.db = needValue();
    else if (arg === '--address-db') args.addressDb = needValue();
    else if (arg === '--bitcoin-cli') args.bitcoinCli = needValue();
    else if (arg === '--from-height') args.fromHeight = Number.parseInt(needValue(), 10);
    else if (arg === '--to-height') args.toHeight = Number.parseInt(needValue(), 10);
    else if (arg === '--batch-blocks') args.batchBlocks = Number.parseInt(needValue(), 10);
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

export function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest();
}

export function base58check(version, payload) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const body = Buffer.concat([Buffer.from([version]), payload]);
  const checksum = sha256(sha256(body)).subarray(0, 4);
  const data = Buffer.concat([body, checksum]);
  let value = BigInt(`0x${data.toString('hex')}`);
  let out = '';
  while (value > 0n) {
    const mod = value % 58n;
    out = alphabet[Number(mod)] + out;
    value /= 58n;
  }
  for (const byte of data) {
    if (byte === 0) out = '1' + out;
    else break;
  }
  return out;
}

export function base58checkDecode(address) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let value = 0n;
  for (const char of address) {
    const index = alphabet.indexOf(char);
    if (index === -1) throw new Error(`Invalid base58 character in ${address}`);
    value = value * 58n + BigInt(index);
  }
  let hex = value.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  let data = Buffer.from(hex, 'hex');
  let leadingZeroes = 0;
  for (const char of address) {
    if (char === '1') leadingZeroes += 1;
    else break;
  }
  if (leadingZeroes > 0) {
    data = Buffer.concat([Buffer.alloc(leadingZeroes), data]);
  }
  if (data.length < 5) throw new Error(`Invalid base58check length for ${address}`);
  const body = data.subarray(0, -4);
  const checksum = data.subarray(-4);
  const expected = sha256(sha256(body)).subarray(0, 4);
  if (!checksum.equals(expected)) throw new Error(`Invalid base58check checksum for ${address}`);
  return {
    version: body[0],
    payload: body.subarray(1)
  };
}

export function hash160ToAddresses(hash160, network = 'mainnet') {
  const normalized = normalizeHash160(hash160);
  const payload = Buffer.from(normalized, 'hex');
  const p2pkhVersion = network === 'mainnet' ? 0x00 : 0x6f;
  const hrp = network === 'mainnet' ? 'bc' : 'tb';
  return [
    {
      addressType: 'p2pkh',
      address: base58check(p2pkhVersion, payload)
    },
    {
      addressType: 'p2wpkh',
      address: bech32.encode(hrp, [0, ...bech32.toWords(payload)])
    }
  ];
}

export function bech32ScriptKey(address) {
  const decoded = bech32.decode(address.toLowerCase(), 1023);
  const version = decoded.words[0];
  const program = Buffer.from(bech32.fromWords(decoded.words.slice(1)));
  if (decoded.prefix === 'bc' && version === 0 && program.length === 20) {
    return { network: 'mainnet', addressType: 'p2wpkh', scriptKey: program.toString('hex') };
  }
  if (decoded.prefix === 'bc' && version === 0 && program.length === 32) {
    return { network: 'mainnet', addressType: 'p2wsh', scriptKey: program.toString('hex') };
  }
  if (decoded.prefix === 'bc' && version === 1 && program.length === 32) {
    return { network: 'mainnet', addressType: 'p2tr', scriptKey: program.toString('hex') };
  }
  if (decoded.prefix === 'tb' && version === 0 && program.length === 20) {
    return { network: 'testnet', addressType: 'p2wpkh', scriptKey: program.toString('hex') };
  }
  if (decoded.prefix === 'tb' && version === 0 && program.length === 32) {
    return { network: 'testnet', addressType: 'p2wsh', scriptKey: program.toString('hex') };
  }
  if (decoded.prefix === 'tb' && version === 1 && program.length === 32) {
    return { network: 'testnet', addressType: 'p2tr', scriptKey: program.toString('hex') };
  }
  throw new Error(`Unsupported bech32 witness program for ${address}`);
}

export function decodeAddressScriptKey(address) {
  const clean = address.trim();
  if (/^(bc1|tb1)/i.test(clean)) {
    return bech32ScriptKey(clean);
  }
  const decoded = base58checkDecode(clean);
  if (decoded.payload.length !== 20) {
    throw new Error(`Unsupported base58 payload length for ${address}`);
  }
  if (decoded.version === 0x00) {
    return { network: 'mainnet', addressType: 'p2pkh', scriptKey: decoded.payload.toString('hex') };
  }
  if (decoded.version === 0x05) {
    return { network: 'mainnet', addressType: 'p2sh', scriptKey: decoded.payload.toString('hex') };
  }
  if (decoded.version === 0x6f) {
    return { network: 'testnet', addressType: 'p2pkh', scriptKey: decoded.payload.toString('hex') };
  }
  if (decoded.version === 0xc4) {
    return { network: 'testnet', addressType: 'p2sh', scriptKey: decoded.payload.toString('hex') };
  }
  throw new Error(`Unsupported address format for importer: ${address}`);
}
