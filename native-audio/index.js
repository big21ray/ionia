// Load the native module
// In development, it's in build/Release/
// In production, it should be in the same directory
const path = require('path');
const fs = require('fs');

let nativeModule;
const isDev = process.env.NODE_ENV === 'development';

// Try to load the native module
const possiblePaths = [
  path.join(__dirname, 'build/Release/wasapi_capture.node'),
  path.join(__dirname, 'build/Debug/wasapi_capture.node'),
  path.join(__dirname, 'wasapi_capture.node'),
];

for (const modulePath of possiblePaths) {
  if (fs.existsSync(modulePath)) {
    try {
      nativeModule = require(modulePath);
      break;
    } catch (err) {
      console.warn(`Failed to load native module from ${modulePath}:`, err.message);
    }
  }
}

if (!nativeModule) {
  throw new Error('WASAPI native module not found. Run "npm run build:native" first.');
}

module.exports = nativeModule;




