#define COMPRESSED 0
#define UNCOMPRESSED 1
#define BOTH 2
#define BLOOM_HASHES 4

unsigned int endian(unsigned int x)
{
    return (x << 24) | ((x << 8) & 0x00ff0000) | ((x >> 8) & 0x0000ff00) | (x >> 24);
}

typedef struct {
    int idx;
    bool compressed;
    unsigned int x[8];
    unsigned int y[8];
    unsigned int digest[5];
    unsigned int keyOffsetLo;
    unsigned int keyOffsetHi;
}CLDeviceResult;

ulong rotl64(ulong x, int k)
{
    return (x << k) | (x >> (64 - k));
}

ulong mixRng64(ulong x)
{
    x ^= x >> 30;
    x *= 0xbf58476d1ce4e5b9UL;
    x ^= x >> 27;
    x *= 0x94d049bb133111ebUL;
    x ^= x >> 31;
    return x;
}

uint rngWord(ulong seed, ulong iteration, uint idx, uint word)
{
    ulong x = seed;
    x ^= ((ulong)idx + 0x9e3779b97f4a7c15UL) * 0xbf58476d1ce4e5b9UL;
    x ^= rotl64(iteration + 0x94d049bb133111ebUL, (int)((word * 11 + 7) & 63));
    x ^= ((ulong)word + 1UL) * 0x9e3779b97f4a7c15UL;
    return (uint)(mixRng64(x) >> 32);
}

void applyPartialRng(__private uint *word, int oddBit, int evenBit)
{
    const uint oddMask = 0xaaaaaaaaU;
    const uint evenMask = 0x55555555U;

    if(oddBit >= 0) {
        *word = oddBit ? (*word | oddMask) : (*word & ~oddMask);
    }

    if(evenBit >= 0) {
        *word = evenBit ? (*word | evenMask) : (*word & ~evenMask);
    }
}

bool isZeroKey(uint256_t k)
{
    uint v = 0;
    for(int i = 0; i < 8; i++) {
        v |= k.v[i];
    }
    return v == 0;
}

__kernel void rngPrivateKeysKernel(
    unsigned int totalPoints,
    ulong seed,
    ulong iteration,
    int oddBit,
    int evenBit,
    __global uint256_t* privateKeys,
    __global uint256_t* xPtr,
    __global uint256_t* yPtr)
{
    int gid = get_local_size(0) * get_group_id(0) + get_local_id(0);
    int dim = get_global_size(0);

    for(int i = gid; i < totalPoints; i += dim) {
        uint256_t k;
        int oddMode = oddBit;
        int evenMode = evenBit;

        if(oddBit == -2 && evenBit == -2) {
            int mode = i % 5;

            oddMode = -1;
            evenMode = -1;

            if(mode == 1) {
                oddMode = 0;
            } else if(mode == 2) {
                oddMode = 1;
            } else if(mode == 3) {
                evenMode = 0;
            } else if(mode == 4) {
                evenMode = 1;
            }
        }

        for(uint word = 0; word < 8; word++) {
            uint v = rngWord(seed, iteration, (uint)i, word);
            applyPartialRng(&v, oddMode, evenMode);
            k.v[word] = v;
        }

        // Keep generated keys inside secp256k1's scalar range by using 255 bits.
        k.v[0] &= 0x7fffffffU;

        if(isZeroKey(k)) {
            if(evenMode != 0) {
                k.v[7] = 1U;
            } else {
                k.v[7] = 2U;
            }
        }

        store256k(privateKeys, i, k);

        uint256_t infinity = { {0xffffffffU, 0xffffffffU, 0xffffffffU, 0xffffffffU, 0xffffffffU, 0xffffffffU, 0xffffffffU, 0xffffffffU} };
        store256k(xPtr, i, infinity);
        store256k(yPtr, i, infinity);
    }
}

