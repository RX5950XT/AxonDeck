#!/bin/sh
# 假 sudo：給 test-terminal-root-linux.js 走「真的在 pty 上問密碼」那條路（測試機的 sudo 是免密碼）。
#   FAKE_SUDO_MODE=prompt  問密碼（不回顯），打 secret 才 exec 後面的程式；錯三次放棄
#   FAKE_SUDO_MODE=deny    問完密碼回「不在 sudoers」
mode="${FAKE_SUDO_MODE:-prompt}"
[ "$1" = "--" ] && shift
tries=0
while [ "$tries" -lt 3 ]; do
  printf '[sudo] password for %s: ' "$(id -un)"
  stty -echo 2>/dev/null
  IFS= read -r pw
  stty echo 2>/dev/null
  printf '\n'
  if [ "$mode" = deny ]; then
    echo "$(id -un) is not in the sudoers file.  This incident will be reported."
    exit 1
  fi
  [ "$pw" = "secret" ] && exec "$@"
  tries=$((tries + 1))
  [ "$tries" -lt 3 ] && echo "Sorry, try again."
done
echo "sudo: 3 incorrect password attempts"
exit 1
