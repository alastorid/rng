package btc

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"

	"github.com/btcsuite/btcutil/base58"
	"github.com/btcsuite/btcutil/bech32"
	"golang.org/x/crypto/ripemd160"
)

func Hash160(data []byte) []byte {
	first := sha256.Sum256(data)
	h := ripemd160.New()
	_, _ = h.Write(first[:])
	return h.Sum(nil)
}

func P2PKH(hash160 []byte, mainnet bool) string {
	version := byte(0x00)
	if !mainnet {
		version = 0x6f
	}
	return base58.CheckEncode(hash160, version)
}

func P2WPKH(hash160 []byte, mainnet bool) (string, error) {
	hrp := "bc"
	if !mainnet {
		hrp = "tb"
	}
	converted, err := bech32.ConvertBits(hash160, 8, 5, true)
	if err != nil {
		return "", err
	}
	data := append([]byte{0}, converted...)
	return bech32.Encode(hrp, data)
}

func WIFCompressed(privateKey []byte, mainnet bool) string {
	version := byte(0x80)
	if !mainnet {
		version = 0xef
	}
	payload := append(append([]byte{}, privateKey...), 0x01)
	return base58.CheckEncode(payload, version)
}

func FileSHA256(file string) (string, error) {
	f, err := os.Open(file)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
