#include <fstream>
#include <algorithm>
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

static std::vector<KeySearchTarget> parseTargetBatch(std::vector<std::string> lines, uint64_t firstLine)
{
	std::vector<KeySearchTarget> targets;
	targets.reserve(lines.size());

	for(size_t i = 0; i < lines.size(); i++) {
		std::string line = util::trim(lines[i]);

		if(line.length() == 0) {
			continue;
		}

		if(!Address::verifyAddress(line)) {
			if(firstLine > 0) {
				throw KeySearchException("Invalid address '" + line + "' on line " + util::format((uint64_t)(firstLine + i)));
			}
			throw KeySearchException("Invalid address '" + line + "'");
		}

		KeySearchTarget t;
		Address::toHash160(line, t.value);
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

	_targets = parseTargetBatch(targets, 0);

    _device->setTargets(_targets);
}

void KeyFinder::setTargets(std::string targetsFile)
{
	std::ifstream inFile(targetsFile.c_str());

	if(!inFile.is_open()) {
		Logger::log(LogLevel::Error, "Unable to open '" + targetsFile + "'");
		throw KeySearchException();
	}

	_targets.clear();

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

	Logger::log(LogLevel::Info, "Loading addresses from '" + targetsFile + "'");
	Logger::log(LogLevel::Info, "Parsing targets with " + util::format((uint32_t)workers) + " CPU threads");
	Logger::log(LogLevel::Info, "Using RAM-first target loading");

	batch.reserve(batchSize);
	while(std::getline(inFile, line)) {
		util::removeNewline(line);
		lineNumber++;
		batch.push_back(line);

		if(batch.size() >= batchSize) {
			uint64_t firstLine = lineNumber - batch.size() + 1;
			pending.push_back(std::async(std::launch::async, parseTargetBatch, std::move(batch), firstLine));
			batch.clear();
			batch.reserve(batchSize);

			while(pending.size() >= maxPending) {
				std::vector<KeySearchTarget> parsed = pending.front().get();
				pending.pop_front();
				appendTargets(_targets, parsed);
			}
		}
	}

	if(batch.size() > 0) {
		uint64_t firstLine = lineNumber - batch.size() + 1;
		pending.push_back(std::async(std::launch::async, parseTargetBatch, std::move(batch), firstLine));
	}

	while(!pending.empty()) {
		std::vector<KeySearchTarget> parsed = pending.front().get();
		pending.pop_front();
		appendTargets(_targets, parsed);
	}

	sortUniqueTargets(_targets);

	Logger::log(LogLevel::Info, util::formatThousands(_targets.size()) + " addresses loaded ("
		+ util::format("%.1f", (double)(sizeof(KeySearchTarget) * _targets.size()) / (double)(1024 * 1024)) + "MB)");

    _device->setTargets(_targets);
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
            info.nextKey = getNextKey();

			_statusCallback(info);

			timer.start();
			prevIterCount = _iterCount;
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
