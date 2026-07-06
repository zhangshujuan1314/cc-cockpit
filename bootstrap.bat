@echo off
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
call npm config set registry https://registry.npmmirror.com
call npm install --legacy-peer-deps
echo.
echo [仅浏览器模式] npm run web
echo [桌面壳模式]   npm install-shell ^&^& npm start
