NAME=CLUnitTests
CPPSRC:=$(filter-out cltest.cpp,$(wildcard *.cpp))

UNAME_S := $(shell uname -s)
ifeq ($(UNAME_S),Darwin)
	OPENCL_LDFLAGS=-framework OpenCL
else
	OPENCL_LDFLAGS=-L${OPENCL_LIB} -lOpenCL
endif

all:
	cat ../clMath/secp256k1.cl secp256k1test.cl > cltest.cl
	${BINDIR}/embedcl cltest.cl cltest.cpp _secp256k1_test_cl

	${CXX} -o clunittest.bin ${CPPSRC} cltest.cpp ${INCLUDE} -I${OPENCL_INCLUDE} ${CXXFLAGS} ${LIBS} -lclutil -lutil ${OPENCL_LDFLAGS}
	mkdir -p $(BINDIR)

	cp clunittest.bin $(BINDIR)/clunittest



clean:
	rm -rf *.a *.o clunittest.bin cltest.cl cltest.cpp
