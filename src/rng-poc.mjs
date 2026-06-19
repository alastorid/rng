#!/usr/bin/env node
import { secp256k1 } from '@noble/curves/secp256k1';
import { bech32 } from '@scure/base';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  binaryLookup,
  fileSha256,
  hashMapLookup,
  loadHashMap,
  parseBalance
} from './dataset-lib.mjs';

const CURVE_N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const DEFAULT_LOG_DIR = path.join(projectRoot, 'logs');
const DEFAULT_API = 'https://blockstream.info/api';
const DEFAULT_TESTNET_API = 'https://blockstream.info/testnet/api';

function usage() {
  return `
Pure RNG Bitcoin address collision POC

Usage:
  npm start -- [options]

Options:
  --samples <n>             Number of private keys to sample. Default: 10
  --continuous              Run until stopped.
  --delay-ms <n>            Wait between samples. Default: 250
  --network <mainnet|testnet>
                            Select chain API and address prefixes. Default: mainnet
  --api-base <url>          Override chain API. Default: Blockstream public API
  --local-dataset <path>    Use local binary hash160 dataset and do no network checks.
  --real-script-dataset <path>
                            Use real script-key CSV dataset and do no network checks.
  --address-db <path>       Use simple SQLite address->balance DB and do no network checks.
  --min-address-db-records <n>
                            Refuse small address DBs. Default: 1000000
  --allow-small-db          Allow seed/test address DBs below the minimum.
  --lookup-mode <mode>      Local lookup mode: hashmap or binary. Default: hashmap
  --log-dir <path>          Directory for append-only logs. Default: ./logs
  --dry-run                 Derive addresses and log samples without chain API calls.
  --store-hit-keys-plain    For hit records only, save private key hex and WIF in plaintext.
  --vault-pass-env <name>   Env var containing passphrase for encrypted hit-key vault.
  --help                    Show this help.

Safety model:
  - The program never spends coins and has no transaction code.
  - Routine sample logs record a salted key commitment, not the raw private key.
  - If a chain hit is found, raw key material is preserved only when explicitly requested.
`;
}

function parseArgs(argv) {
  const args = {
    samples: 10,
    continuous: false,
    delayMs: 250,
    network: 'mainnet',
    apiBase: null,
    localDataset: null,
    realScriptDataset: null,
    addressDb: null,
    minAddressDbRecords: 1_000_000,
    allowSmallDb: false,
    lookupMode: 'hashmap',
    logDir: DEFAULT_LOG_DIR,
    dryRun: false,
    storeHitKeysPlain: false,
    vaultPassEnv: null
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const needValue = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      i += 1;
      return value;
    };

    if (arg === '--samples') args.samples = Number.parseInt(needValue(), 10);
    else if (arg === '--continuous') args.continuous = true;
    else if (arg === '--delay-ms') args.delayMs = Number.parseInt(needValue(), 10);
    else if (arg === '--network') args.network = needValue();
    else if (arg === '--api-base') args.apiBase = needValue().replace(/\/+$/, '');
    else if (arg === '--local-dataset') args.localDataset = path.resolve(needValue());
    else if (arg === '--real-script-dataset') args.realScriptDataset = path.resolve(needValue());
    else if (arg === '--address-db') args.addressDb = path.resolve(needValue());
    else if (arg === '--min-address-db-records') args.minAddressDbRecords = Number.parseInt(needValue(), 10);
    else if (arg === '--allow-small-db') args.allowSmallDb = true;
    else if (arg === '--lookup-mode') args.lookupMode = needValue();
    else if (arg === '--log-dir') args.logDir = path.resolve(needValue());
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--store-hit-keys-plain') args.storeHitKeysPlain = true;
    else if (arg === '--vault-pass-env') args.vaultPassEnv = needValue();
    else if (arg === '--help' || arg === '-h') {
      console.log(usage().trim());
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!Number.isSafeInteger(args.samples) || args.samples < 1) {
    throw new Error('--samples must be a positive integer');
  }
  if (!Number.isSafeInteger(args.delayMs) || args.delayMs < 0) {
    throw new Error('--delay-ms must be a non-negative integer');
  }
  if (!['mainnet', 'testnet'].includes(args.network)) {
    throw new Error('--network must be mainnet or testnet');
  }
  if (!['hashmap', 'binary'].includes(args.lookupMode)) {
    throw new Error('--lookup-mode must be hashmap or binary');
  }
  const localModes = [args.localDataset, args.realScriptDataset, args.addressDb].filter(Boolean).length;
  if (localModes > 1) {
    throw new Error('Use only one local lookup mode: --local-dataset, --real-script-dataset, or --address-db');
  }
  if (!Number.isSafeInteger(args.minAddressDbRecords) || args.minAddressDbRecords < 1) {
    throw new Error('--min-address-db-records must be a positive integer');
  }

  args.apiBase ??= args.network === 'testnet' ? DEFAULT_TESTNET_API : DEFAULT_API;
  return args;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest();
}

