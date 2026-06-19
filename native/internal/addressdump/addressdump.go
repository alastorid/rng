package addressdump

import (
	"bufio"
	"compress/gzip"
	"io"
	"math/big"
	"os"
	"path/filepath"
	"strings"
)

type Record struct {
	Address     string
	BalanceSats *big.Int
	BalanceBTC  string
	Source      string
}

type Dataset struct {
	Records map[string]Record
	Count   int
}

func Load(file string) (*Dataset, error) {
	f, err := os.Open(file)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	var reader io.Reader = f
	if strings.HasSuffix(file, ".gz") {
		gz, err := gzip.NewReader(f)
		if err != nil {
			return nil, err
		}
		defer gz.Close()
		reader = gz
	}

	ds := &Dataset{Records: make(map[string]Record)}
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 1024), 1024*1024)
	lineNo := 0
	for scanner.Scan() {
		lineNo++
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if lineNo == 1 && strings.HasPrefix(strings.ToLower(line), "address") {
			continue
		}
		delimiter := "\t"
		if !strings.Contains(line, "\t") {
			delimiter = ","
		}
		parts := strings.Split(line, delimiter)
		if len(parts) < 2 {
			continue
		}
		balance, ok := new(big.Int).SetString(parts[1], 10)
		if !ok || balance.Sign() <= 0 {
			continue
		}
		record := Record{
			Address:     parts[0],
			BalanceSats: balance,
			BalanceBTC:  satsToBTC(balance),
			Source:      "address-dump:" + filepath.Base(file),
		}
		if len(parts) >= 3 && parts[2] != "" {
			record.BalanceBTC = parts[2]
		}
		if len(parts) >= 5 && parts[4] != "" {
			record.Source = parts[4]
		}
		ds.Records[record.Address] = record
		ds.Count++
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return ds, nil
}

func (d *Dataset) Lookup(address string) (Record, bool) {
	record, ok := d.Records[address]
	return record, ok
}

func satsToBTC(sats *big.Int) string {
	divisor := big.NewInt(100_000_000)
	whole := new(big.Int).Div(sats, divisor)
	frac := new(big.Int).Mod(sats, divisor).String()
	return whole.String() + "." + strings.Repeat("0", 8-len(frac)) + frac
}
