#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#ifdef _WIN32
#include <Windows.h>
#include <bcrypt.h>
#endif
#include "Logger.h"
#include "util.h"
#include "CLKeySearchDevice.h"

// Defined in bitcrack_cl.cpp which gets build in the pre-build event
extern char _bitcrack_cl[];

static const int BLOOM_HASHES = 4;
static const int DEFAULT_BLOOM_LEVEL = 8;
static const int DEFAULT_ISLAND_LEVEL = 4;

static int getBloomLevel()
{
    const char *env = std::getenv("RNG_BLOOM_LEVEL");
    uint64_t level = DEFAULT_BLOOM_LEVEL;

    if(env != NULL && env[0] != '\0') {
        try {
            std::string value = util::toLower(std::string(env));
            if(value.find("bloom") == 0) {
                value = value.substr(5);
            }
            level = util::parseUInt64(value);
        } catch(...) {
            level = DEFAULT_BLOOM_LEVEL;
        }
    }

    if(level > 9) {
        level = 9;
    }

    return (int)level;
}

static uint64_t getBloomBitsPerTarget(int level)
{
    static const uint64_t bitsPerTarget[] = {
        4, 6, 8, 12, 16, 24, 32, 64, 128, 256
    };

    return bitsPerTarget[level];
}

static int getIslandLevel()
{
    const char *env = std::getenv("RNG_ISLAND_LEVEL");
    uint64_t level = DEFAULT_ISLAND_LEVEL;

    if(env != NULL && env[0] != '\0') {
        try {
            std::string value = util::toLower(std::string(env));
            if(value.find("island") == 0) {
                value = value.substr(6);
            }
            level = util::parseUInt64(value);
        } catch(...) {
            level = DEFAULT_ISLAND_LEVEL;
        }
    }

    if(level > 9) {
        level = 9;
    }

    return (int)level;
}

static uint64_t getIslandSteps(int level)
{
    return 4096ULL << level;
}

static uint64_t nextPowerOfTwo(uint64_t value)
{
    uint64_t p = 1;
    while(p < value && p < (1ULL << 63)) {
        p <<= 1;
    }

    return p;
}