function ripemd160(bytes) {
  return crypto.createHash('ripemd160').update(bytes).digest();
}

function hash160(bytes) {
  return ripemd160(sha256(bytes));
}

function base58check(version, payload) {
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

function toWif(privateKey, network) {
  const version = network === 'mainnet' ? 0x80 : 0xef;
  return base58check(version, Buffer.concat([privateKey, Buffer.from([0x01])]));
}

function privateKeyToBigInt(privateKey) {
  return BigInt(`0x${privateKey.toString('hex')}`);
}

function generatePrivateKey() {
  while (true) {
    const key = crypto.randomBytes(32);
    const value = privateKeyToBigInt(key);
    if (value > 0n && value < CURVE_N) return key;
  }
}

function deriveAddresses(privateKey, network) {
  const publicKey = Buffer.from(secp256k1.getPublicKey(privateKey, true));
  const pubKeyHash = hash160(publicKey);

  const p2pkhVersion = network === 'mainnet' ? 0x00 : 0x6f;
  const p2pkh = base58check(p2pkhVersion, pubKeyHash);

  const hrp = network === 'mainnet' ? 'bc' : 'tb';
  const p2wpkh = bech32.encode(hrp, [0, ...bech32.toWords(pubKeyHash)]);

  return {
    publicKeyCompressedHex: publicKey.toString('hex'),
    pubKeyHashHex: pubKeyHash.toString('hex'),
    formats: [
      { type: 'p2pkh-compressed', address: p2pkh },
      { type: 'p2wpkh', address: p2wpkh }
    ]
  };
}

function keyCommitment(runSalt, privateKey) {
  return crypto
    .createHash('sha256')
    .update('rng-bitcoin-poc:v1:key-commitment')
    .update(runSalt)
    .update(privateKey)
    .digest('hex');
}

function encryptJson(passphrase, object) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(passphrase, salt, 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(object), 'utf8'),
    cipher.final()
  ]);
  return {
    kdf: 'scrypt',
    cipher: 'aes-256-gcm',
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    ciphertext: ciphertext.toString('hex')
  };
}

async function fetchAddressState(apiBase, address) {
  const response = await fetch(`${apiBase}/address/${address}`, {
    headers: { accept: 'application/json' }
  });
  if (!response.ok) {
    throw new Error(`API ${response.status} for ${address}`);
  }
  const data = await response.json();
  const chain = data.chain_stats ?? {};
  const mempool = data.mempool_stats ?? {};
  const funded = BigInt(chain.funded_txo_sum ?? 0) + BigInt(mempool.funded_txo_sum ?? 0);
  const spent = BigInt(chain.spent_txo_sum ?? 0) + BigInt(mempool.spent_txo_sum ?? 0);
  const txCount = Number(chain.tx_count ?? 0) + Number(mempool.tx_count ?? 0);
  const balanceSats = funded - spent;

  return {
    txCount,
    fundedSats: funded.toString(),
    spentSats: spent.toString(),
    balanceSats: balanceSats.toString(),
    appearedOnChain: txCount > 0,
    hasHistory: txCount > 0,
    hasBalance: balanceSats > 0n
  };
}