bool isInList(unsigned int hash[5], __global unsigned int *targetList, size_t numTargets)
{
    bool found = false;

    for(size_t i = 0; i < numTargets; i++) {
        int equal = 0;

        for(int j = 0; j < 5; j++) {
            if(hash[j] == targetList[5 * i + j]) {
                equal++;
            }
        }

        if(equal == 5) {
            found = true;
        }
    }

    return found;
}

bool isInBloomFilter(unsigned int hash[5], __global unsigned int *targetList, ulong mask)
{
    bool foundMatch = true;

    unsigned int h5 = 0;

    for(int i = 0; i < 5; i++) {
        h5 += hash[i];
    }

    ulong idx[BLOOM_HASHES];

    idx[0] = ((hash[0] << 6) | (h5 & 0x3f)) & mask;
    idx[1] = ((hash[1] << 6) | ((h5 >> 6) & 0x3f)) & mask;
    idx[2] = ((hash[2] << 6) | ((h5 >> 12) & 0x3f)) & mask;
    idx[3] = ((hash[3] << 6) | ((h5 >> 18) & 0x3f)) & mask;

    for(int i = 0; i < BLOOM_HASHES; i++) {
        ulong j = idx[i];
        unsigned int f = targetList[j / 32];

        if((f & (0x01 << (uint)(j % 32))) == 0) {
            foundMatch = false;
        }
    }

    return foundMatch;
}

bool checkHash(unsigned int hash[5], __global unsigned int *targetList, size_t numTargets, ulong mask)
{
    if(numTargets > 16) {
        return isInBloomFilter(hash, targetList, mask);
    } else {
        return isInList(hash, targetList, numTargets);
    }
}


void doRMD160FinalRound(const unsigned int hIn[5], unsigned int hOut[5])
{
    const unsigned int iv[5] = {
        0x67452301,
        0xefcdab89,
        0x98badcfe,
        0x10325476,
        0xc3d2e1f0
    };

    for(int i = 0; i < 5; i++) {
        hOut[i] = endian(hIn[i] + iv[(i + 1) % 5]);
    }
}


__kernel void multiplyStepKernel(
    int totalPoints,
    int step,
    __global uint256_t* privateKeys,
    __global uint256_t* chain,
    __global uint256_t* gxPtr,
    __global uint256_t* gyPtr,
    __global uint256_t* xPtr,
    __global uint256_t* yPtr)
{
    uint256_t gx;
    uint256_t gy;
    int gid = get_local_size(0) * get_group_id(0) + get_local_id(0);
    int dim = get_global_size(0);

    gx = load256k(gxPtr, step);
    gy = load256k(gyPtr, step);

    // Multiply together all (_Gx - x) and then invert
    uint256_t inverse = { {0,0,0,0,0,0,0,1} };

    int batchIdx = 0;
    int i = gid;
    for(; i < totalPoints; i += dim) {

        unsigned int p;
        p = readWord256k(privateKeys, i, 7 - step / 32);

        unsigned int bit = p & (1 << (step % 32));

        uint256_t x = load256k(xPtr, i);

        if(bit != 0) {
            if(!isInfinity256k(x)) {
                beginBatchAddWithDouble256k(gx, gy, xPtr, chain, i, batchIdx, &inverse);
                batchIdx++;
            }
        }
    }

    //doBatchInverse(inverse);
    inverse = doBatchInverse256k(inverse);

    i -= dim;
    for(; i >= 0; i -= dim) {
        uint256_t newX;
        uint256_t newY;

        unsigned int p;
        p = readWord256k(privateKeys, i, 7 - step / 32);
        unsigned int bit = p & (1 << (step % 32));

        uint256_t x = load256k(xPtr, i);
        bool infinity = isInfinity256k(x);

        if(bit != 0) {
            if(!infinity) {
                batchIdx--;
                completeBatchAddWithDouble256k(gx, gy, xPtr, yPtr, i, batchIdx, chain, &inverse, &newX, &newY);
            } else {
                newX = gx;
                newY = gy;
            }

            store256k(xPtr, i, newX);
            store256k(yPtr, i, newY);
        }
    }
}


