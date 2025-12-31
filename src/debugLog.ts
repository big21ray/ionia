import { DEBUG_LOGS } from './shared/debug';

export { DEBUG_LOGS };

export const debugLog = (...args: unknown[]) => {
  if (DEBUG_LOGS) console.log(...args);
};

export const debugWarn = (...args: unknown[]) => {
  if (DEBUG_LOGS) console.warn(...args);
};
