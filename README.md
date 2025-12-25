# Ionia - Video Player

A Windows Electron video player application built with React, TypeScript, and Electron.

## Features

- 🎬 Basic HTML5 video player
- ▶️ Play/pause controls
- 🔊 Volume control
- ⏩ Seek/scrub functionality
- 📁 File browser to load videos

## Tech Stack

- **React** - UI framework
- **TypeScript** - Type safety
- **Electron** - Desktop app framework
- **Vite** - Build tool
- **Tailwind CSS** - Styling

## Getting Started

### Prerequisites

- Node.js (v18 or higher)
- npm or yarn

### Installation

1. Clone the repository:
```bash
git clone https://github.com/big21ray/ionia.git
cd ionia
```

2. Install dependencies:
```bash
npm install
```

### Development

Run the app in development mode:
```bash
npm run electron:dev
```

This will:
- Start the Vite dev server
- Build the Electron main process
- Launch the Electron app

### Building

Build the app for production:
```bash
npm run electron:build
```

## Project Structure

```
ionia/
├── electron/          # Electron main process
│   ├── main.ts       # Main process entry point
│   └── preload.ts    # Preload script
├── src/              # React application
│   ├── components/   # React components
│   ├── App.tsx       # Main app component
│   └── main.tsx      # React entry point
└── package.json      # Project configuration
```

## Development Plan

See [PlayerPlan.md](./PlayerPlan.md) for the complete development roadmap.

## License

MIT











