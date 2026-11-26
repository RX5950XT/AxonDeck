#!/bin/sh
# deb／rpm 安裝後：刷新桌面資料庫與圖示快取，讓開始選單看得到 AxonDeck。
# 不改使用者既有的預設開啟程式。
set -e
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database -q /usr/share/applications 2>/dev/null || true
fi
if command -v update-mime-database >/dev/null 2>&1 && [ -d /usr/share/mime ]; then
  update-mime-database /usr/share/mime 2>/dev/null || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1 && [ -d /usr/share/icons/hicolor ]; then
  gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor 2>/dev/null || true
fi
exit 0
