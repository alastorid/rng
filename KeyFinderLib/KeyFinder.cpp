#include <fstream>
#include <algorithm>
#include <cstdlib>
#include <deque>
#include <future>
#include <iostream>
#include <thread>

#include "KeyFinder.h"
#include "util.h"
#include "AddressUtil.h"

#include "Logger.h"

static void sortUniqueTargets(std::vector<KeySearchTarget> &targets)
{
	std::sort(targets.begin(), targets.end());
	targets.erase(std::unique(targets.begin(), targets.end()), targets.end());
}

struct TargetLoadOptions {
	uint64_t minBalanceSats = 0;
	size_t addressColumn = 0;
	size_t balanceColumn = 1;
};

static bool isSpecialSkippedAddress(const std::string &address)
{
	return address == "s-272edf45031dd498e7b3ae89e11ff21b"
		|| address == "d-9ede1dfcfc8b7e11de4e88bcab11b809";
}

static std::vector<std::string> splitTargetColumns(const std::string &line)
{
	std::vector<std::string> columns;
	size_t start = 0;

	for(size_t i = 0; i <= line.length(); i++) {
		if(i == line.length() || line[i] == '\t' || line[i] == ',') {
			columns.push_back(line.substr(start, i - start));
			start = i + 1;
		}
	}

	return columns;
}

static uint64_t getMinBalanceSats()
{
	const char *env = std::getenv("RNG_MIN_BALANCE_SATS");
	if(env == NULL || std::string(env).length() == 0) {
		return 0;
	}

	return util::parseUInt64(std::string(env));
}

static uint64_t parseBalanceSats(const std::vector<std::string> &columns, size_t balanceColumn)
{
	if(columns.size() <= balanceColumn) {
		return 0;
	}

	std::string balance = util::trim(columns[balanceColumn]);
	if(balance.length() == 0) {
		return 0;
	}

	try {
		return util::parseUInt64(balance);
	} catch(...) {
		return 0;
	}
}

static std::vector<KeySearchTarget> parseTargetBatch(std::vector<std::string> lines, uint64_t firstLine, TargetLoadOptions options)
{
	std::vector<KeySearchTarget> targets;
	targets.reserve(lines.size());

	for(size_t i = 0; i < lines.size(); i++) {
		std::string line = util::trim(lines[i]);

		if(line.length() == 0) {
			continue;
		}

		std::vector<std::string> columns = splitTargetColumns(line);
		if(columns.size() <= options.addressColumn) {
			continue;
		}

		if(options.minBalanceSats > 0 && columns.size() > options.balanceColumn) {
			uint64_t balance = parseBalanceSats(columns, options.balanceColumn);
			if(balance < options.minBalanceSats) {
				continue;
			}
		}

		std::string address = util::trim(columns[options.addressColumn]);
		if(isSpecialSkippedAddress(address)) {
			continue;
		}

		if(!Address::verifyAddress(address)) {
			std::string msg = "Invalid address '" + address + "'";
			if(firstLine > 0) {
				msg += " on line " + util::format((uint64_t)(firstLine + i));
			}
			msg += " using address column " + util::format((uint32_t)(options.addressColumn + 1));
			if(options.minBalanceSats > 0) {
				msg += ", balance column " + util::format((uint32_t)(options.balanceColumn + 1));
			}
			msg += ". Raw row: " + line;
			throw KeySearchException(msg);
		}

		KeySearchTarget t;
		Address::toHash160(address, t.value);
		targets.push_back(t);
	}

	sortUniqueTargets(targets);

	return targets;
}

static void appendTargets(std::vector<KeySearchTarget> &dest, std::vector<KeySearchTarget> &src)
{
	dest.insert(dest.end(), src.begin(), src.end());
}

void KeyFinder::defaultResultCallback(KeySearchResult result)
{
	// Do nothing
}

void KeyFinder::defaultStatusCallback(KeySearchStatus status)
{
	// Do nothing
}

KeyFinder::KeyFinder(const secp256k1::uint256 &startKey, const secp256k1::uint256 &endKey, int compression, KeySearchDevice* device, const secp256k1::uint256 &stride)
{
	_total = 0;
	_statusInterval = 1000;
	_device = device;

	_compression = compression;

    _startKey = startKey;

    _endKey = endKey;

	_statusCallback = NULL;

	_resultCallback = NULL;

    _iterCount = 0;

    _stride = stride;
}

