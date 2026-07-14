/*
 * Nearcade Backend API - Device-specific implementations
 * 
 * Each device backend implements these functions.
 * The core SDK calls these through function pointers.
 */

#ifndef NEARCADE_BACKENDS_H
#define NEARCADE_BACKENDS_H

#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

// Video frame structure
typedef struct {
    uint8_t* data;
    int width;
    int height;
    int stride;
    int format;  // V4L2_PIX_FMT_*
    uint64_t timestamp;
    int64_t pts;
    int flags;
    void* private;  // backend-specific
} nearcade_frame_t;

// Video decode backend
typedef struct nearcade_decode_backend {
    const char* name;
    int (*init)(void** ctx, int width, int height, const char* codec);
    int (*decode)(void* ctx, const uint8_t* data, size_t size, int64_t pts, int flags);
    int (*flush)(void* ctx);
    int (*get_frame)(void* ctx, nearcade_frame_t* frame);
    void (*destroy)(void* ctx);
} nearcade_decode_backend_t;

// Video capture backend
typedef struct nearcade_capture_backend {
    const char* name;
    int (*init)(void** ctx, int width, int height, int fps);
    int (*start)(void* ctx);
    int (*stop)(void* ctx);
    int (*get_frame)(void* ctx, nearcade_frame_t* frame);
    void (*destroy)(void* ctx);
} nearcade_capture_backend_t;

// Input injection backend
typedef struct nearcade_input_backend {
    const char* name;
    int (*init)(void** ctx);
    int (*send_gamepad)(void* ctx, int pad_idx, const uint16_t buttons, 
                        const int16_t axes[4], const uint8_t triggers[2]);
    int (*send_keyboard)(void* ctx, int key, int pressed);
    int (*send_mouse)(void* ctx, int dx, int dy, uint32_t buttons);
    void (*destroy)(void* ctx);
} nearcade_input_backend_t;

// Audio backend
typedef struct nearcade_audio_backend {
    const char* name;
    int (*init)(void** ctx, int sample_rate, int channels);
    int (*capture_start)(void* ctx);
    int (*capture_read)(void* ctx, void* buffer, size_t frames);
    int (*playback_write)(void* ctx, const void* buffer, size_t frames);
    void (*destroy)(void* ctx);
} nearcade_audio_backend_t;

// Window/overlay backend
typedef struct nearcade_window_backend {
    const char* name;
    int (*init)(void** ctx, int width, int height, int fullscreen);
    int (*present)(void* ctx, const nearcade_frame_t* frame);
    int (*set_fullscreen)(void* ctx, int fullscreen);
    void (*destroy)(void* ctx);
} nearcade_window_backend_t;

// Network transport backend
typedef struct nearcade_transport_backend {
    const char* name;
    int (*init)(void** ctx, const char* host, int port);
    int (*connect)(void* ctx, const char* host, int port);
    int (*send)(void* ctx, const void* data, size_t len);
    int (*recv)(void* ctx, void* buffer, size_t max_len, int timeout_ms);
    void (*destroy)(void* ctx);
} nearcade_transport_backend_t;

// Full backend set for a device
typedef struct {
    const char* device_name;
    nearcade_decode_backend_t decode;
    nearcade_capture_backend_t capture;
    nearcade_input_backend_t input;
    nearcade_audio_backend_t audio;
    nearcade_window_backend_t window;
    nearcade_transport_backend_t transport;
} nearcade_device_backends_t;

// Get backends for a device (looks up by device profile)
const nearcade_device_backends_t* nearcade_get_backends(const char* device_name);

#ifdef __cplusplus
}
#endif

#endif // NEARCADE_BACKENDS_H