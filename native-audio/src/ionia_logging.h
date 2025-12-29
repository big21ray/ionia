#pragma once

#include <atomic>

namespace Ionia {

// Debug logging is OFF by default.
// Can be enabled via JS by calling exported native function `setDebugLogging(true)`.
// Also supports env var: IONIA_DEBUG_LOGS=1 / true / yes.
void SetDebugLoggingEnabled(bool enabled);
bool IsDebugLoggingEnabled();

void LogDebugf(const char* fmt, ...);
void LogInfof(const char* fmt, ...);
void LogErrorf(const char* fmt, ...);

} // namespace Ionia
