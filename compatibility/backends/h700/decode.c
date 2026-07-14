/*
 * Cedrus V4L2 Decode Backend for Allwinner H700 (RG35XX, RG35XX Plus)
 * 
 * Uses V4L2 Request API (Cedrus driver: drivers/media/platform/sunxi/sunxi-cedrus.c)
 * Requires kernel 5.10+ with CONFIG_VIDEO_SUNXI_CEDRUS=y
 * 
 * WARNING: UNTESTED ON HARDWARE. The author has never run this on RG35XX/H700.
 * This is a scaffold based on Cedrus driver UAPI and similar V4L2 decode implementations.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <poll.h>
#include <pthread.h>
#include <linux/videodev2.h>
#include <linux/v4l2-controls.h>
#include <linux/cedrus_h264.h>
#include <linux/cedrus_h265.h>
#include <linux/cedrus_vp9.h>

#define CEDRUS_DEVICE_PATH "/dev/video-decoder"
#define MAX_BUFFERS 8

typedef enum {
    CEDRUS_CODEC_H264 = 0,
    CEDRUS_CODEC_H265 = 1,
    CEDRUS_CODEC_VP9  = 2,
} CedrusCodec;

typedef struct {
    int fd;
    int width;
    int height;
    CedrusCodec codec;
    
    // Input (OUTPUT) buffers - compressed stream
    int num_buffers;
    void* mapped_buffers[MAX_BUFFERS];
    size_t buffer_sizes[MAX_BUFFERS];
    
    // Output (CAPTURE) buffers - decoded frames
    void* out_mapped;
    size_t out_size;
    
    pthread_mutex_t lock;
    pthread_cond_t cond;
    int frame_ready;
    int eos;
} cedrus_ctx_t;

typedef cedrus_ctx_t* NearcadeDecoder;

static int xioctl(int fd, int request, void* arg) {
    int r;
    do r = ioctl(fd, request, arg);
    while (r == -1 && (errno == EINTR || errno == EAGAIN));
    return r;
}

static int open_device(cedrus_ctx_t* ctx) {
    ctx->fd = open(CEDRUS_DEVICE_PATH, O_RDWR | O_NONBLOCK);
    if (ctx->fd < 0) {
        fprintf(stderr, "[cedrus] Failed to open %s: %s\n", CEDRUS_DEVICE_PATH, strerror(errno));
        return -1;
    }
    return 0;
}

static int setup_format(cedrus_ctx_t* ctx) {
    struct v4l2_format fmt = {0};
    fmt.type = V4L2_BUF_TYPE_VIDEO_OUTPUT_MPLANE;
    fmt.fmt.pix_mp.width = ctx->width;
    fmt.fmt.pix_mp.height = ctx->height;
    fmt.fmt.pix_mp.pixelformat = ctx->codec == CEDRUS_CODEC_H264 ? V4L2_PIX_FMT_H264 :
                                 ctx->codec == CEDRUS_CODEC_H265 ? V4L2_PIX_FMT_HEVC :
                                                                     V4L2_PIX_FMT_VP9;
    fmt.fmt.pix_mp.num_planes = 1;
    fmt.fmt.pix_mp.plane_fmt[0].sizeimage = ctx->width * ctx->height * 3 / 2;
    
    if (xioctl(ctx->fd, VIDIOC_S_FMT, &fmt) < 0) {
        perror("[cedrus] S_FMT OUTPUT failed");
        return -1;
    }
    
    // Capture format (decoded frames)
    fmt.type = V4L2_BUF_TYPE_VIDEO_CAPTURE_MPLANE;
    fmt.fmt.pix_mp.pixelformat = V4L2_PIX_FMT_NV12;
    fmt.fmt.pix_mp.width = ctx->width;
    fmt.fmt.pix_mp.height = ctx->height;
    fmt.fmt.pix_mp.num_planes = 2;
    
    if (xioctl(ctx->fd, VIDIOC_S_FMT, &fmt) < 0) {
        perror("[cedrus] S_FMT CAPTURE failed");
        return -1;
    }
    
    ctx->width = fmt.fmt.pix_mp.width;
    ctx->height = fmt.fmt.pix_mp.height;
    return 0;
}

static int request_buffers(cedrus_ctx_t* ctx) {
    struct v4l2_requestbuffers req = {0};
    
    // OUTPUT (compressed stream)
    req.type = V4L2_BUF_TYPE_VIDEO_OUTPUT_MPLANE;
    req.memory = V4L2_MEMORY_MMAP;
    req.count = MAX_BUFFERS;
    if (xioctl(ctx->fd, VIDIOC_REQBUFS, &req) < 0) {
        perror("[cedrus] REQBUFS OUTPUT failed");
        return -1;
    }
    ctx->num_buffers = req.count;
    
    // Map OUTPUT buffers
    for (int i = 0; i < ctx->num_buffers; i++) {
        struct v4l2_buffer buf = {0};
        buf.type = V4L2_BUF_TYPE_VIDEO_OUTPUT_MPLANE;
        buf.memory = V4L2_MEMORY_MMAP;
        buf.index = i;
        buf.length = 1;
        
        struct v4l2_plane plane = {0};
        buf.m.planes = &plane;
        
        if (xioctl(ctx->fd, VIDIOC_QUERYBUF, &buf) < 0) {
            perror("[cedrus] QUERYBUF OUTPUT failed");
            return -1;
        }
        
        ctx->buffer_sizes[i] = plane.length;
        ctx->mapped_buffers[i] = mmap(NULL, plane.length, PROT_READ | PROT_WRITE,
                                      MAP_SHARED, ctx->fd, plane.m.mem_offset);
        if (ctx->mapped_buffers[i] == MAP_FAILED) {
            perror("[cedrus] mmap OUTPUT failed");
            return -1;
        }
    }
    
    // CAPTURE (decoded frames) - 2 planes NV12
    struct v4l2_requestbuffers req_cap = {0};
    req_cap.type = V4L2_BUF_TYPE_VIDEO_CAPTURE_MPLANE;
    req_cap.memory = V4L2_MEMORY_MMAP;
    req_cap.count = 4;
    if (xioctl(ctx->fd, VIDIOC_REQBUFS, &req_cap) < 0) {
        perror("[cedrus] REQBUFS CAPTURE failed");
        return -1;
    }
    
    // Map capture buffers (2 planes NV12)
    struct v4l2_buffer buf = {0};
    buf.type = V4L2_BUF_TYPE_VIDEO_CAPTURE_MPLANE;
    buf.memory = V4L2_MEMORY_MMAP;
    buf.index = 0;
    buf.length = 2;
    struct v4l2_plane planes[2];
    buf.m.planes = planes;
    
    if (xioctl(ctx->fd, VIDIOC_QUERYBUF, &buf) < 0) {
        perror("[cedrus] QUERYBUF CAPTURE failed");
        return -1;
    }
    
    size_t total_size = planes[0].length + planes[1].length;
    ctx->out_mapped = mmap(NULL, total_size, PROT_READ | PROT_WRITE,
                           MAP_SHARED, ctx->fd, planes[0].m.mem_offset);
    if (ctx->out_mapped == MAP_FAILED) {
        perror("[cedrus] mmap CAPTURE failed");
        return -1;
    }
    ctx->out_size = total_size;
    
    return 0;
}

static int queue_input_buffer(cedrus_ctx_t* ctx, int index, const uint8_t* data, size_t size,
                               int64_t timestamp, int flags) {
    struct v4l2_buffer buf = {0};
    buf.type = V4L2_BUF_TYPE_VIDEO_OUTPUT_MPLANE;
    buf.memory = V4L2_MEMORY_MMAP;
    buf.index = index;
    buf.length = 1;
    buf.flags = flags;
    buf.timestamp.tv_sec = timestamp / 1000000;
    buf.timestamp.tv_usec = timestamp % 1000000;
    
    struct v4l2_plane plane = {0};
    plane.bytesused = size;
    plane.length = ctx->buffer_sizes[index];
    buf.m.planes = &plane;
    
    if (data && size > 0) {
        memcpy(ctx->mapped_buffers[index], data, size);
    }
    
    return xioctl(ctx->fd, VIDIOC_QBUF, &buf);
}

static int queue_capture_buffer(cedrus_ctx_t* ctx) {
    struct v4l2_buffer buf = {0};
    buf.type = V4L2_BUF_TYPE_VIDEO_CAPTURE_MPLANE;
    buf.memory = V4L2_MEMORY_MMAP;
    buf.index = 0;
    buf.length = 2;
    
    struct v4l2_plane planes[2] = {0};
    planes[0].bytesused = 0;
    planes[1].bytesused = 0;
    buf.m.planes = planes;
    
    return xioctl(ctx->fd, VIDIOC_QBUF, &buf);
}

static int start_streaming(cedrus_ctx_t* ctx) {
    // Queue all capture buffers
    for (int i = 0; i < 4; i++) {
        if (queue_capture_buffer(ctx) < 0) return -1;
    }
    
    // Stream on
    int type = V4L2_BUF_TYPE_VIDEO_OUTPUT_MPLANE;
    if (xioctl(ctx->fd, VIDIOC_STREAMON, &type) < 0) {
        perror("[cedrus] STREAMON OUTPUT failed");
        return -1;
    }
    
    type = V4L2_BUF_TYPE_VIDEO_CAPTURE_MPLANE;
    if (xioctl(ctx->fd, VIDIOC_STREAMON, &type) < 0) {
        perror("[cedrus] STREAMON CAPTURE failed");
        return -1;
    }
    
    return 0;
}

static int stop_streaming(cedrus_ctx_t* ctx) {
    int type = V4L2_BUF_TYPE_VIDEO_OUTPUT_MPLANE;
    xioctl(ctx->fd, VIDIOC_STREAMOFF, &type);
    type = V4L2_BUF_TYPE_VIDEO_CAPTURE_MPLANE;
    xioctl(ctx->fd, VIDIOC_STREAMOFF, &type);
    return 0;
}

int cedrus_decoder_open(const char* codec_name, int width, int height, NearcadeDecoder* out_decoder) {
    if (!out_decoder) return -1;
    
    CedrusCodec codec = CEDRUS_CODEC_H264;
    if (strcasecmp(codec_name, "h265") == 0 || strcasecmp(codec_name, "hevc") == 0)
        codec = CEDRUS_CODEC_H265;
    else if (strcasecmp(codec_name, "vp9") == 0)
        codec = CEDRUS_CODEC_VP9;
    
    cedrus_ctx_t* ctx = calloc(1, sizeof(cedrus_ctx_t));
    if (!ctx) return -1;
    
    ctx->width = width;
    ctx->height = height;
    ctx->codec = codec;
    pthread_mutex_init(&ctx->lock, NULL);
    pthread_cond_init(&ctx->cond, NULL);
    
    if (open_device(ctx) < 0) goto fail;
    if (setup_format(ctx) < 0) goto fail;
    if (request_buffers(ctx) < 0) goto fail;
    if (start_streaming(ctx) < 0) goto fail;
    
    *out_decoder = (NearcadeDecoder*)ctx;
    return 0;

fail:
    if (ctx->fd > 0) close(ctx->fd);
    free(ctx);
    return -1;
}

int cedrus_decoder_decode(NearcadeDecoder* decoder, const uint8_t* data, size_t size,
                          int64_t timestamp, int flags, uint8_t** out_frame, size_t* out_size) {
    cedrus_ctx_t* ctx = (cedrus_ctx_t*)decoder;
    if (!ctx) return -1;
    
    pthread_mutex_lock(&ctx->lock);
    
    // Find free output buffer
    int free_idx = -1;
    for (int i = 0; i < ctx->num_buffers; i++) {
        // Simplified: just use round-robin
        free_idx = (ctx->num_buffers + 1) % ctx->num_buffers;
        break;
    }
    
    if (free_idx < 0) {
        pthread_mutex_unlock(&ctx->lock);
        return -EBUSY;
    }
    
    int qres = queue_input_buffer(ctx, free_idx, data, size, timestamp, flags);
    if (qres < 0) {
        pthread_mutex_unlock(&ctx->lock);
        return qres;
    }
    
    // Wait for decoded frame
    struct pollfd pfd = { .fd = ctx->fd, .events = POLLIN };
    int ret = poll(&pfd, 1, 100); // 100ms timeout
    
    if (ret > 0) {
        struct v4l2_buffer dqbuf = {0};
        dqbuf.type = V4L2_BUF_TYPE_VIDEO_CAPTURE_MPLANE;
        dqbuf.memory = V4L2_MEMORY_MMAP;
        dqbuf.length = 2;
        
        struct v4l2_plane planes[2] = {0};
        dqbuf.m.planes = planes;
        
        if (xioctl(ctx->fd, VIDIOC_DQBUF, &dqbuf) == 0) {
            // Frame decoded successfully
            *out_frame = ctx->out_mapped;
            *out_size = 0;
            for (int i = 0; i < dqbuf.length; i++) {
                *out_size += dqbuf.m.planes[i].bytesused;
            }
            
            // Re-queue the capture buffer
            queue_capture_buffer(ctx);
            
            pthread_mutex_unlock(&ctx->lock);
            return 0;
        }
    }
    
    pthread_mutex_unlock(&ctx->lock);
    return -EAGAIN;
}

void cedrus_decoder_close(NearcadeDecoder* decoder) {
    cedrus_ctx_t* ctx = (cedrus_ctx_t*)decoder;
    if (!ctx) return;
    
    stop_streaming(ctx);
    
    for (int i = 0; i < ctx->num_buffers; i++) {
        if (ctx->mapped_buffers[i]) {
            munmap(ctx->mapped_buffers[i], ctx->buffer_sizes[i]);
        }
    }
    if (ctx->out_mapped) {
        munmap(ctx->out_mapped, ctx->out_size);
    }
    
    close(ctx->fd);
    pthread_mutex_destroy(&ctx->lock);
    pthread_cond_destroy(&ctx->cond);
    free(ctx);
}

// Backend registration
extern const nearcade_decode_backend_t nearcade_cedrus_decode_backend;

const nearcade_decode_backend_t nearcade_cedrus_decode_backend = {
    .name = "cedrus",
    .init = (int(*)(void**,int,int,const char*))cedrus_decoder_open,
    .decode = (int(*)(void*,const uint8_t*,size_t,int64_t,int,uint8_t**,size_t*))cedrus_decoder_decode,
    .destroy = (void(*)(void*))cedrus_decoder_close,
};