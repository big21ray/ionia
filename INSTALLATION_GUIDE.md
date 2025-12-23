# Installation Guide - Step by Step

## Step 1: Install Node.js

Node.js includes npm automatically, so you only need to install one thing!

### Option A: Download from Website (Recommended)

1. **Go to**: https://nodejs.org/
2. **Download**: Click the big green "LTS" button (Long Term Support version)
   - This will download a file like `node-v20.x.x-x64.msi`
3. **Run the installer**:
   - Double-click the downloaded file
   - Click "Next" through all the steps
   - **Important**: Make sure "Add to PATH" is checked (it should be by default)
   - Click "Install"
4. **Restart your terminal/PowerShell** after installation

### Option B: Using Winget (Windows Package Manager)

If you have Windows 11 or Windows 10 with winget:

```powershell
winget install OpenJS.NodeJS.LTS
```

### Verify Installation

After installing, open a **new** PowerShell window and run:

```powershell
node --version
npm --version
```

You should see version numbers like:
```
v20.10.0
10.2.3
```

If you see "command not found", restart your terminal or computer.

---

## Step 2: Install Project Dependencies

Once Node.js is installed, go to your project folder and run:

```powershell
cd "C:\Users\Karmine Corp\Documents\Ionia"
npm install
```

This will download all the tools and libraries needed (React, Electron, etc.)
- **Takes 2-5 minutes** the first time
- Downloads about 200-300 MB of files

---

## Step 3: Run the App

After installation completes:

```powershell
npm run electron:dev
```

This will:
1. Start a development server
2. Build the Electron app
3. Open the video player window

**First time might take 30-60 seconds** to compile everything.

---

## Troubleshooting

### "node is not recognized"
- Restart your terminal/PowerShell
- Restart your computer if that doesn't work
- Reinstall Node.js and make sure "Add to PATH" is checked

### "npm is not recognized"
- Same as above - Node.js includes npm, so if npm doesn't work, Node.js isn't installed correctly

### Installation takes forever
- Normal! First install downloads hundreds of files
- Make sure you have internet connection
- Be patient, it will finish

### "Permission denied" errors
- Run PowerShell as Administrator
- Right-click PowerShell → "Run as Administrator"

---

## What Gets Installed?

When you run `npm install`, it downloads:
- **React** - UI library (makes building interfaces easier)
- **Electron** - Desktop app framework
- **TypeScript** - JavaScript with types
- **Vite** - Build tool (compiles your code)
- **Tailwind CSS** - Styling library
- And many other helper tools

All stored in the `node_modules/` folder (you don't need to look in there!)

---

## Next Steps After Installation

1. ✅ Install Node.js
2. ✅ Run `npm install`
3. ✅ Run `npm run electron:dev`
4. 🎉 Your app should open!

Then you can start learning and modifying the code!