function localAddressState(lookupResult) {
  const balanceSats = lookupResult.balanceSats;
  const exists = lookupResult.exists;
  return {
    source: 'local-dataset',
    txCount: null,
    fundedSats: null,
    spentSats: null,
    balanceSats: balanceSats.toString(),
    appearedOnChain: exists,
    hasHistory: exists,
    hasBalance: balanceSats > 0n
  };
}

function scriptDatasetState(record) {
  const exists = Boolean(record);
  const balanceSats = record?.balanceSats ?? 0n;
  return {
    source: 'real-script-dataset',
    txCount: null,
    fundedSats: null,
    spentSats: null,
    balanceSats: balanceSats.toString(),
    appearedOnChain: exists,
    hasHistory: exists,
    hasBalance: balanceSats > 0n,
    datasetAddress: record?.address ?? null,
    datasetAddressType: record?.addressType ?? null,
    datasetSource: record?.source ?? null
  };
}

function addressDbState(record) {
  const exists = Boolean(record);
  const balanceSats = record ? BigInt(record.balance_sats) : 0n;
  return {
    source: 'local-real-address-db',
    txCount: null,
    fundedSats: null,
    spentSats: null,
    balanceSats: balanceSats.toString(),
    balanceBtc: record?.balance_btc ?? null,
    appearedOnChain: exists,
    hasHistory: exists,
    hasBalance: balanceSats > 0n,
    datasetAddress: record?.address ?? null,
    explorerUrl: record?.explorer_url ?? null,
    datasetSource: record?.source ?? null
  };
}

function loadScriptDataset(file) {
  const text = fs.readFileSync(file, 'utf8');
  const map = new Map();
  let lineNo = 0;
  for (const line of text.split(/\r?\n/)) {
    lineNo += 1;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (lineNo === 1 && trimmed.toLowerCase().startsWith('script_key,address_type')) continue;
    const [scriptKey, addressType, address, balanceRaw, balanceBtcOrSource, explorerOrSource, maybeSource] = trimmed.split(',');
    if (!scriptKey || !addressType || !address || !balanceRaw) {
      throw new Error(`Invalid real script dataset line ${lineNo}: ${line}`);
    }
    const source = maybeSource ?? explorerOrSource ?? balanceBtcOrSource ?? 'unknown';
    const record = {
      scriptKey: scriptKey.toLowerCase(),
      addressType,
      address,
      balanceSats: parseBalance(balanceRaw),
      source
    };
    map.set(`${record.addressType}:${record.scriptKey}`, record);
  }
  return map;
}

