/*
 * Nearcade Backend Registry
 * 
 * Auto-loads device-specific backends based on platform detection
 */

#include <nearcade_backends.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const nearcade_backends_t* g_selected = NULL;

// Forward declarations of built-in backends
extern const nearcade_decode_backend_t nearcade_cedrus_decode_backend;
extern const nearcade_input_backend_t nearcade_evdev_input_backend;
extern const nearcade_capture_backend_t nearcade_drm_capture_backend;
extern const nearcade_audio_backend_t nearcade_alsa_audio_backend;
extern const nearcade_window_backend_t nearcade_drm_window_backend;
extern const nearcade_transport_backend_t nearcade_libdatachannel_transport_backend;

// Platform-specific backend sets
static const nearcade_backends_t nearcade_backends_h700 = {
    .decode    = NULL,  // &nearcade_cedrus_decode_backend (in decode.c)
    .input     = NULL,  // &nearcade_evdev_input_backend
    .capture   = NULL,  // &nearcade_drm_capture_backend
    .audio     = NULL,  // &nearcade_alsa_audio_backend
    .window    = NULL,  // &nearcade_drm_window_backend
    .transport = NULL,  // &nearcade_libdatachannel_transport_backend
};

static const nearcade_backends_t nearcade_backends_rk3566 = {
    .decode    = NULL,  // rkmp_px decode
    .input     = NULL,
    .capture   = NULL,
    .audio     = NULL,
    .window    = NULL,
    .transport = NULL,
};

static const nearcade_backends_t nearcade_backends_linux_x86 = {
    .decode    = NULL,  // vaapi decode
    .input     = NULL,
    .capture   = NULL,
    .audio     = NULL,
    .window    = NULL,
    .transport = NULL,
};

static const struct {
    const char* name;
    const nearcade_backends_t* backends;
} g_known_backends[] = {
    { "h700", &nearcade_backends_h700 },
    { "rk3566", &nearcade_backends_rk3566 },
    { "linux-x86_64", &nearcade_backends_linux_x86 },
    { "auto", NULL },
};

void nearcade_register_backend(const nearcade_backends_t* backends) {
    // In a real implementation, this would be called by each backend's constructor
    // For now, we just use the static table
    (void)backends;
}

const nearcade_backends_t* nearcade_get_backends(void) {
    if (g_selected) return g_selected;
    
    // Try to detect platform
    FILE* f = fopen("/sys/firmware/devicetree/base/model", "r");
    if (f) {
        char model[256] = {0};
        fread(model, 1, sizeof(model)-1, f);
        fclose(f);
        
        if (strstr(model, "H700") || strstr(model, "RG35XX") || strstr(model, "TrimUI")) {
            printf("[backends] Detected H700 platform\n");
            g_selected = &nearcade_backends_h700;
            return g_selected;
        }
        if (strstr(model, "RK3566") || strstr(model, "RG556") || strstr(model, "RG Cube")) {
            printf("[backends] Detected RK3566 platform\n");
            g_selected = &nearcade_backends_rk3566;
            return g_selected;
        }
    }
    
    // Default to generic
    printf("[backends] Using generic Linux x86_64 backends\n");
    g_selected = &nearcade_backends_linux_x86;
    return g_selected;
}

int nearcade_select_backend(const char* name) {
    if (!name || strcmp(name, "auto") == 0) {
        g_selected = NULL;
        return nearcade_get_backends() ? 0 : -1;
    }
    
    for (size_t i = 0; i < sizeof(g_known_backends)/sizeof(g_known_backends[0]); i++) {
        if (strcmp(g_known_backends[i].name, name) == 0) {
            g_selected = g_known_backends[i].backends;
            return g_selected ? 0 : -1;
        }
    }
    return -1;
}