#include "clutil.h"


void cl::clCall(cl_int err)
{
    if(err != CL_SUCCESS) {
        throw cl::CLException(err);
    }
}


std::vector<cl::CLDeviceInfo> cl::getDevices()
{
    std::vector<cl::CLDeviceInfo> gpuDevices;
    std::vector<cl::CLDeviceInfo> cpuDevices;

    cl_uint platformCount = 0;

    cl_int err = clGetPlatformIDs(0, NULL, &platformCount);
    if(err != CL_SUCCESS || platformCount == 0) {
        return gpuDevices;
    }

    std::vector<cl_platform_id> platforms(platformCount);
    err = clGetPlatformIDs(platformCount, &platforms[0], NULL);
    if(err != CL_SUCCESS) {
        return gpuDevices;
    }

    for(cl_uint i = 0; i < platformCount; i++) {
        cl_uint deviceCount = 0;
        err = clGetDeviceIDs(platforms[i], CL_DEVICE_TYPE_ALL, 0, NULL, &deviceCount);

        if(err != CL_SUCCESS || deviceCount == 0) {
            continue;
        }

        std::vector<cl_device_id> devices(deviceCount);
        err = clGetDeviceIDs(platforms[i], CL_DEVICE_TYPE_ALL, deviceCount, &devices[0], NULL);

        if(err != CL_SUCCESS) {
            continue;
        }

        for(cl_uint j = 0; j < deviceCount; j++) {
            char buf[256] = {0};

            cl::CLDeviceInfo info;
            size_t size;
            // Get device name
            err = clGetDeviceInfo(devices[j], CL_DEVICE_NAME, sizeof(buf), buf, &size);
            if(err != CL_SUCCESS) {
                continue;
            }

            info.name = std::string(buf, size);

            cl_device_type type = 0;
            err = clGetDeviceInfo(devices[j], CL_DEVICE_TYPE, sizeof(type), &type, NULL);
            if(err != CL_SUCCESS) {
                continue;
            }
            info.type = type;

            int cores = 0;
            err = clGetDeviceInfo(devices[j], CL_DEVICE_MAX_COMPUTE_UNITS, sizeof(cores), &cores, NULL);
            if(err != CL_SUCCESS) {
                continue;
            }

            info.cores = cores;

            cl_ulong mem;
            err = clGetDeviceInfo(devices[j], CL_DEVICE_GLOBAL_MEM_SIZE, sizeof(mem), &mem, NULL);
            if(err != CL_SUCCESS) {
                continue;
            }

            info.mem = (uint64_t)mem;
            info.id = devices[j];
            if((type & CL_DEVICE_TYPE_GPU) != 0) {
                gpuDevices.push_back(info);
            } else if((type & CL_DEVICE_TYPE_CPU) != 0) {
                cpuDevices.push_back(info);
            }
        }
    }

    if(gpuDevices.size() > 0) {
        return gpuDevices;
    }

    return cpuDevices;
}
