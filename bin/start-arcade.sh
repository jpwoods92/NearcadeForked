#!/bin/bash

# 1. Move to the directory where this script is located
cd "$(dirname "$0")"

# 2. If the script is inside the 'bin' folder, step back into the root project folder
if [ ! -f "electron-main.js" ]; then
    cd ..
fi

echo "Starting Nearsec Arcade Worker..."

# 3. Use npx to trigger the local Electron engine with the correct flag
npx electron . --arcade-worker
