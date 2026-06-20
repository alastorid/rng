# BitCrack OpenCL Kernel Vendor Copy

Source:

```text
https://github.com/brichard19/BitCrack
```

License:

```text
MIT
```

These files are vendored as the starting point for the real OpenCL backend:

- `secp256k1.cl`
- `sha256.cl`
- `ripemd160.cl`
- `keysearch.cl`
- `bitcrack.cl`

The current `rng-native` runtime does not yet execute these kernels. They are included so the OpenCL implementation can be built on a proven secp256k1/hash kernel base instead of inventing curve math from scratch.
