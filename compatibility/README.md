# Nearcade Compatibility Layer

This directory contains toolchains, device profiles, and backend stubs for building Nearcade clients on diverse hardware.

## Structure

```
compatibility/
├── toolchains/          # Dockerfiles and CMake toolchain files
├── devices/             # Per-device profiles (flags, kernel config, deps)
├── backends/            # Platform-specific backend stubs
└── scripts/             # Build and deploy helpers
```

## Quick Start

```bash
# Build for RK3566 (RG556, RG Cube, etc.)
./compatibility/scripts/build.sh --device rk3566

# Build for H700 (RG35XX, RG35XX Plus)
./compatibility/scripts/build.sh --device h700

# Build for Allwinner H700 (Mali-G31)
./compatibility/scripts/build.sh --device h700-mali

# Build for x86_64 Linux (standard desktop)
./compatibility/scripts/build.sh --device linux-x86_64
```

## Supported Device Profiles

| Device | SoC | GPU | Decode | Status |
|---|---|---|---|---|
| Anbernic RG35XX / Plus | Allwinner H700 | Mali-G31 | Cedrus VPU | WIP |
| Anbernic RG556 / RG Cube | Rockchip RK3566 | Mali-G52 | RKMPP/MPP | WIP |
| Retroid Pocket 4/5 | Unisoc T820 | Mali-G57 | Custom | Planned |
| AYN Odin 2 | Snapdragon 8 Gen 2 | Adreno 740 | Qualcomm | Planned |
| Steam Deck | AMD Van Gogh | RDNA2 | VAAPI | Planned |
| Generic ARM64 Linux | Any | Any | V4L2 | Template |

## Adding a New Device

1. Create `compatibility/devices/<device-name>.json`
2. Add toolchain file: `compatibility/toolchains/<arch>.cmake`
3. Add backend stubs in `compatibility/backends/<device>/`
4. Test with `./scripts/build.sh --device <device-name>`

## Backend Stubs Required per Device

| Backend | File | Purpose |
|---|---|---|
| Video Decode | `backends/<device>/decode.c` | V4L2/Cedrus/RKMPP hardware decode |
| Video Capture | `backends/<device>/capture.c` | DRM/KMS/DMA-BUF screen capture |
| Input | `backends/<device>/input.c` | evdev/uinput injection |
| Audio | `backends/<device>/audio.c` | ALSA/PipeWire capture & playback |
| Window/Overlay | `backends/<device>/window.c` | DRM/KMS/SDL2 frame display |
| Network | `backends/<device>/net.c` | WebRTC/libdatachannel transport |

Each backend implements the same C API declared in `include/nearcade_backends.h`.