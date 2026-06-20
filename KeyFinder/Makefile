CPPSRC:=$(wildcard *.cpp)

UNAME_S := $(shell uname -s)
ifeq ($(UNAME_S),Darwin)
	OPENCL_LDFLAGS=-framework OpenCL
else
	OPENCL_LDFLAGS=-L${OPENCL_LIB} -lOpenCL
endif

all:
ifeq ($(BUILD_CUDA), 1)
	${CXX} -DBUILD_CUDA -o cuKeyFinder.bin ${CPPSRC} ${INCLUDE} -I${CUDA_INCLUDE} ${CXXFLAGS} ${LIBS} -L${CUDA_LIB} -lkeyfinder -laddressutil -lsecp256k1 -lcryptoutil -lsecp256k1 -lcudautil -llogger -lutil -lCudaKeySearchDevice -lcudadevrt -lcudart -lcmdparse
	mkdir -p $(BINDIR)
	cp cuKeyFinder.bin $(BINDIR)/cuBitCrack
endif
ifeq ($(BUILD_OPENCL),1)
	${CXX} -DBUILD_OPENCL -o clKeyFinder.bin ${CPPSRC} ${INCLUDE} -I${OPENCL_INCLUDE} ${CXXFLAGS} ${LIBS} -lkeyfinder -laddressutil -lsecp256k1 -lcryptoutil -lsecp256k1 -lCLKeySearchDevice -lclutil ${OPENCL_LDFLAGS} -llogger -lutil -lcmdparse
	mkdir -p $(BINDIR)
	cp clKeyFinder.bin $(BINDIR)/clBitCrack
endif

clean:
	rm -rf cuKeyFinder.bin
	rm -rf clKeyFinder.bin
