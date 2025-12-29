#include "ionia_logging.h"

#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <cstring>

namespace {
std::atomic<bool> g_debugLogging{false};

bool ParseEnvBool(const char* value) {
    if (!value || !*value) return false;

    // Normalize a few common truthy values.
    if (_stricmp(value, "1") == 0) return true;
    if (_stricmp(value, "true") == 0) return true;
    if (_stricmp(value, "yes") == 0) return true;
    if (_stricmp(value, "on") == 0) return true;

    return false;
}

void VLog(FILE* stream, const char* prefix, const char* fmt, va_list args) {
    if (prefix && *prefix) {
        std::fputs(prefix, stream);
    }
    std::vfprintf(stream, fmt, args);
    std::fflush(stream);
}

struct EnvInit {
    EnvInit() {
        const char* env = std::getenv("IONIA_DEBUG_LOGS");
        if (ParseEnvBool(env)) {
            g_debugLogging.store(true);
        }
    }
};

EnvInit g_envInit;
} // namespace

namespace Ionia {

void SetDebugLoggingEnabled(bool enabled) {
    g_debugLogging.store(enabled);
}

bool IsDebugLoggingEnabled() {
    return g_debugLogging.load();
}

void LogDebugf(const char* fmt, ...) {
    if (!IsDebugLoggingEnabled()) return;

    va_list args;
    va_start(args, fmt);
    VLog(stderr, "", fmt, args);
    va_end(args);
}

void LogInfof(const char* fmt, ...) {
    if (!IsDebugLoggingEnabled()) return;

    va_list args;
    va_start(args, fmt);
    VLog(stderr, "", fmt, args);
    va_end(args);
}

void LogErrorf(const char* fmt, ...) {
    va_list args;
    va_start(args, fmt);
    VLog(stderr, "", fmt, args);
    va_end(args);
}

} // namespace Ionia