KeyFinder::~KeyFinder()
{
}

void KeyFinder::setTargets(std::vector<std::string> &targets)
{
	if(targets.size() == 0) {
		throw KeySearchException("Requires at least 1 target");
	}

	_targets.clear();

	TargetLoadOptions options;
	_targets = parseTargetBatch(targets, 0, options);

    _device->setTargets(_targets);
}

void KeyFinder::setTargets(const std::vector<KeySearchTarget> &targets)
{
	if(targets.size() == 0) {
		throw KeySearchException("Requires at least 1 target");
	}

	_targets = targets;

    _device->setTargets(_targets);
}

std::vector<KeySearchTarget> KeyFinder::loadTargetsFromFile(std::string targetsFile)
{
	std::ifstream inFile(targetsFile.c_str());

	if(!inFile.is_open()) {
		Logger::log(LogLevel::Error, "Unable to open '" + targetsFile + "'");
		throw KeySearchException();
	}

	std::vector<KeySearchTarget> targets;

	std::string line;
	uint64_t lineNumber = 0;
	const size_t batchSize = 65536;
	unsigned int workers = std::thread::hardware_concurrency();
	if(workers == 0) {
		workers = 2;
	}
	size_t maxPending = (size_t)workers * 2;
	std::vector<std::string> batch;
	std::deque<std::future<std::vector<KeySearchTarget> > > pending;
	TargetLoadOptions options;
	options.minBalanceSats = getMinBalanceSats();

	Logger::log(LogLevel::Info, "Loading addresses from '" + targetsFile + "'");
	Logger::log(LogLevel::Info, "Parsing targets with " + util::format((uint32_t)workers) + " CPU threads");
	Logger::log(LogLevel::Info, "Using RAM-first target loading");
	if(options.minBalanceSats > 0) {
		Logger::log(LogLevel::Info, "Filtering target rows with balance >= " + util::formatThousands(options.minBalanceSats) + " sats during load");
	}

	batch.reserve(batchSize);
	while(std::getline(inFile, line)) {
		util::removeNewline(line);
		lineNumber++;

		if(lineNumber == 1) {
			std::vector<std::string> columns = splitTargetColumns(line);
			bool foundAddressHeader = false;
			for(size_t i = 0; i < columns.size(); i++) {
				std::string name = util::toLower(util::trim(columns[i]));
				if(name == "address") {
					options.addressColumn = i;
					foundAddressHeader = true;
				}
				if(name == "balance" || name == "balance_satoshi" || name == "balance_satoshis") {
					options.balanceColumn = i;
				}
			}
			if(foundAddressHeader) {
				Logger::log(LogLevel::Info, "Target columns: address=" + util::format((uint32_t)(options.addressColumn + 1))
					+ ", balance=" + util::format((uint32_t)(options.balanceColumn + 1)));
				continue;
			}

			if(columns.size() > 1) {
				for(size_t i = 0; i < columns.size(); i++) {
					if(Address::verifyAddress(util::trim(columns[i]))) {
						options.addressColumn = i;
						Logger::log(LogLevel::Info, "Target columns inferred: address=" + util::format((uint32_t)(options.addressColumn + 1))
							+ ", balance=" + util::format((uint32_t)(options.balanceColumn + 1)));
						break;
					}
				}
			}
		}

		batch.push_back(line);

		if(batch.size() >= batchSize) {
			uint64_t firstLine = lineNumber - batch.size() + 1;
			pending.push_back(std::async(std::launch::async, parseTargetBatch, std::move(batch), firstLine, options));
			batch.clear();
			batch.reserve(batchSize);

			while(pending.size() >= maxPending) {
				std::vector<KeySearchTarget> parsed = pending.front().get();
				pending.pop_front();
				appendTargets(targets, parsed);
			}
		}
	}

	if(batch.size() > 0) {
		uint64_t firstLine = lineNumber - batch.size() + 1;
		pending.push_back(std::async(std::launch::async, parseTargetBatch, std::move(batch), firstLine, options));
	}

	while(!pending.empty()) {
		std::vector<KeySearchTarget> parsed = pending.front().get();
		pending.pop_front();
		appendTargets(targets, parsed);
	}

	sortUniqueTargets(targets);

	Logger::log(LogLevel::Info, util::formatThousands(targets.size()) + " addresses loaded ("
		+ util::format("%.1f", (double)(sizeof(KeySearchTarget) * targets.size()) / (double)(1024 * 1024)) + "MB)");

	return targets;
}

