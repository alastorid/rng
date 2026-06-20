package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"sync"
	"sync/atomic"
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
		progressEvery   = flag.Int("progress-every", 0, "deprecated; use --progress-interval")
		progressInterval = flag.Duration("progress-interval", 5*time.Second, "status update interval, e.g. 5s")
		workers         = flag.Int("workers", runtime.NumCPU(), "CPU worker count for the CPU backend")
		storePrivateKey = flag.Bool("store-hit-keys-plain", true, "store hit private keys in proof log")
	)
	flag.Parse()
	_ = progressEvery

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
	if *workers < 1 {
		log.Fatalf("--workers must be >= 1")
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
	stats := &runtimeStats{}
	start := time.Now()
	fmt.Printf("Run %s backend=cpu os=%s arch=%s workers=%d dataset_records=%d dataset_sha256=%s\n", runID, runtime.GOOS, runtime.GOARCH, *workers, dataset.Count, digest)

	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	var nextSample atomic.Uint64
	var hitMu sync.Mutex
	errCh := make(chan error, 1)
	var wg sync.WaitGroup

	reportErr := func(err error) {
		select {
		case errCh <- err:
			cancel()
		default:
		}
	}

	for workerID := 0; workerID < *workers; workerID++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-runCtx.Done():
					return
				default:
				}

				if !*continuous {
					index := nextSample.Add(1)
					if index > uint64(*samples) {
						return
					}
				}
				result, err := engine.SampleCPU()
				if err != nil {
					reportErr(err)
					return
				}
				stats.sampledKeys.Add(1)

				for _, candidate := range result.Candidates {
					stats.checkedAddresses.Add(1)
					if record, ok := dataset.Lookup(candidate.Address); ok {
						stats.hits.Add(1)
						stats.hasBalance.Add(1)
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
						hitMu.Lock()
						if err := json.NewEncoder(hitFile).Encode(hit); err != nil {
							hitMu.Unlock()
							reportErr(err)
							return
						}
						hitMu.Unlock()
						fmt.Printf("HIT %s %s balance=%s sats\n", candidate.Type, candidate.Address, record.BalanceSats.String())
					}
				}

				if *delayMS > 0 {
					time.Sleep(time.Duration(*delayMS) * time.Millisecond)
				}
			}
		}()
	}

	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()

	var ticker *time.Ticker
	var tickerC <-chan time.Time
	if *progressInterval > 0 {
		ticker = time.NewTicker(*progressInterval)
		defer ticker.Stop()
		tickerC = ticker.C
	}

	for {
		select {
		case err := <-errCh:
			log.Fatal(err)
		case <-tickerC:
			printProgress(stats.snapshot(), start)
		case <-done:
			printFinal(stats.snapshot(), start)
			return
		case <-ctx.Done():
			cancel()
		}
	}
}

type runtimeStats struct {
	sampledKeys      atomic.Uint64
	checkedAddresses atomic.Uint64
	hits             atomic.Uint64
	hasBalance       atomic.Uint64
}

type statsSnapshot struct {
	sampledKeys      uint64
	checkedAddresses uint64
	hits             uint64
	hasBalance       uint64
}

func (s *runtimeStats) snapshot() statsSnapshot {
	return statsSnapshot{
		sampledKeys:      s.sampledKeys.Load(),
		checkedAddresses: s.checkedAddresses.Load(),
		hits:             s.hits.Load(),
		hasBalance:       s.hasBalance.Load(),
	}
}

func (s statsSnapshot) keysPerSecond(start time.Time) float64 {
	elapsed := time.Since(start).Seconds()
	if elapsed == 0 {
		return 0
	}
	return float64(s.sampledKeys) / elapsed
}

func printProgress(stats statsSnapshot, start time.Time) {
	fmt.Printf("status elapsed=%s sampled=%d checked=%d hits=%d rate=%.0f keys/sec\n",
		time.Since(start).Round(time.Second),
		stats.sampledKeys,
		stats.checkedAddresses,
		stats.hits,
		stats.keysPerSecond(start),
	)
}

func printFinal(stats statsSnapshot, start time.Time) {
	fmt.Printf("Completed sampled=%d checked=%d hits=%d has_balance=%d rate=%.0f keys/sec elapsed=%s\n",
		stats.sampledKeys,
		stats.checkedAddresses,
		stats.hits,
		stats.hasBalance,
		stats.keysPerSecond(start),
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