static void secureRandomBytes(unsigned char *buf, size_t count)
{
#ifdef _WIN32
    NTSTATUS status = BCryptGenRandom(NULL, buf, (ULONG)count, BCRYPT_USE_SYSTEM_PREFERRED_RNG);
    if(status < 0) {
        throw KeySearchException("OS CSPRNG failed: BCryptGenRandom");
    }
#else
    FILE *fp = fopen("/dev/urandom", "rb");

    if(fp == NULL) {
        throw KeySearchException("OS CSPRNG failed: cannot open /dev/urandom");
    }

    size_t got = fread(buf, 1, count, fp);
    fclose(fp);

    if(got != count) {
        throw KeySearchException("OS CSPRNG failed: short read from /dev/urandom");
    }
#endif
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


static void undoRMD160FinalRound(const unsigned int hIn[5], unsigned int hOut[5])
{
    unsigned int iv[5] = {
        0x67452301,
        0xefcdab89,
        0x98badcfe,
        0x10325476,
        0xc3d2e1f0
    };

    for(int i = 0; i < 5; i++) {
        hOut[i] = util::endian(hIn[i]) - iv[(i + 1) % 5];
    }
}

CLKeySearchDevice::CLKeySearchDevice(uint64_t device, int threads, int pointsPerThread, int blocks, bool rngMode, int rngOddBit, int rngEvenBit, bool selfTest, const unsigned int *selfTestKey, unsigned int selfTestIndex)
{
    _threads = threads;
    _blocks = blocks;
    _points = pointsPerThread * threads * blocks;
    _device = (cl_device_id)device;
    _rngMode = rngMode;
    _rngOddBit = rngOddBit;
    _rngEvenBit = rngEvenBit;
    _selfTest = selfTest;
    _selfTestIndex = selfTestIndex;
    if(_rngMode) {
        secureRandomBytes((unsigned char *)_rngSeed, sizeof(_rngSeed));
    }

    if(_selfTest && selfTestKey != NULL) {
        memcpy(_selfTestKey, selfTestKey, sizeof(_selfTestKey));
    }

    if(threads <= 0 || threads % 32 != 0) {
        throw KeySearchException("The number of threads must be a multiple of 32");
    }

    if(pointsPerThread <= 0) {
        throw KeySearchException("At least 1 point per thread required");
    }

    try {
        // Create the context
        _clContext = new cl::CLContext(_device);
        Logger::log(LogLevel::Info, "Compiling OpenCL kernels...");
        _clProgram = new cl::CLProgram(*_clContext, _bitcrack_cl);

        // Load the kernels
        _initKeysKernel = new cl::CLKernel(*_clProgram, "multiplyStepKernel");
        _initKeysKernel->getWorkGroupSize();

        _stepKernel = new cl::CLKernel(*_clProgram, "keyFinderKernel");
        _stepKernelWithDouble = new cl::CLKernel(*_clProgram, "keyFinderKernelWithDouble");
        _rngKernel = new cl::CLKernel(*_clProgram, "rngPrivateKeysKernel");

        _globalMemSize = _clContext->getGlobalMemorySize();

        _deviceName = _clContext->getDeviceName();
    } catch(cl::CLException ex) {
        throw KeySearchException("OpenCL setup failed: " + ex.msg);
    }

    _iterations = 0;
}

CLKeySearchDevice::~CLKeySearchDevice()
{
    _clContext->free(_x);
    _clContext->free(_y);
    _clContext->free(_xTable);
    _clContext->free(_yTable);
    _clContext->free(_xInc);
    _clContext->free(_yInc);
    _clContext->free(_deviceResults);
    _clContext->free(_deviceResultsCount);
    _clContext->free(_rngSeedMem);

    delete _stepKernel;
    delete _stepKernelWithDouble;
    delete _rngKernel;
    delete _initKeysKernel;
    delete _clContext;
}

uint64_t CLKeySearchDevice::getOptimalBloomFilterMask(double p, size_t n)
{
    double targetBit = std::pow(p, 1.0 / (double)BLOOM_HASHES);
    double m = std::ceil((-(double)BLOOM_HASHES * (double)n) / std::log(1.0 - targetBit));

    unsigned int bits = (unsigned int)std::ceil(std::log(m) / std::log(2));

    return ((uint64_t)1 << bits) - 1;
}

void CLKeySearchDevice::initializeBloomFilter(const std::vector<struct hash160> &targets, uint64_t mask)
{
    size_t sizeInWords = (mask + 1) / 32;

    uint32_t *buf = new uint32_t[sizeInWords];

    for(size_t i = 0; i < sizeInWords; i++) {
        buf[i] = 0;
    }

    for(unsigned int k = 0; k < targets.size(); k++) {

        unsigned int hash[5];
        unsigned int h5 = 0;

        uint64_t idx[BLOOM_HASHES];

        undoRMD160FinalRound(targets[k].h, hash);

        for(int i = 0; i < 5; i++) {
            h5 += hash[i];
        }

        idx[0] = ((hash[0] << 6) | (h5 & 0x3f)) & mask;
        idx[1] = ((hash[1] << 6) | ((h5 >> 6) & 0x3f)) & mask;
        idx[2] = ((hash[2] << 6) | ((h5 >> 12) & 0x3f)) & mask;
        idx[3] = ((hash[3] << 6) | ((h5 >> 18) & 0x3f)) & mask;

        for(int i = 0; i < BLOOM_HASHES; i++) {
            uint64_t j = idx[i];
            buf[j / 32] |= 1U << (j % 32);
        }
    }


    _targetMemSize = sizeInWords * sizeof(uint32_t);

    _deviceTargetList.mask = mask;
    _deviceTargetList.ptr = _clContext->malloc(sizeInWords * sizeof(uint32_t));
    _deviceTargetList.size = targets.size();
    _clContext->copyHostToDevice(buf, _deviceTargetList.ptr, sizeInWords * sizeof(uint32_t));

    delete[] buf;
}

void CLKeySearchDevice::allocateBuffers()
{
    size_t numKeys = (size_t)_points;
    size_t size = numKeys * 8 * sizeof(unsigned int);
    _pointsMemSize = size * 4 + (size_t)_resultQueueCapacity * sizeof(CLDeviceResult);

    // X values
    _x = _clContext->malloc(size);
    _clContext->memset(_x, -1, size);

    // Y values
    _y = _clContext->malloc(size);
    _clContext->memset(_y, -1, size);

    // Multiplicaiton chain for batch inverse
    _chain = _clContext->malloc(size);

    // RNG mode writes private keys on-device before the point initialization pass.
    _privateKeys = _clContext->malloc(size, _rngMode ? CL_MEM_READ_WRITE : CL_MEM_READ_ONLY);

    if(_rngMode) {
        _rngSeedMem = _clContext->malloc(sizeof(_rngSeed), CL_MEM_READ_ONLY);
        _clContext->copyHostToDevice(_rngSeed, _rngSeedMem, sizeof(_rngSeed));
    }

    // Lookup table for initialization
    _xTable = _clContext->malloc(256 * 8 * sizeof(unsigned int), CL_MEM_READ_ONLY);
    _yTable = _clContext->malloc(256 * 8 * sizeof(unsigned int), CL_MEM_READ_ONLY);

    // Value to increment by
    _xInc = _clContext->malloc(8 * sizeof(unsigned int), CL_MEM_READ_ONLY);
    _yInc = _clContext->malloc(8 * sizeof(unsigned int), CL_MEM_READ_ONLY);

    // Buffer for storing results
    _deviceResults = _clContext->malloc((size_t)_resultQueueCapacity * sizeof(CLDeviceResult));
    _deviceResultsCount = _clContext->malloc(sizeof(unsigned int));
    unsigned int numResults = 0;
    _clContext->copyHostToDevice(&numResults, _deviceResultsCount, sizeof(unsigned int));
}

void CLKeySearchDevice::setIncrementor(secp256k1::ecpoint &p)
{
    unsigned int buf[8];

    p.x.exportWords(buf, 8, secp256k1::uint256::BigEndian);
    _clContext->copyHostToDevice(buf, _xInc, 8 * sizeof(unsigned int));

    p.y.exportWords(buf, 8, secp256k1::uint256::BigEndian);
    _clContext->copyHostToDevice(buf, _yInc, 8 * sizeof(unsigned int));
}

void CLKeySearchDevice::init(const secp256k1::uint256 &start, int compression, const secp256k1::uint256 &stride)
{
    if(start.cmp(secp256k1::N) >= 0) {
        throw KeySearchException("Starting key is out of range");
    }

    _start = start;

    _stride = stride;

    _compression = compression;

    try {
        allocateBuffers();

        if(_rngMode) {
            int islandLevel = getIslandLevel();
            _rngIslandSize = getIslandSteps(islandLevel);
            Logger::log(LogLevel::Info, "OpenCL RNG island mode enabled");
            Logger::log(LogLevel::Info, "RNG stream: OS CSPRNG seed + ChaCha20 on GPU");
            Logger::log(LogLevel::Info, "RNG island size: " + util::formatThousands(_rngIslandSize) + " steps, island" + util::format((uint32_t)islandLevel));
            _rngIslandOffset = 0;
            _rngIslandReady = false;
            initializeBasePoints();
        } else {
            generateStartingPoints();
        }

        // Set the incrementor
        secp256k1::ecpoint g = secp256k1::G();
        secp256k1::ecpoint p = _rngMode ? g : secp256k1::multiplyPoint(secp256k1::uint256((uint64_t)_points ) * _stride, g);

        setIncrementor(p);
    } catch(cl::CLException ex) {
        throw KeySearchException("OpenCL initialization failed: " + ex.msg);
    }
}

void CLKeySearchDevice::doStep()
{
    try {
        uint64_t numKeys = (uint64_t)_points;

        if(_rngMode) {
            if(!_rngIslandReady || _rngIslandOffset >= _rngIslandSize) {
                getResultsInternal(true);
                generateRandomStartingPoints();
                _rngIslandOffset = 0;
                _rngIslandReady = true;
            }

            _stepKernel->set_args(
                _points,
                _compression,
                _chain,
                _x,
                _y,
                _xInc,
                _yInc,
                _deviceTargetList.ptr,
                _deviceTargetList.size,
                _deviceTargetList.mask,
                _deviceResults,
                _deviceResultsCount,
                _resultQueueCapacity,
                (cl_ulong)_rngIslandOffset);
            _stepKernel->call(_blocks, _threads);
        } else if(_iterations < 2 && _start.cmp(numKeys) <= 0) {

            _stepKernelWithDouble->set_args(
                _points,
                _compression,
                _chain,
                _x,
                _y,
                _xInc,
                _yInc,
                _deviceTargetList.ptr,
                _deviceTargetList.size,
                _deviceTargetList.mask,
                _deviceResults,
                _deviceResultsCount,
                _resultQueueCapacity,
                (cl_ulong)_iterations);
            _stepKernelWithDouble->call(_blocks, _threads);
        } else {

            _stepKernel->set_args(
                _points,
                _compression,
                _chain,
                _x,
                _y,
                _xInc,
                _yInc,
                _deviceTargetList.ptr,
                _deviceTargetList.size,
                _deviceTargetList.mask,
                _deviceResults,
                _deviceResultsCount,
                _resultQueueCapacity,
                (cl_ulong)_iterations);
            _stepKernel->call(_blocks, _threads);
        }
        fflush(stdout);

        getResultsInternal(_selfTest);

        if(_selfTest && _results.empty() && _iterations >= 4) {
            throw KeySearchException("OpenCL self-test did not find the injected island key");
        }

        if(_rngMode) {
            _rngIslandOffset++;
        }

        _iterations++;
    } catch(cl::CLException ex) {
        throw KeySearchException("OpenCL step failed: " + ex.msg);
    }
}

void CLKeySearchDevice::setTargetsList()
{
    size_t count = _targetList.size();

    _targets = _clContext->malloc(5 * sizeof(unsigned int) * count);

    for(size_t i = 0; i < count; i++) {
        unsigned int h[5];

        undoRMD160FinalRound(_targetList[i].h, h);

        _clContext->copyHostToDevice(h, _targets, i * 5 * sizeof(unsigned int), 5 * sizeof(unsigned int));
    }

    _targetMemSize = count * 5 * sizeof(unsigned int);
    _deviceTargetList.ptr = _targets;
    _deviceTargetList.size = count;
    _deviceTargetList.mask = 0;
}

void CLKeySearchDevice::setBloomFilter()
{
    int bloomLevel = getBloomLevel();
    uint64_t bitsPerTarget = getBloomBitsPerTarget(bloomLevel);
    uint64_t bloomBits = nextPowerOfTwo((uint64_t)_targetList.size() * bitsPerTarget);
    uint64_t bloomFilterMask = bloomBits - 1;
    uint64_t maxBloomBytes = _globalMemSize / 4;

    if(_globalMemSize > _pointsMemSize) {
        maxBloomBytes = ((_globalMemSize - _pointsMemSize) * 3) / 4;
    }

    while(((bloomFilterMask + 1) / 8) > maxBloomBytes && bloomFilterMask > ((1ULL << 28) - 1)) {
        bloomFilterMask = (bloomFilterMask >> 1);
    }

    Logger::log(LogLevel::Info, "OpenCL bloom filter: " + util::formatThousands((bloomFilterMask + 1) / 8)
        + " bytes, " + util::format((uint32_t)BLOOM_HASHES) + " probes, bloom" + util::format((uint32_t)bloomLevel));

    initializeBloomFilter(_targetList, bloomFilterMask);
}

void CLKeySearchDevice::setTargetsInternal()
{
    // Clean up existing list
    if(_deviceTargetList.ptr != NULL) {
        _clContext->free(_deviceTargetList.ptr);
    }

    if(_targetList.size() < 16 && !_selfTest) {
        setTargetsList();
    } else {
        setBloomFilter();
    }
}

void CLKeySearchDevice::setTargets(const std::vector<KeySearchTarget> &targets)
{
    try {
        _targetList.clear();

        for(std::vector<KeySearchTarget>::const_iterator i = targets.begin(); i != targets.end(); ++i) {
            hash160 h(i->value);
            _targetList.push_back(h);
        }

        setTargetsInternal();
    } catch(cl::CLException ex) {
        throw KeySearchException("OpenCL target upload failed: " + ex.msg);
    }
}

size_t CLKeySearchDevice::getResults(std::vector<KeySearchResult> &results)
{
    size_t count = _results.size();
    for(size_t i = 0; i < count; i++) {
        results.push_back(_results[i]);
    }
    _results.clear();

    return count;
}

uint64_t CLKeySearchDevice::keysPerStep()
{
    return (uint64_t)_points;
}

std::string CLKeySearchDevice::getDeviceName()
{
    return _deviceName;
}

void CLKeySearchDevice::getMemoryInfo(uint64_t &freeMem, uint64_t &totalMem)
{
    freeMem = _globalMemSize - _targetMemSize - _pointsMemSize;
    totalMem = _globalMemSize;
}

uint64_t CLKeySearchDevice::getFalsePositiveCount()
{
    return _falsePositiveCount;
}

void CLKeySearchDevice::splatBigInt(unsigned int *ptr, int idx, secp256k1::uint256 &k)
{
    unsigned int buf[8];

    k.exportWords(buf, 8, secp256k1::uint256::BigEndian);

    memcpy(ptr + idx * 8, buf, sizeof(unsigned int) * 8);

}

bool CLKeySearchDevice::isTargetInList(const unsigned int hash[5])
{
    size_t count = _targetList.size();

    while(count) {
        if(memcmp(hash, _targetList[count - 1].h, 20) == 0) {
            return true;
        }
        count--;
    }

    return false;
}

void CLKeySearchDevice::removeTargetFromList(const unsigned int hash[5])
{
    size_t count = _targetList.size();

    while(count) {
        if(memcmp(hash, _targetList[count - 1].h, 20) == 0) {
            _targetList.erase(_targetList.begin() + count - 1);
            return;
        }
        count--;
    }
}


void CLKeySearchDevice::getResultsInternal(bool force)
{
    unsigned int numResults = 0;

    _clContext->copyDeviceToHost(_deviceResultsCount, &numResults, sizeof(unsigned int));

    if(numResults == 0) {
        return;
    }

    if(!force && numResults < _resultDrainThreshold) {
        return;
    }

    if(numResults > 0) {
        unsigned int resultsToRead = numResults > _resultQueueCapacity ? _resultQueueCapacity : numResults;
        CLDeviceResult *ptr = new CLDeviceResult[resultsToRead];
        unsigned int *rngPrivateKeys = NULL;

        _clContext->copyDeviceToHost(_deviceResults, ptr, sizeof(CLDeviceResult) * resultsToRead);

        if(_rngMode) {
            rngPrivateKeys = new unsigned int[(size_t)_points * 8];
            _clContext->copyDeviceToHost(_privateKeys, rngPrivateKeys, (size_t)_points * 8 * sizeof(unsigned int));
        }

        unsigned int actualCount = 0;

        for(unsigned int i = 0; i < resultsToRead; i++) {

            // might be false-positive
            if(!isTargetInList(ptr[i].digest)) {
                _falsePositiveCount++;
                continue;
            }
            actualCount++;

            KeySearchResult minerResult;

            secp256k1::uint256 privateKey;
            uint64_t keyOffset = ((uint64_t)ptr[i].keyOffsetHi << 32) | (uint64_t)ptr[i].keyOffsetLo;

            if(_rngMode) {
                privateKey = secp256k1::addModN(readBigInt(rngPrivateKeys, ptr[i].idx), secp256k1::uint256(keyOffset));
            } else {
                // Calculate the private key based on the number of iterations and the current thread
                secp256k1::uint256 offset = secp256k1::uint256((uint64_t)_points * keyOffset) + secp256k1::uint256(ptr[i].idx) * _stride;
                privateKey = secp256k1::addModN(_start, offset);
            }

            minerResult.privateKey = privateKey;
            minerResult.compressed = ptr[i].compressed;

            memcpy(minerResult.hash, ptr[i].digest, 20);

            minerResult.publicKey = secp256k1::ecpoint(secp256k1::uint256(ptr[i].x, secp256k1::uint256::BigEndian), secp256k1::uint256(ptr[i].y, secp256k1::uint256::BigEndian));

            removeTargetFromList(ptr[i].digest);

            _results.push_back(minerResult);
        }

        // Reset device counter
        numResults = 0;
        _clContext->copyHostToDevice(&numResults, _deviceResultsCount, sizeof(unsigned int));

        delete[] rngPrivateKeys;
        delete[] ptr;
    }
}

void CLKeySearchDevice::selfTest()
{
    uint64_t numPoints = (uint64_t)_points;
    std::vector<secp256k1::uint256> privateKeys;

    // Generate key pairs for k, k+1, k+2 ... k + <total points in parallel - 1>
    secp256k1::uint256 privKey = _start;

    privateKeys.push_back(_start);

    for(uint64_t i = 1; i < numPoints; i++) {
        privKey = privKey.add(_stride);
        privateKeys.push_back(privKey);
    }

    unsigned int *xBuf = new unsigned int[numPoints * 8];
    unsigned int *yBuf = new unsigned int[numPoints * 8];

    _clContext->copyDeviceToHost(_x, xBuf, sizeof(unsigned int) * 8 * numPoints);
    _clContext->copyDeviceToHost(_y, yBuf, sizeof(unsigned int) * 8 * numPoints);

    for(int index = 0; index < _points; index++) {
        secp256k1::uint256 privateKey = privateKeys[index];

        secp256k1::uint256 x = readBigInt(xBuf, index);
        secp256k1::uint256 y = readBigInt(yBuf, index);

        secp256k1::ecpoint p1(x, y);
        secp256k1::ecpoint p2 = secp256k1::multiplyPoint(privateKey, secp256k1::G());

        if(!secp256k1::pointExists(p1)) {
            throw std::string("Validation failed: invalid point");
        }

        if(!secp256k1::pointExists(p2)) {
            throw std::string("Validation failed: invalid point");
        }

        if(!(p1 == p2)) {
            throw std::string("Validation failed: points do not match");
        }
    }
}



secp256k1::uint256 CLKeySearchDevice::readBigInt(unsigned int *src, int idx)
{
    unsigned int value[8] = {0};

    for(int k = 0; k < 8; k++) {
        value[k] = src[idx * 8 + k];
    }

    secp256k1::uint256 v(value, secp256k1::uint256::BigEndian);

    return v;
}

void CLKeySearchDevice::initializeBasePoints()
{
    // generate a table of points G, 2G, 4G, 8G...(2^255)G
    std::vector<secp256k1::ecpoint> table;

    table.push_back(secp256k1::G());
    for(uint64_t i = 1; i < 256; i++) {

        secp256k1::ecpoint p = doublePoint(table[i - 1]);
        if(!pointExists(p)) {
            throw std::string("Point does not exist!");
        }
        table.push_back(p);
    }

    size_t count = 256;

    unsigned int *tmpX = new unsigned int[count * 8];
    unsigned int *tmpY = new unsigned int[count * 8];

    for(int i = 0; i < 256; i++) {
        unsigned int bufX[8];
        unsigned int bufY[8];
        table[i].x.exportWords(bufX, 8, secp256k1::uint256::BigEndian);
        table[i].y.exportWords(bufY, 8, secp256k1::uint256::BigEndian);

        for(int j = 0; j < 8; j++) {
            tmpX[i * 8 + j] = bufX[j];
            tmpY[i * 8 + j] = bufY[j];
        }
    }

    _clContext->copyHostToDevice(tmpX, _xTable, count * 8 * sizeof(unsigned int));

    _clContext->copyHostToDevice(tmpY, _yTable, count * 8 * sizeof(unsigned int));
}



void CLKeySearchDevice::generateStartingPoints()
{
    uint64_t totalPoints = (uint64_t)_points;
    uint64_t totalMemory = totalPoints * 40;

    std::vector<secp256k1::uint256> exponents;

    initializeBasePoints();

    _pointsMemSize = totalPoints * sizeof(unsigned int) * 16 + _points * sizeof(unsigned int) * 8;

    Logger::log(LogLevel::Info, "Generating " + util::formatThousands(totalPoints) + " starting points (" + util::format("%.1f", (double)totalMemory / (double)(1024 * 1024)) + "MB)");

    // Generate key pairs for k, k+1, k+2 ... k + <total points in parallel - 1>
    secp256k1::uint256 privKey = _start;

    exponents.push_back(privKey);

    for(uint64_t i = 1; i < totalPoints; i++) {
        privKey = privKey.add(_stride);
        exponents.push_back(privKey);
    }

    unsigned int *privateKeys = new unsigned int[8 * totalPoints];

    for(int index = 0; index < _points; index++) {
        splatBigInt(privateKeys, index, exponents[index]);
    }

    // Copy to device
    _clContext->copyHostToDevice(privateKeys, _privateKeys, totalPoints * 8 * sizeof(unsigned int));

    delete[] privateKeys;

    // Show progress in 10% increments
    double pct = 10.0;
    for(int i = 0; i < 256; i++) {
        _initKeysKernel->set_args(_points, i, _privateKeys, _chain, _xTable, _yTable, _x, _y);
        _initKeysKernel->call(_blocks, _threads);

        if(((double)(i+1) / 256.0) * 100.0 >= pct) {
            Logger::log(LogLevel::Info, util::format("%.1f%%", pct));
            pct += 10.0;
        }
    }

    Logger::log(LogLevel::Info, "Done");
}

void CLKeySearchDevice::generateRandomStartingPoints()
{
    _rngKernel->set_args(
        _points,
        (cl_ulong)_iterations,
        _rngOddBit,
        _rngEvenBit,
        _rngSeedMem,
        _privateKeys,
        _x,
        _y);
    _rngKernel->call(_blocks, _threads);

    if(_selfTest) {
        _clContext->copyHostToDevice(_selfTestKey, _privateKeys, (size_t)_selfTestIndex * 8 * sizeof(unsigned int), 8 * sizeof(unsigned int));
    }

    for(int i = 0; i < 256; i++) {
        _initKeysKernel->set_args(_points, i, _privateKeys, _chain, _xTable, _yTable, _x, _y);
        _initKeysKernel->call(_blocks, _threads);
    }
}


secp256k1::uint256 CLKeySearchDevice::getNextKey()
{
    if(_rngMode) {
        return _start;
    }

    uint64_t totalPoints = (uint64_t)_points * _threads * _blocks;

    return _start + secp256k1::uint256(totalPoints) * _iterations * _stride;
}
