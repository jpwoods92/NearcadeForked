/*
 * Nearcade Backend API - Compatibility Layer
 * 
 * Device-specific backends register themselves via this API.
 * The core SDK uses these function pointers to talk to platform-specific code.
 */

#ifndef NEARCADE_BACKENDS_H
#define NEARCADE_BACKENDS_H

#include <stdint.h>
#include <stddef.h>

// Opaque decoder handle
typedef void* NearcadeDecoder;

// Decoder creation parameters
typedef struct {
    int width;
    int height;
    const char* codec;     // "h264", "h265", "vp8", "vp9"
    int bitrate_kbps;
    int fps;
} NearcadeDecoderConfig;

// Backend function signatures
typedef int (*decode_init_fn)(NearcadeDecoder** out_decoder, const char* codec, int width, int height);
typedef int (*decode_decode_fn)(NearcadeDecoder* decoder, const uint8_t* data, size_t size,
                                int64_t timestamp, int flags, uint8_t** out_frame, size_t* out_size);
typedef void (*decode_destroy_fn)(NearcadeDecoder* decoder);

typedef struct {
    const char* name;
    int version;  // 1
    int (*init)(NearcadeDecoder** out, int width, int height, const char* codec);
    int (*decode)(void* decoder, const uint8_t* data, size_t size,
                  int64_t timestamp, int flags, uint8_t** out_frame, size_t* out_size);
    void (*destroy)(void* decoder);
    // Optional capabilities
    int (*get_capabilities)(void);  // bitmask
} nearcade_decode_backend_t;

// Input backends
typedef struct {
    const char* name;
    int (*init)(void);
    void (*poll)(void);  // called periodically
    void (*destroy)(void);
} nearcade_input_backend_t;

// Capture backends
typedef struct {
    const char* name;
    int (*init)(int width, int height, int fps);
    void* (*get_frame)(void);  // returns frame buffer or NULL
    void (*release_frame)(void* frame);
    void (*destroy)(void);
} nearcade_capture_backend_t;

// Audio backends
typedef struct {
    const char* name;
    int (*init)(int sample_rate, int channels);
    int (*capture)(void* buffer, size_t frames);
    int (*playback)(const void* buffer, size_t frames);
    void (*destroy)(void);
} nearcade_audio_backend_t;

// Window/overlay backends
typedef struct {
    const char* name;
    int (*init)(int width, int height, int fullscreen);
    void (*present)(const void* frame, int width, int height, int format);
    void (*destroy)(void);
} nearcade_window_backend_t;

// Transport backends
typedef struct {
    const char* name;
    int (*connect)(const char* host, int port);
    int (*send)(const void* data, size_t size);
    int (*recv)(void* buffer, size_t max_size, int timeout_ms);
    void (*disconnect)(void);
    void (*destroy)(void);
} nearcade_transport_backend_t;

// Global registry - backends register themselves at load time
typedef struct {
    const nearcade_decode_backend_t* decode;
    const nearcade_input_backend_t* input;
    const nearcade_capture_backend_t* capture;
    const nearcade_audio_backend_t* audio;
    const nearcade_window_backend_t* window;
    const nearcade_transport_backend_t* transport;
} nearcade_backends_t;

// Called by each backend's constructor (via __attribute__((constructor)))
void nearcade_register_backend(const nearcade_backends_t* backends);

// Query available backends
const nearcade_backends_t* nearcade_get_backends(void);

// Select backend by name (or auto-detect if NULL)
int nearcade_select_backend(const char* name);

#endif