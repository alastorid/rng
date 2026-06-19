package engine

import (
	"crypto/rand"
	"encoding/hex"
	"time"

	"github.com/alastorid/rng/native/internal/btc"
	"github.com/btcsuite/btcd/btcec/v2"
)

type Candidate struct {
	Type    string
	Address string
}

type SampleResult struct {
	PrivateKey             []byte
	PublicKeyCompressedHex string
	Candidates             []Candidate
}

type HitRecord struct {
	RunID                  string `json:"run_id"`
	At                     string `json:"at"`
	Backend                string `json:"backend"`
	Address                string `json:"address"`
	AddressType            string `json:"address_type"`
	BalanceSats            string `json:"balance_sats"`
	BalanceBTC             string `json:"balance_btc"`
	DatasetSource          string `json:"dataset_source"`
	DatasetSHA256          string `json:"dataset_sha256"`
	PublicKeyCompressedHex string `json:"public_key_compressed_hex"`
	PrivateKeyHex          string `json:"private_key_hex,omitempty"`
	WIFCompressed          string `json:"wif_compressed,omitempty"`
}

type Stats struct {
	SampledKeys      uint64
	CheckedAddresses uint64
	Hits             uint64
	HasBalance       uint64
}

func (s Stats) KeysPerSecond(start time.Time) float64 {
	elapsed := time.Since(start).Seconds()
	if elapsed == 0 {
		return 0
	}
	return float64(s.SampledKeys) / elapsed
}

func SampleCPU() (SampleResult, error) {
	privateKey := make([]byte, 32)
	for {
		if _, err := rand.Read(privateKey); err != nil {
			return SampleResult{}, err
		}
		priv, pub := btcec.PrivKeyFromBytes(privateKey)
		if priv == nil || pub == nil {
			continue
		}
		pubCompressed := pub.SerializeCompressed()
		hash160 := btc.Hash160(pubCompressed)
		p2wpkh, err := btc.P2WPKH(hash160, true)
		if err != nil {
			return SampleResult{}, err
		}
		return SampleResult{
			PrivateKey:             append([]byte{}, privateKey...),
			PublicKeyCompressedHex: hex.EncodeToString(pubCompressed),
			Candidates: []Candidate{
				{Type: "p2pkh-compressed", Address: btc.P2PKH(hash160, true)},
				{Type: "p2wpkh", Address: p2wpkh},
			},
		}, nil
	}
}
