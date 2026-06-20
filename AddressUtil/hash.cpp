#include "AddressUtil.h"
#include "CryptoUtil.h"

#include <stdio.h>
#include <string.h>
#include <vector>

static const char *BECH32_CHARS = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

static unsigned int endian(unsigned int x)
{
	return (x << 24) | ((x << 8) & 0x00ff0000) | ((x >> 8) & 0x0000ff00) | (x >> 24);
}

static unsigned int addressChecksum(unsigned int version, const unsigned int *hash)
{
	unsigned int msg[16] = { 0 };
	unsigned int digest[8] = { 0 };

	msg[0] = (version & 0xff) << 24;
	msg[0] |= hash[0] >> 8;
	msg[1] = (hash[0] << 24) | (hash[1] >> 8);
	msg[2] = (hash[1] << 24) | (hash[2] >> 8);
	msg[3] = (hash[2] << 24) | (hash[3] >> 8);
	msg[4] = (hash[3] << 24) | (hash[4] >> 8);
	msg[5] = (hash[4] << 24) | 0x00800000;
	msg[15] = 168;

	crypto::sha256Init(digest);
	crypto::sha256(msg, digest);

	memset(msg, 0, 16 * sizeof(unsigned int));
	for(int i = 0; i < 8; i++) {
		msg[i] = digest[i];
	}

	msg[8] = 0x80000000;
	msg[15] = 256;

	crypto::sha256Init(digest);
	crypto::sha256(msg, digest);

	return digest[0];
}

static int bech32Value(char c)
{
	for(int i = 0; i < 32; i++) {
		if(BECH32_CHARS[i] == c) {
			return i;
		}
	}
	return -1;
}

static unsigned int bech32Polymod(const std::vector<unsigned int> &values)
{
	const unsigned int gen[5] = {
		0x3b6a57b2,
		0x26508e6d,
		0x1ea119fa,
		0x3d4233dd,
		0x2a1462b3
	};

	unsigned int chk = 1;
	for(size_t i = 0; i < values.size(); i++) {
		unsigned int top = chk >> 25;
		chk = ((chk & 0x1ffffff) << 5) ^ values[i];
		for(int j = 0; j < 5; j++) {
			if((top >> j) & 1) {
				chk ^= gen[j];
			}
		}
	}
	return chk;
}

static bool decodeBech32P2WPKH(const std::string &address, unsigned char program[20])
{
	std::string s = address;
	bool hasLower = false;
	bool hasUpper = false;

	for(size_t i = 0; i < s.length(); i++) {
		if(s[i] >= 'a' && s[i] <= 'z') {
			hasLower = true;
		} else if(s[i] >= 'A' && s[i] <= 'Z') {
			hasUpper = true;
			s[i] = s[i] - 'A' + 'a';
		}
	}

	if(hasLower && hasUpper) {
		return false;
	}

	size_t pos = s.rfind('1');
	if(pos == std::string::npos || pos == 0 || pos + 7 > s.length()) {
		return false;
	}

	std::string hrp = s.substr(0, pos);
	if(hrp != "bc") {
		return false;
	}

	std::vector<unsigned int> checksumValues;
	for(size_t i = 0; i < hrp.length(); i++) {
		checksumValues.push_back((unsigned int)(hrp[i] >> 5));
	}
	checksumValues.push_back(0);
	for(size_t i = 0; i < hrp.length(); i++) {
		checksumValues.push_back((unsigned int)(hrp[i] & 31));
	}

	std::vector<unsigned int> data;
	for(size_t i = pos + 1; i < s.length(); i++) {
		int v = bech32Value(s[i]);
		if(v < 0) {
			return false;
		}
		data.push_back((unsigned int)v);
		checksumValues.push_back((unsigned int)v);
	}

	if(bech32Polymod(checksumValues) != 1) {
		return false;
	}

	if(data.size() != 39 || data[0] != 0) {
		return false;
	}

	int bits = 0;
	unsigned int acc = 0;
	size_t out = 0;
	for(size_t i = 1; i < data.size() - 6; i++) {
		acc = (acc << 5) | data[i];
		bits += 5;
		while(bits >= 8) {
			bits -= 8;
			if(out >= 20) {
				return false;
			}
			program[out++] = (unsigned char)((acc >> bits) & 0xff);
		}
	}

	if(out != 20 || (bits > 0 && ((acc << (8 - bits)) & 0xff) != 0)) {
		return false;
	}

	return true;
}

static void bytesToHash160(const unsigned char bytes[20], unsigned int hash[5])
{
	for(int i = 0; i < 5; i++) {
		hash[i] = ((unsigned int)bytes[i * 4] << 24) |
			((unsigned int)bytes[i * 4 + 1] << 16) |
			((unsigned int)bytes[i * 4 + 2] << 8) |
			(unsigned int)bytes[i * 4 + 3];
	}
}

bool Address::verifyAddress(std::string address)
{
	unsigned char program[20];
	if(decodeBech32P2WPKH(address, program)) {
		return true;
	}

	// Check length
	if(address.length() < 26 || address.length() > 35) {
		return false;
	}

	// Check encoding
	if(!Base58::isBase58(address)) {
		return false;
	}

	secp256k1::uint256 value = Base58::toBigInt(address);
	unsigned int words[6];
	unsigned int hash[5];
	unsigned int checksum;

	value.exportWords(words, 6, secp256k1::uint256::BigEndian);
	memcpy(hash, words, sizeof(unsigned int) * 5);
	checksum = words[5];

	for(unsigned int version = 0; version <= 255; version++) {
		if(addressChecksum(version, hash) == checksum) {
			return true;
		}
	}

	return false;
}

