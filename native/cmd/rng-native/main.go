package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"time"

	"github.com/alastorid/rng/native/internal/addressdump"
	"github.com/alastorid/rng/native/internal/btc"
	"github.com/alastorid/rng/native/internal/engine"
	"github.com/alastorid/rng/native/internal/opencl"
)

const defaultMinRecords = 1_000_000

func main() {
	var (
		addressDump     = flag.String("address-dump", "data/blockchair_bitcoin_addresses_latest.tsv.gz", "Blockchair-style address<TAB>balance dump (.tsv, .csv, or .gz)")
		backend         = flag.String("backend", "cpu", "backend: cpu or opencl")
		platform        = flag.Int("platform", 0, "OpenCL platform index")
		device          = flag.Int("device", 0, "OpenCL device index")
		listDevices     = flag.Bool("list-devices", false, "list available compute devices")
		samples         = flag.Int("samples", 10, "number of private keys to sample")
		continuous      = flag.Bool("continuous", false, "run until interrupted")
		delayMS         = flag.Int("delay-ms", 0, "delay between samples")
		minRecords      = flag.Int("min-records", defaultMinRecords, "minimum address records required for full-dataset runs")
		allowSmallDump  = flag.Bool("allow-small-dump", false, "allow small seed/test dumps")
		proofLog        = flag.String("proof-log", "logs/native-hits.jsonl", "hit proof log path")
		progressEvery   = flag.Int("progress-every", 1000, "print progress every N sampled keys")
		storePrivateKey = flag.Bool("store-hit-keys-plain", true, "store hit private keys in proof log")
	)
	flag.Parse()

	if *listDevices {
		if err := opencl.ListDevices(os.Stdout); err != nil {
			log.Fatal(err)
		}
		return
	}
	if *backend != "cpu" && *backend != "opencl" {
		log.Fatalf("unsupported backend %q", *backend)
	}
	if *backend == "opencl" {
		log.Fatalf("OpenCL backend selected (platform=%d device=%d), but GPU kernels are not implemented in this release; use --backend cpu", *platform, *device)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	fmt.Printf("Loading address dump: %s\n", *addressDump)
	dataset, err := addressdump.Load(*addressDump)
	if err != nil {
		log.Fatal(err)
	}
	if !*allowSmallDump && dataset.Count < *minRecords {
		log.Fatalf("address dump has only %d rows; refusing to treat it as full real dataset. Use the complete dump or pass --allow-small-dump for seed tests", dataset.Count)
	}
	if err := os.MkdirAll(filepath.Dir(*proofLog), 0o755); err != nil {
		log.Fatal(err)
	}
	hitFile, err := os.OpenFile(*proofLog, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		log.Fatal(err)
	}
	defer hitFile.Close()

	digest, _ := btc.FileSHA256(*addressDump)
	runID := fmt.Sprintf("%s-%s", time.Now().UTC().Format("20060102T150405Z"), randomHex(4))
	stats := engine.Stats{}
	start := time.Now()
	fmt.Printf("Run %s backend=cpu os=%s arch=%s dataset_records=%d dataset_sha256=%s\n", runID, runtime.GOOS, runtime.GOARCH, dataset.Count, digest)

	for i := 1; *continuous || i <= *samples; i++ {
		select {
		case <-ctx.Done():
			printFinal(stats, start)
			return
		default:
		}

		result, err := engine.SampleCPU()
		if err != nil {
			log.Fatal(err)
		}
		stats.SampledKeys++

		for _, candidate := range result.Candidates {
			stats.CheckedAddresses++
			if record, ok := dataset.Lookup(candidate.Address); ok {
				stats.Hits++
				stats.HasBalance++
				hit := engine.HitRecord{
					RunID:                  runID,
					At:                     time.Now().UTC().Format(time.RFC3339Nano),
					Backend:                "cpu",
					Address:                candidate.Address,
					AddressType:            candidate.Type,
					BalanceSats:            record.BalanceSats.String(),
					BalanceBTC:             record.BalanceBTC,
					DatasetSource:          *addressDump,
					DatasetSHA256:          digest,
					PublicKeyCompressedHex: result.PublicKeyCompressedHex,
				}
				if *storePrivateKey {
					hit.PrivateKeyHex = hex.EncodeToString(result.PrivateKey)
					hit.WIFCompressed = btc.WIFCompressed(result.PrivateKey, true)
				}
				if err := json.NewEncoder(hitFile).Encode(hit); err != nil {
					log.Fatal(err)
				}
				fmt.Printf("HIT %s %s balance=%s sats\n", candidate.Type, candidate.Address, record.BalanceSats.String())
			}
		}

		if *progressEvery > 0 && stats.SampledKeys%uint64(*progressEvery) == 0 {
			fmt.Printf("progress sampled=%d checked=%d hits=%d rate=%.0f keys/sec\n", stats.SampledKeys, stats.CheckedAddresses, stats.Hits, stats.KeysPerSecond(start))
		}
		if *delayMS > 0 {
			time.Sleep(time.Duration(*delayMS) * time.Millisecond)
		}
	}

	printFinal(stats, start)
}

func printFinal(stats engine.Stats, start time.Time) {
	fmt.Printf("Completed sampled=%d checked=%d hits=%d has_balance=%d rate=%.0f keys/sec elapsed=%s\n",
		stats.SampledKeys,
		stats.CheckedAddresses,
		stats.Hits,
		stats.HasBalance,
		stats.KeysPerSecond(start),
		time.Since(start).Round(time.Millisecond),
	)
}

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}
