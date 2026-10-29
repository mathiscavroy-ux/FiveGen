#!/usr/bin/env bash
# Puts the latest version of FiveGen online (VPS installed with install-vps.sh).
#   ssh root@IP_DU_VPS
#   bash /opt/fivegen/app/deploy/update.sh
# A restart stops the generations in progress: run it at a quiet time.
set -euo pipefail

APP="/opt/fivegen/app"
if [ "$(id -u)" -ne 0 ]; then echo "Lance ce script en root." >&2; exit 1; fi

before="$(sudo -u fivegen git -C "$APP" rev-parse HEAD)"
sudo -u fivegen git -C "$APP" pull --ff-only
after="$(sudo -u fivegen git -C "$APP" rev-parse HEAD)"

if [ "$before" = "$after" ]; then
  echo "Déjà à jour."
  exit 0
fi
if ! sudo -u fivegen git -C "$APP" diff --quiet "$before" "$after" -- package-lock.json; then
  sudo -u fivegen -H sh -c "cd '$APP' && npm ci --omit=dev --no-audit --no-fund"
fi

systemctl restart fivegen
sleep 2
if systemctl is-active --quiet fivegen; then
  echo "FiveGen à jour et relancé :"
  sudo -u fivegen git -C "$APP" log --oneline "$before..$after"
else
  echo "Le site ne démarre pas :"
  journalctl -u fivegen -n 30 --no-pager
  exit 1
fi