void Address::toHash160(const std::string &s, unsigned int hash[5])
{
	unsigned char program[20];

	if(decodeBech32P2WPKH(s, program)) {
		bytesToHash160(program, hash);
		return;
	}

	Base58::toHash160(s, hash);
}

std::string Address::fromPublicKey(const secp256k1::ecpoint &p, bool compressed)
{
	unsigned int xWords[8] = { 0 };
	unsigned int yWords[8] = { 0 };

	p.x.exportWords(xWords, 8, secp256k1::uint256::BigEndian);
	p.y.exportWords(yWords, 8, secp256k1::uint256::BigEndian);

	unsigned int digest[5];

	if(compressed) {
		Hash::hashPublicKeyCompressed(xWords, yWords, digest);
	} else {
		Hash::hashPublicKey(xWords, yWords, digest);
	}

	unsigned int checksum = crypto::checksum(digest);

	unsigned int addressWords[8] = { 0 };
	for(int i = 0; i < 5; i++) {
		addressWords[2 + i] = digest[i];
	}
	addressWords[7] = checksum;

	secp256k1::uint256 addressBigInt(addressWords, secp256k1::uint256::BigEndian);

	return "1" + Base58::toBase58(addressBigInt);
}

void Hash::hashPublicKey(const secp256k1::ecpoint &p, unsigned int *digest)
{
	unsigned int xWords[8];
	unsigned int yWords[8];

	p.x.exportWords(xWords, 8, secp256k1::uint256::BigEndian);
	p.y.exportWords(yWords, 8, secp256k1::uint256::BigEndian);

	hashPublicKey(xWords, yWords, digest);
}


void Hash::hashPublicKeyCompressed(const secp256k1::ecpoint &p, unsigned int *digest)
{
	unsigned int xWords[8];
	unsigned int yWords[8];

	p.x.exportWords(xWords, 8, secp256k1::uint256::BigEndian);
	p.y.exportWords(yWords, 8, secp256k1::uint256::BigEndian);

	hashPublicKeyCompressed(xWords, yWords, digest);
}

void Hash::hashPublicKey(const unsigned int *x, const unsigned int *y, unsigned int *digest)
{
	unsigned int msg[16];
	unsigned int sha256Digest[8];

	// 0x04 || x || y
	msg[15] = (y[7] >> 8) | (y[6] << 24);
	msg[14] = (y[6] >> 8) | (y[5] << 24);
	msg[13] = (y[5] >> 8) | (y[4] << 24);
	msg[12] = (y[4] >> 8) | (y[3] << 24);
	msg[11] = (y[3] >> 8) | (y[2] << 24);
	msg[10] = (y[2] >> 8) | (y[1] << 24);
	msg[9] = (y[1] >> 8) | (y[0] << 24);
	msg[8] = (y[0] >> 8) | (x[7] << 24);
	msg[7] = (x[7] >> 8) | (x[6] << 24);
	msg[6] = (x[6] >> 8) | (x[5] << 24);
	msg[5] = (x[5] >> 8) | (x[4] << 24);
	msg[4] = (x[4] >> 8) | (x[3] << 24);
	msg[3] = (x[3] >> 8) | (x[2] << 24);
	msg[2] = (x[2] >> 8) | (x[1] << 24);
	msg[1] = (x[1] >> 8) | (x[0] << 24);
	msg[0] = (x[0] >> 8) | 0x04000000;


	crypto::sha256Init(sha256Digest);
	crypto::sha256(msg, sha256Digest);

	// Zero out the message
	for(int i = 0; i < 16; i++) {
		msg[i] = 0;
	}

	// Set first byte, padding, and length
	msg[0] = (y[7] << 24) | 0x00800000;
	msg[15] = 65 * 8;

	crypto::sha256(msg, sha256Digest);

	for(int i = 0; i < 16; i++) {
		msg[i] = 0;
	}

	// Swap to little-endian
	for(int i = 0; i < 8; i++) {
		msg[i] = endian(sha256Digest[i]);
	}

	// Message length, little endian
	msg[8] = 0x00000080;
	msg[14] = 256;
	msg[15] = 0;

	crypto::ripemd160(msg, digest);
}



void Hash::hashPublicKeyCompressed(const unsigned int *x, const unsigned int *y, unsigned int *digest)
{
	unsigned int msg[16] = { 0 };
	unsigned int sha256Digest[8];

	// Compressed public key format
	msg[15] = 33 * 8;

	msg[8] = (x[7] << 24) | 0x00800000;
	msg[7] = (x[7] >> 8) | (x[6] << 24);
	msg[6] = (x[6] >> 8) | (x[5] << 24);
	msg[5] = (x[5] >> 8) | (x[4] << 24);
	msg[4] = (x[4] >> 8) | (x[3] << 24);
	msg[3] = (x[3] >> 8) | (x[2] << 24);
	msg[2] = (x[2] >> 8) | (x[1] << 24);
	msg[1] = (x[1] >> 8) | (x[0] << 24);

	if(y[7] & 0x01) {
		msg[0] = (x[0] >> 8) | 0x03000000;
	} else {
		msg[0] = (x[0] >> 8) | 0x02000000;
	}

	crypto::sha256Init(sha256Digest);
	crypto::sha256(msg, sha256Digest);

	for(int i = 0; i < 16; i++) {
		msg[i] = 0;
	}

	// Swap to little-endian
	for(int i = 0; i < 8; i++) {
		msg[i] = endian(sha256Digest[i]);
	}

	// Message length, little endian
	msg[8] = 0x00000080;
	msg[14] = 256;
	msg[15] = 0;

	crypto::ripemd160(msg, digest);
}
