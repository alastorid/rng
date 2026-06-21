#!/usr/bin/env node
import crypto from 'node:crypto';
import { secp256k1 } from './node_modules/@noble/curves/secp256k1.js';
import { base58check, bech32 } from './node_modules/@scure/base/index.js';

function normalizePrivateKey(input) {
  let value = String(input || '').trim();
  if (!value) throw new Error('private key is required');
  if (value.startsWith('0x') || value.startsWith('0X')) value = value.slice(2);
  value = value.replace(/\s+/g, '');
  if (!/^[0-9a-fA-F]+$/.test(value)) throw new Error('private key must be hex');
  if (value.length > 64) value = value.slice(value.length - 64);
  value = value.padStart(64, '0').toLowerCase();
  const bytes = Uint8Array.from(Buffer.from(value, 'hex'));
  if (!secp256k1.utils.isValidSecretKey(bytes)) throw new Error('private key is outside secp256k1 range');
  return { hex: value, bytes };
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest();
}

function hash160(bytes) {
  const sha = sha256(bytes);
  return crypto.createHash('ripemd160').update(sha).digest();
}

function hex(bytes) {
  return Buffer.from(bytes).toString('hex');
}

function p2pkh(hash) {
  return base58check(sha256).encode(Uint8Array.from([0x00, ...hash]));
}

function wif(priv, compressed) {
  const payload = compressed
    ? Uint8Array.from([0x80, ...priv, 0x01])
    : Uint8Array.from([0x80, ...priv]);
  return base58check(sha256).encode(payload);
}

function p2wpkh(hash) {
  return bech32.encode('bc', [0, ...bech32.toWords(hash)], 90);
}

const arg = process.argv[2];

try {
  const priv = normalizePrivateKey(arg);
  const pubCompressed = secp256k1.getPublicKey(priv.bytes, true);
  const pubUncompressed = secp256k1.getPublicKey(priv.bytes, false);
  const hashCompressed = hash160(pubCompressed);
  const hashUncompressed = hash160(pubUncompressed);

  console.log(`private_key: ${priv.hex}`);
  console.log(`wif_compressed: ${wif(priv.bytes, true)}`);
  console.log(`wif_uncompressed: ${wif(priv.bytes, false)}`);
  console.log(`public_key_compressed: ${hex(pubCompressed)}`);
  console.log(`hash160_compressed: ${hex(hashCompressed)}`);
  console.log(`p2pkh_compressed: ${p2pkh(hashCompressed)}`);
  console.log(`p2wpkh_compressed: ${p2wpkh(hashCompressed)}`);
  console.log(`public_key_uncompressed: ${hex(pubUncompressed)}`);
  console.log(`hash160_uncompressed: ${hex(hashUncompressed)}`);
  console.log(`p2pkh_uncompressed: ${p2pkh(hashUncompressed)}`);
} catch (err) {
  console.error(`check failed: ${err.message}`);
  process.exit(1);
}