void hashPublicKey(uint256_t x, uint256_t y, __private unsigned int* digestOut)
{
    unsigned int hash[8];

    sha256PublicKey(x.v, y.v, hash);

    // Swap to little-endian
    for(int i = 0; i < 8; i++) {
        hash[i] = endian(hash[i]);
    }

    ripemd160sha256NoFinal(hash, digestOut);
}

void hashPublicKeyCompressed(uint256_t x, unsigned int yParity, __private unsigned int* digestOut)
{
    unsigned int hash[8];

    sha256PublicKeyCompressed(x.v, yParity, hash);

    // Swap to little-endian
    for(int i = 0; i < 8; i++) {
        hash[i] = endian(hash[i]);
    }

    ripemd160sha256NoFinal(hash, digestOut);

}

void atomicListAdd(__global CLDeviceResult *results, __global unsigned int *numResults, unsigned int maxResults, __private CLDeviceResult *r)
{
    unsigned int count = atomic_add(numResults, 1);

    if(count < maxResults) {
        results[count] = *r;
    }
}

void setResultFound(int idx, bool compressed, uint256_t x, uint256_t y, __private unsigned int digest[5], __global CLDeviceResult* results, __global unsigned int* numResults, unsigned int maxResults, ulong keyOffset)
{
    CLDeviceResult r;

    r.idx = idx;
    r.compressed = compressed;

    for(int i = 0; i < 8; i++) {
        r.x[i] = x.v[i];
        r.y[i] = y.v[i];
    }

    doRMD160FinalRound(digest, r.digest);
    r.keyOffsetLo = (unsigned int)(keyOffset & 0xffffffffUL);
    r.keyOffsetHi = (unsigned int)(keyOffset >> 32);

    atomicListAdd(results, numResults, maxResults, &r);
}

void doIteration(
    size_t totalPoints,
    int compression,
    __global uint256_t* chain,
    __global uint256_t* xPtr,
    __global uint256_t* yPtr,
    __global uint256_t* incXPtr,
    __global uint256_t* incYPtr,
    __global unsigned int *targetList,
    size_t numTargets,
    ulong mask,
    __global CLDeviceResult *results,
    __global unsigned int *numResults,
    unsigned int maxResults,
    ulong keyOffset)
{
    int gid = get_local_size(0) * get_group_id(0) + get_local_id(0);
    int dim = get_global_size(0);

    uint256_t incX = load256k(incXPtr, 0);
    uint256_t incY = load256k(incYPtr, 0);

    // Multiply together all (_Gx - x) and then invert
    uint256_t inverse = { {0,0,0,0,0,0,0,1} };
    int i = gid;
    int batchIdx = 0;

    for(; i < totalPoints; i += dim) {
        uint256_t x;

        unsigned int digest[5];

        x = load256k(xPtr, i);

        if((compression == UNCOMPRESSED) || (compression == BOTH)) {
            uint256_t y = load256k(yPtr, i);

            hashPublicKey(x, y, digest);

            if(checkHash(digest, targetList, numTargets, mask)) {
                setResultFound(i, false, x, y, digest, results, numResults, maxResults, keyOffset);
            }
        }

        if((compression == COMPRESSED) || (compression == BOTH)) {

            hashPublicKeyCompressed(x, readLSW256k(yPtr, i), digest);

            if(checkHash(digest, targetList, numTargets, mask)) {
                uint256_t y = load256k(yPtr, i);
                setResultFound(i, true, x, y, digest, results, numResults, maxResults, keyOffset);
            }
        }

        beginBatchAdd256k(incX, x, chain, i, batchIdx, &inverse);
        batchIdx++;
    }

    inverse = doBatchInverse256k(inverse);

    i -= dim;

    for(;  i >= 0; i -= dim) {

        uint256_t newX;
        uint256_t newY;
        batchIdx--;
        completeBatchAdd256k(incX, incY, xPtr, yPtr, i, batchIdx, chain, &inverse, &newX, &newY);

        store256k(xPtr, i, newX);
        store256k(yPtr, i, newY);
    }
}


