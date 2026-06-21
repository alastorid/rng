#include "DeviceManager.h"
#include <sstream>

#ifdef BUILD_CUDA
#include "cudaUtil.h"
#endif

#ifdef BUILD_OPENCL
#include "clutil.h"
#endif

std::vector<DeviceManager::DeviceInfo> DeviceManager::getDevices()
{
    int deviceId = 0;

    std::vector<DeviceManager::DeviceInfo> devices;
    std::vector<std::string> warnings;

#ifdef BUILD_CUDA
    // Get CUDA devices
    try {
        std::vector<cuda::CudaDeviceInfo> cudaDevices = cuda::getDevices();

        for(int i = 0; i < cudaDevices.size(); i++) {
            DeviceManager::DeviceInfo device;
            device.name = cudaDevices[i].name;
            device.type = DeviceType::CUDA;
            device.id = deviceId;
            device.physicalId = cudaDevices[i].id;
            device.memory = cudaDevices[i].mem;
            device.computeUnits = cudaDevices[i].mpCount;
            devices.push_back(device);

            deviceId++;
        }
    } catch(cuda::CudaException ex) {
        warnings.push_back("CUDA: " + ex.msg);
    }
#endif

#ifdef BUILD_OPENCL
    // Get OpenCL devices
    try {
        std::vector<cl::CLDeviceInfo> clDevices = cl::getDevices();

        for(int i = 0; i < clDevices.size(); i++) {
            DeviceManager::DeviceInfo device;
            device.name = clDevices[i].name;
            device.type = DeviceType::OpenCL;
            device.id = deviceId;
            device.physicalId = (uint64_t)clDevices[i].id;
            device.memory = clDevices[i].mem;
            device.computeUnits = clDevices[i].cores;
            devices.push_back(device);
            deviceId++;
        }
    } catch(cl::CLException ex) {
        warnings.push_back("OpenCL: " + ex.msg);
    }
#endif

    if(devices.size() == 0 && warnings.size() > 0) {
        std::ostringstream msg;
        msg << "No usable compute devices found";

        for(size_t i = 0; i < warnings.size(); i++) {
            msg << (i == 0 ? " (" : "; ") << warnings[i];
        }

        msg << ")";
        throw DeviceManager::DeviceManagerException(msg.str());
    }

    return devices;
}
