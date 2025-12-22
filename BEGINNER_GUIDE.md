# Beginner's Guide to Understanding the Ionia Project

## What is This Project?

This is a **video player app** (like VLC or Windows Media Player) that runs on your computer. It's built using web technologies (HTML, CSS, JavaScript) but packaged as a desktop app.

---

## What You Need to Know First

### 1. **Node.js and npm** (You need to install these)
- **Node.js**: Lets you run JavaScript on your computer (not just in a browser)
- **npm**: A tool that comes with Node.js to install libraries/packages
- Think of npm like an app store for code libraries

### 2. **TypeScript vs JavaScript**
- **JavaScript**: The language you know
- **TypeScript**: JavaScript + type checking (helps catch errors)
- TypeScript code gets converted to JavaScript before running
- **Good news**: If you know JavaScript, TypeScript is just JavaScript with extra safety!

---

## What I Built - Simple Explanation

### Project Structure

```
ionia/
├── electron/              # The "desktop app" part
│   ├── main.ts           # Controls the app window
│   └── preload.ts        # Security bridge
├── src/                  # The "website" part (what you see)
│   ├── components/       # Reusable pieces of the UI
│   │   ├── VideoPlayer.tsx
│   │   └── FileBrowser.tsx
│   ├── App.tsx          # Main screen
│   └── main.tsx         # Starts the app
├── package.json         # List of tools/libraries needed
└── README.md            # Instructions
```

---

## Key Files Explained (JavaScript → TypeScript)

### 1. **package.json** - The Shopping List
```json
{
  "dependencies": {
    "react": "^18.2.0"    // UI library
  }
}
```
**In plain English**: "This app needs React to work. Go download it."

### 2. **src/App.tsx** - The Main Screen
```typescript
function App() {
  const [videoPath, setVideoPath] = useState<string | null>(null);
  // ...
}
```

**JavaScript equivalent** (what you might write):
```javascript
function App() {
  let videoPath = null;
  // ...
}
```

**TypeScript differences**:
- `const [videoPath, setVideoPath]` = React's way to store data (like a variable)
- `useState<string | null>` = "videoPath can be a string OR null"
- In JavaScript, you'd just write: `let videoPath = null;`

### 3. **src/components/VideoPlayer.tsx** - The Video Player

**Key parts explained**:

```typescript
const videoRef = useRef<HTMLVideoElement>(null);
```
**JavaScript equivalent**: `const videoRef = { current: null };`
- `useRef` = React's way to get a reference to an HTML element
- `<HTMLVideoElement>` = TypeScript says "this will be a video element"

```typescript
const [isPlaying, setIsPlaying] = useState(false);
```
**JavaScript equivalent**: `let isPlaying = false;`
- `useState(false)` = "Create a variable that starts as false"
- `setIsPlaying` = "Function to change isPlaying"

```typescript
const togglePlayPause = () => {
  if (isPlaying) {
    video.pause();
  } else {
    video.play();
  }
  setIsPlaying(!isPlaying);
};
```
**This is just regular JavaScript!** TypeScript doesn't change how this works.

### 4. **electron/main.ts** - The Desktop App Controller

```typescript
const createWindow = () => {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
  });
};
```

**In plain English**: "Create a window that's 1200 pixels wide and 800 pixels tall."

This is Electron's code - it creates the desktop window. You don't need to understand all of it yet!

---

## TypeScript Basics for JavaScript Developers

### 1. **Type Annotations** (The Main Difference)

**JavaScript**:
```javascript
function greet(name) {
  return "Hello " + name;
}
```

**TypeScript**:
```typescript
function greet(name: string): string {
  return "Hello " + name;
}
```
- `name: string` = "name must be text"
- `: string` after `)` = "this function returns text"

**Why?** Catches errors like `greet(123)` before running!

### 2. **Interfaces** (Describing Objects)

**JavaScript**:
```javascript
function showVideo(video) {
  console.log(video.path);
}
```

**TypeScript**:
```typescript
interface Video {
  path: string;
  duration: number;
}

function showVideo(video: Video) {
  console.log(video.path);
}
```
- `interface Video` = "A video has a path (text) and duration (number)"
- Now TypeScript knows what properties `video` should have!

### 3. **Optional Values**

**TypeScript**:
```typescript
let videoPath: string | null = null;
```
- `string | null` = "Can be text OR nothing"
- In JavaScript, you'd just write: `let videoPath = null;`

---

## React Basics (If You're New to React)

### Components = Reusable UI Pieces

**Regular HTML**:
```html
<div>
  <button>Play</button>
</div>
```

**React Component**:
```typescript
function PlayButton() {
  return (
    <div>
      <button>Play</button>
    </div>
  );
}
```

### State = Data That Changes

**JavaScript**:
```javascript
let count = 0;
count = count + 1;  // Change it
```

**React**:
```typescript
const [count, setCount] = useState(0);
setCount(count + 1);  // Change it (triggers re-render)
```

### Props = Passing Data to Components

**JavaScript function**:
```javascript
function greet(name) {
  return "Hello " + name;
}
greet("John");
```

**React component**:
```typescript
function Greeting({ name }) {
  return <div>Hello {name}</div>;
}
<Greeting name="John" />
```

---

## What Each File Does

1. **package.json**: Lists all tools needed (like a recipe)
2. **tsconfig.json**: TypeScript settings (how strict to be)
3. **vite.config.ts**: Build tool settings (how to compile code)
4. **electron/main.ts**: Creates the desktop window
5. **src/App.tsx**: Main screen (shows file browser OR video player)
6. **src/components/VideoPlayer.tsx**: The actual video player with controls
7. **src/components/FileBrowser.tsx**: Button to open video files

---

## Learning Path

1. **Start with JavaScript**: Understand the logic first
2. **Learn React**: Components, state, props
3. **Add TypeScript gradually**: Start with simple types, add more as you learn
4. **Don't worry**: TypeScript is optional - you can write JavaScript and add types later!

---

## Common TypeScript Patterns You'll See

```typescript
// Variable with type
const name: string = "John";

// Function with types
function add(a: number, b: number): number {
  return a + b;
}

// Array of strings
const names: string[] = ["John", "Jane"];

// Object with specific shape
interface User {
  name: string;
  age: number;
}
const user: User = { name: "John", age: 30 };

// Optional property
interface Video {
  path: string;
  duration?: number;  // ? means optional
}
```

---

## Next Steps

1. Install Node.js (I'll help you with this)
2. Run `npm install` to download all tools
3. Run `npm run electron:dev` to start the app
4. Start reading the code - it's mostly JavaScript with type hints!

**Remember**: TypeScript is just JavaScript with training wheels. You can always remove the types and it becomes regular JavaScript!