void doIterationWithDouble(
    size_t totalPoints,
    int compression,
    __global uint256_t* chain,
    __global uint256_t* xPtr,
    __global uint256_t* yPtr,
    __global uint256_t* incXPtr,
    __global uint256_t* incYPtr,
    __global unsigned int* targetList,
    size_t numTargets,
    ulong mask,
    __global CLDeviceResult *results,
    __global unsigned int *numResults,
    unsigned int maxResults,
    ulong keyOffset)
{
    int gid = get_local_size(0) * get_group_id(0) + get_local_id(0);
    int dim = get_global_size(0);

    uint256_t incX = load256k(incXPtr, 0);
    uint256_t incY = load256k(incYPtr, 0);

    // Multiply together all (_Gx - x) and then invert
    uint256_t inverse = { {0,0,0,0,0,0,0,1} };

    int i = gid;
    int batchIdx = 0;
    for(; i < totalPoints; i += dim) {
        uint256_t x;

        unsigned int digest[5];

        x = load256k(xPtr, i);

        // uncompressed
        if((compression == UNCOMPRESSED) || (compression == BOTH)) {
            uint256_t y = load256k(yPtr, i);
            hashPublicKey(x, y, digest);

            if(checkHash(digest, targetList, numTargets, mask)) {
                setResultFound(i, false, x, y, digest, results, numResults, maxResults, keyOffset);
            }
        }

        // compressed
        if((compression == COMPRESSED) || (compression == BOTH)) {

            hashPublicKeyCompressed(x, readLSW256k(yPtr, i), digest);

            if(checkHash(digest, targetList, numTargets, mask)) {

                uint256_t y = load256k(yPtr, i);
                setResultFound(i, true, x, y, digest, results, numResults, maxResults, keyOffset);
            }
        }

        beginBatchAddWithDouble256k(incX, incY, xPtr, chain, i, batchIdx, &inverse);
        batchIdx++;
    }

    inverse = doBatchInverse256k(inverse);

    i -= dim;

    for(; i >= 0; i -= dim) {
        uint256_t newX;
        uint256_t newY;
        batchIdx--;
        completeBatchAddWithDouble256k(incX, incY, xPtr, yPtr, i, batchIdx, chain, &inverse, &newX, &newY);

        store256k(xPtr, i, newX);
        store256k(yPtr, i, newY);
    }
}

/**
* Performs a single iteration
*/
__kernel void keyFinderKernel(
    unsigned int totalPoints,
    int compression,
    __global uint256_t* chain,
    __global uint256_t* xPtr,
    __global uint256_t* yPtr,
    __global uint256_t* incXPtr,
    __global uint256_t* incYPtr,
    __global unsigned int* targetList,
    ulong numTargets,
    ulong mask,
    __global CLDeviceResult *results,
    __global unsigned int *numResults,
    unsigned int maxResults,
    ulong keyOffset)
{
    doIteration(totalPoints, compression, chain, xPtr, yPtr, incXPtr, incYPtr, targetList, numTargets, mask, results, numResults, maxResults, keyOffset);
}

__kernel void keyFinderKernelWithDouble(
    unsigned int totalPoints,
    int compression,
    __global uint256_t* chain,
    __global uint256_t* xPtr,
    __global uint256_t* yPtr,
    __global uint256_t* incXPtr,
    __global uint256_t* incYPtr,
    __global unsigned int* targetList,
    ulong numTargets,
    ulong mask,
    __global CLDeviceResult *results,
    __global unsigned int *numResults,
    unsigned int maxResults,
    ulong keyOffset)
{
    doIterationWithDouble(totalPoints, compression, chain, xPtr, yPtr, incXPtr, incYPtr, targetList, numTargets, mask, results, numResults, maxResults, keyOffset);
}
