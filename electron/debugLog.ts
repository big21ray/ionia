import { DEBUG_LOGS } from '../src/shared/debug.js';

export { DEBUG_LOGS };

export const debugLog = (...args: unknown[]) => {
  if (DEBUG_LOGS) console.warn(...args);
};

export const debugWarn = (...args: unknown[]) => {
  if (DEBUG_LOGS) console.warn(...args);
};