function appendJsonl(file, object) {
  fs.appendFileSync(file, `${JSON.stringify(object)}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso() {
  return new Date().toISOString();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(args.logDir, { recursive: true });

  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}`;
  const runSalt = crypto.randomBytes(32);
  const samplesFile = path.join(args.logDir, `${runId}.samples.jsonl`);
  const hitsFile = path.join(args.logDir, `${runId}.hits.jsonl`);
  const proofFile = path.join(args.logDir, `${runId}.proof-hit-keys.jsonl`);
  const vaultFile = path.join(args.logDir, `${runId}.hit-keys.enc.jsonl`);
  const manifestFile = path.join(args.logDir, `${runId}.manifest.json`);
  const vaultPass = args.vaultPassEnv ? process.env[args.vaultPassEnv] : null;
  let stopRequested = false;
  let localDataset = null;
  let localDatasetMap = null;
  let realScriptDatasetMap = null;
  let addressDb = null;
  let addressDbLookup = null;
  let addressDbRecords = 0;

  if (args.localDataset) {
    localDataset = fs.readFileSync(args.localDataset);
    if (args.lookupMode === 'hashmap') {
      localDatasetMap = loadHashMap(localDataset);
    }
  }
  if (args.realScriptDataset) {
    realScriptDatasetMap = loadScriptDataset(args.realScriptDataset);
  }
  if (args.addressDb) {
    addressDb = new DatabaseSync(args.addressDb, { readOnly: true });
    addressDbRecords = addressDb.prepare('SELECT COUNT(*) AS count FROM address_balances').get().count;
    if (!args.allowSmallDb && addressDbRecords < args.minAddressDbRecords) {
      throw new Error(
        `Address DB has only ${addressDbRecords} rows. Refusing to treat it as a full real dataset. ` +
        `Build the all-address DB first, or pass --allow-small-db for explicit seed/testing runs.`
      );
    }
    addressDbLookup = addressDb.prepare(`
      SELECT address, balance_sats, balance_btc, explorer_url, source
      FROM address_balances
      WHERE address = ?
    `);
  }

  const manifest = {
    runId,
    startedAt: nowIso(),
    network: args.network,
    mode: args.realScriptDataset
      ? 'real-script-dataset'
      : args.addressDb
        ? 'real-address-db'
      : args.localDataset ? 'local-dataset' : args.dryRun ? 'dry-run' : 'remote-api',
    apiBase: args.localDataset || args.realScriptDataset || args.addressDb ? null : args.apiBase,
    localDataset: args.localDataset
      ? {
          path: args.localDataset,
          sha256: fileSha256(args.localDataset),
          bytes: fs.statSync(args.localDataset).size,
          lookupMode: args.lookupMode
      }
      : null,
    realScriptDataset: args.realScriptDataset
      ? {
          path: args.realScriptDataset,
          sha256: fileSha256(args.realScriptDataset),
          bytes: fs.statSync(args.realScriptDataset).size,
          records: realScriptDatasetMap.size
      }
      : null,
    addressDb: args.addressDb
      ? {
          path: args.addressDb,
          sha256: fileSha256(args.addressDb),
          bytes: fs.statSync(args.addressDb).size,
          records: addressDbRecords,
          minRequiredRecords: args.minAddressDbRecords,
          allowSmallDb: args.allowSmallDb
        }
      : null,
    dryRun: args.dryRun,
    samplesTarget: args.continuous ? 'continuous' : args.samples,
    delayMs: args.delayMs,
    rng: 'node:crypto.randomBytes backed by OS CSPRNG',
    addressFormats: ['p2pkh-compressed', 'p2wpkh'],
    keyCommitment: 'sha256(label || runSalt || privateKey)',
    runSaltHex: runSalt.toString('hex'),
    host: {
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      node: process.version
    },
    files: {
      samples: samplesFile,
      hits: hitsFile,
      plaintextHitProofs: args.storeHitKeysPlain ? proofFile : null,
      encryptedHitVault: vaultPass ? vaultFile : null
    }
  };
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(samplesFile, '');
  fs.writeFileSync(hitsFile, '');
  if (args.storeHitKeysPlain) fs.writeFileSync(proofFile, '');
  if (vaultPass) fs.writeFileSync(vaultFile, '');

  process.once('SIGINT', () => {
    stopRequested = true;
    console.log('\nStop requested. Finishing current check and writing final manifest...');
  });

  const stats = {
    sampledKeys: 0,
    checkedAddresses: 0,
    apiErrors: 0,
    appearedOnChain: 0,
    hasHistory: 0,
    hasBalance: 0,
    checkedHash160s: 0,
    checkedScriptKeys: 0,
    checkedAddressDbRows: 0
  };

  console.log(`Run ${runId}`);
  console.log(`Manifest: ${manifestFile}`);
  console.log(`Samples:  ${samplesFile}`);
  console.log(`Hits:     ${hitsFile}`);
  if (args.localDataset) console.log(`Local dataset: ${args.localDataset} (${args.lookupMode})`);
  if (args.realScriptDataset) console.log(`Real script dataset: ${args.realScriptDataset}`);
  if (args.addressDb) console.log(`Real address DB: ${args.addressDb}`);
  if (vaultPass) console.log(`Encrypted hit-key vault: ${vaultFile}`);

  let index = 0;
  while (!stopRequested && (args.continuous || index < args.samples)) {
    index += 1;
    const sampledAt = nowIso();
    const privateKey = generatePrivateKey();
    const derived = deriveAddresses(privateKey, args.network);
    const commitment = keyCommitment(runSalt, privateKey);
    const sampleRecord = {
      runId,
      index,
      sampledAt,
      keyCommitment: commitment,
      publicKeyCompressedHex: derived.publicKeyCompressedHex,
      pubKeyHashHex: derived.pubKeyHashHex,
      addresses: []
    };
    let localState = null;
    let localError = null;

    if (args.localDataset && !args.dryRun) {
      try {
        const lookup = localDatasetMap
          ? hashMapLookup(localDatasetMap, derived.pubKeyHashHex)
          : binaryLookup(localDataset, derived.pubKeyHashHex);
        localState = localAddressState(lookup);
        stats.checkedHash160s += 1;
      } catch (err) {
        stats.apiErrors += 1;
        localError = err.message;
      }
    }

    for (const candidate of derived.formats) {
      const checkedAt = nowIso();
      let state;
      let error = null;
      try {
        state = args.dryRun
          ? {
              source: args.localDataset || args.realScriptDataset || args.addressDb ? 'dry-run-local-dataset' : 'dry-run',
              txCount: null,
              fundedSats: null,
              spentSats: null,
              balanceSats: null,
              appearedOnChain: false,
              hasHistory: false,
              hasBalance: false
            }
          : args.localDataset
            ? localState
          : args.realScriptDataset
            ? scriptDatasetState(realScriptDatasetMap.get(`${candidate.type === 'p2pkh-compressed' ? 'p2pkh' : candidate.type}:${derived.pubKeyHashHex}`))
          : args.addressDb
            ? addressDbState(addressDbLookup.get(candidate.address))
          : await fetchAddressState(args.apiBase, candidate.address);
      } catch (err) {
        stats.apiErrors += 1;
        error = err.message;
        state = null;
      }
      if (localError) error = localError;

      stats.checkedAddresses += 1;
      const addressRecord = {
        ...candidate,
        checkedAt,
        state,
        error
      };
      sampleRecord.addresses.push(addressRecord);

      if (state?.appearedOnChain) stats.appearedOnChain += 1;
      if (state?.hasHistory) stats.hasHistory += 1;
      if (state?.hasBalance) stats.hasBalance += 1;
      if (args.realScriptDataset && !args.dryRun) stats.checkedScriptKeys += 1;
      if (args.addressDb && !args.dryRun) stats.checkedAddressDbRows += 1;

      if (state?.appearedOnChain || state?.hasHistory || state?.hasBalance) {
        const hitRecord = {
          runId,
          index,
          sampledAt,
          checkedAt,
          keyCommitment: commitment,
          publicKeyCompressedHex: derived.publicKeyCompressedHex,
          pubKeyHashHex: derived.pubKeyHashHex,
          address: candidate.address,
          addressType: candidate.type,
          state
        };
        appendJsonl(hitsFile, hitRecord);
        console.log(`HIT ${candidate.type} ${candidate.address} ${JSON.stringify(state)}`);

        if (args.storeHitKeysPlain) {
          appendJsonl(proofFile, {
            ...hitRecord,
            privateKeyHex: privateKey.toString('hex'),
            wifCompressed: toWif(privateKey, args.network),
            proofNote: 'Re-derive the listed address from privateKeyHex or WIF and verify chain state independently.'
          });
        }

        if (vaultPass) {
          appendJsonl(vaultFile, encryptJson(vaultPass, {
            ...hitRecord,
            privateKeyHex: privateKey.toString('hex'),
            wifCompressed: toWif(privateKey, args.network)
          }));
        }
      }
    }

    stats.sampledKeys += 1;
    appendJsonl(samplesFile, sampleRecord);

    if (index % 10 === 0 || index === 1) {
      console.log(JSON.stringify({ at: nowIso(), ...stats }));
    }

    if (args.delayMs > 0) await sleep(args.delayMs);
  }

  const completed = {
    ...manifest,
    completedAt: nowIso(),
    endedReason: stopRequested ? 'stopped-by-user' : 'completed-target',
    stats
  };
  fs.writeFileSync(manifestFile, `${JSON.stringify(completed, null, 2)}\n`);
  console.log(`Completed ${stats.sampledKeys} keys / ${stats.checkedAddresses} addresses`);
  console.log(JSON.stringify(stats, null, 2));
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
