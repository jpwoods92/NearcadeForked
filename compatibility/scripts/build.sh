#!/usr/bin/env bash
# compatibility/scripts/build.sh
# Cross-compile Nearcade client for target device

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPAT_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_ROOT="$(dirname "$COMPAT_DIR")"

DEVICE=""
BUILD_TYPE="Release"
CLEAN=false
DEPLOY=false
TARGET_DIR=""

usage() {
    cat <<EOF
Usage: $0 --device <name> [options]

Options:
  --device <name>     Device profile (required)
  --type <type>       Build type: Release, Debug, RelWithDebInfo (default: Release)
  --clean             Clean build directory before building
  --deploy            Deploy to device after build (requires SSH config)
  --target-dir <path> Custom build output directory
  --list-devices      List available device profiles
  -h, --help          Show this help

Available devices:
EOF
    for f in "$COMPAT_DIR"/devices/*.json; do
        name=$(basename "$f" .json)
        desc=$(jq -r '.name' "$f" 2>/dev/null || echo "$name")
        echo "  $name - $desc"
    done
}

# Parse args
while [[ $# -gt 0 ]]; do
    case $1 in
        --device) DEVICE="$2"; shift 2 ;;
        --type) BUILD_TYPE="$2"; shift 2 ;;
        --clean) CLEAN=true; shift ;;
        --deploy) DEPLOY=true; shift ;;
        --target-dir) TARGET_DIR="$2"; shift 2 ;;
        --list-devices) usage; exit 0 ;;
        -h|--help) usage; exit 0 ;;
        *) echo "Unknown option: $1"; usage; exit 1 ;;
    esac
done

if [[ -z "$DEVICE" ]]; then
    echo "Error: --device required"
    usage
    exit 1
fi

DEVICE_FILE="$COMPAT_DIR/devices/$DEVICE.json"
if [[ ! -f "$DEVICE_FILE" ]]; then
    echo "Error: Device profile not found: $DEVICE_FILE"
    exit 1
fi

# Load device config
ARCH=$(jq -r '.arch' "$DEVICE_FILE")
TOOLCHAIN=$(jq -r '.toolchain' "$DEVICE_FILE")
CFLAGS=$(jq -r '.cflags' "$DEVICE_FILE")
LDFLAGS=$(jq -r '.ldflags' "$DEVICE_FILE")
CMAKE_FLAGS=$(jq -r '.cmake_flags' "$DEVICE_FILE")
SYSROOT=$(jq -r '.sysroot' "$DEVICE_FILE")
PKG_CONFIG_PATH=$(jq -r '.pkg_config_path' "$DEVICE_FILE")
DEPS=$(jq -r '.dependencies[]' "$DEVICE_FILE" 2>/dev/null | tr '\n' ' ')

BUILD_DIR="${TARGET_DIR:-$PROJECT_ROOT/build/$DEVICE}"

echo "Building for $DEVICE ($ARCH)..."
echo "Build dir: $BUILD_DIR"
echo "CFLAGS: $CFLAGS"
echo "LDFLAGS: $LDFLAGS"

# Check dependencies
if [[ "$TOOLCHAIN" != "native" ]]; then
    echo "Checking cross-compile toolchain..."
    if ! command -v "${TOOLCHAIN}-gcc" >/dev/null 2>&1; then
        echo "Warning: ${TOOLCHAIN}-gcc not found. Install with:"
        echo "  sudo apt install gcc-${TOOLCHAIN} g++-${TOOLCHAIN}"
    fi
fi

# Clean
if [[ "$CLEAN" == true ]]; then
    echo "Cleaning $BUILD_DIR..."
    rm -rf "$BUILD_DIR"
fi

mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"

# Generate toolchain file
TOOLCHAIN_FILE="$BUILD_DIR/toolchain.cmake"
cat > "$TOOLCHAIN_FILE" <<EOF
set(CMAKE_SYSTEM_NAME Linux)
set(CMAKE_SYSTEM_PROCESSOR $ARCH)

set(CMAKE_C_COMPILER ${TOOLCHAIN}-gcc)
set(CMAKE_CXX_COMPILER ${TOOLCHAIN}-g++)
set(CMAKE_C_FLAGS "${CFLAGS}")
set(CMAKE_CXX_FLAGS "${CFLAGS}")
set(CMAKE_EXE_LINKER_FLAGS "${LDFLAGS}")
set(CMAKE_SHARED_LINKER_FLAGS "${LDFLAGS}")

set(CMAKE_FIND_ROOT_PATH ${SYSROOT})
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)

set(PKG_CONFIG_EXECUTABLE ${TOOLCHAIN}-pkg-config)
set(ENV{PKG_CONFIG_PATH} ${PKG_CONFIG_PATH})
set(ENV{PKG_CONFIG_SYSROOT_DIR} ${SYSROOT})
EOF

# Configure
echo "Configuring with CMake..."
cmake "$PROJECT_ROOT" \
    -DCMAKE_BUILD_TYPE="$BUILD_TYPE" \
    -DCMAKE_TOOLCHAIN_FILE="$TOOLCHAIN_FILE" \
    $CMAKE_FLAGS \
    -DNEARCADE_DEVICE="$DEVICE" \
    -DCMAKE_INSTALL_PREFIX="$BUILD_DIR/install"

# Build
echo "Building..."
cmake --build . --config "$BUILD_TYPE" -- -j$(nproc)

# Install
echo "Installing to $BUILD_DIR/install..."
cmake --install . --config "$BUILD_TYPE"

# Deploy
if [[ "$DEPLOY" == true ]]; then
    echo "Deploying to device..."
    # Assumes SSH config in ~/.ssh/config with host alias matching device name
    scp -r "$BUILD_DIR/install/"* "$DEVICE:~/nearcade/"
fi

echo "Done! Binary at: $BUILD_DIR/install/bin/nearcade-client"