void KeyFinder::setTargets(std::string targetsFile)
{
	std::vector<KeySearchTarget> targets = loadTargetsFromFile(targetsFile);
	setTargets(targets);
}


void KeyFinder::setResultCallback(void(*callback)(KeySearchResult))
{
	_resultCallback = callback;
}

void KeyFinder::setStatusCallback(void(*callback)(KeySearchStatus))
{
	_statusCallback = callback;
}

void KeyFinder::setStatusInterval(uint64_t interval)
{
	_statusInterval = interval;
}

void KeyFinder::setTargetsOnDevice()
{
	// Set the target in constant memory
	std::vector<struct hash160> targets;

	for(std::vector<KeySearchTarget>::iterator i = _targets.begin(); i != _targets.end(); ++i) {
		targets.push_back(hash160((*i).value));
	}

    _device->setTargets(_targets);
}

void KeyFinder::init()
{
	Logger::log(LogLevel::Info, "Initializing " + _device->getDeviceName());

    _device->init(_startKey, _compression, _stride);
}


void KeyFinder::stop()
{
	_running = false;
}

void KeyFinder::removeTargetFromList(const unsigned int hash[5])
{
	KeySearchTarget t(hash);
	std::vector<KeySearchTarget>::iterator i = std::lower_bound(_targets.begin(), _targets.end(), t);

	if(i != _targets.end() && *i == t) {
		_targets.erase(i);
	}
}

bool KeyFinder::isTargetInList(const unsigned int hash[5])
{
	KeySearchTarget t(hash);
	return std::binary_search(_targets.begin(), _targets.end(), t);
}


void KeyFinder::run()
{
    uint64_t pointsPerIteration = _device->keysPerStep();

	_running = true;

	util::Timer timer;

	timer.start();

	uint64_t prevIterCount = 0;
	uint64_t prevFalsePositiveCount = 0;

	_totalTime = 0;

	while(_running) {

        _device->doStep();
        _iterCount++;

		// Update status
		uint64_t t = timer.getTime();

		if(t >= _statusInterval) {

			KeySearchStatus info;

			uint64_t count = (_iterCount - prevIterCount) * pointsPerIteration;

			_total += count;

			double seconds = (double)t / 1000.0;

			info.speed = (double)((double)count / seconds) / 1000000.0;

			info.total = _total;

			info.totalTime = _totalTime;

			uint64_t freeMem = 0;

			uint64_t totalMem = 0;

			_device->getMemoryInfo(freeMem, totalMem);

			info.freeMemory = freeMem;
			info.deviceMemory = totalMem;
			info.deviceName = _device->getDeviceName();
			info.targets = _targets.size();
			info.falsePositives = _device->getFalsePositiveCount();
			info.falsePositiveRate = (double)(info.falsePositives - prevFalsePositiveCount) / seconds;
            info.nextKey = getNextKey();

			_statusCallback(info);

			timer.start();
			prevIterCount = _iterCount;
			prevFalsePositiveCount = info.falsePositives;
			_totalTime += t;
		}

        std::vector<KeySearchResult> results;

        if(_device->getResults(results) > 0) {

			for(unsigned int i = 0; i < results.size(); i++) {

				KeySearchResult info;
                info.privateKey = results[i].privateKey;
                info.publicKey = results[i].publicKey;
				info.compressed = results[i].compressed;
				info.address = Address::fromPublicKey(results[i].publicKey, results[i].compressed);

				_resultCallback(info);
			}

			// Remove the hashes that were found
			for(unsigned int i = 0; i < results.size(); i++) {
				removeTargetFromList(results[i].hash);
			}
		}

        // Stop if there are no keys left
        if(_targets.size() == 0) {
            Logger::log(LogLevel::Info, "No targets remaining");
            _running = false;
        }

		// Stop if we searched the entire range
        if(_device->getNextKey().cmp(_endKey) >= 0 || _device->getNextKey().cmp(_startKey) < 0) {
            Logger::log(LogLevel::Info, "Reached end of keyspace");
            _running = false;
        }
	}
}

secp256k1::uint256 KeyFinder::getNextKey()
{
    return _device->getNextKey();
}
