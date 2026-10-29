#!/usr/bin/env bash
# FiveGen installation on a fresh Ubuntu 24.04 VPS (IONOS, OVH, Hetzner...).
# Installs Node.js 24, Caddy (automatic HTTPS), the site as a service that restarts by
# itself, a firewall, nightly backups and automatic security updates.
#
# From your PC (PowerShell):
#   scp deploy/install-vps.sh root@IP_DU_VPS:
#   ssh root@IP_DU_VPS
#   bash install-vps.sh
#
# Running it again is safe: it keeps the existing .env, data and backups.
set -euo pipefail

REPO="git@github.com:mathiscavroy-ux/FiveGen.git"
BASE="/opt/fivegen"
APP="$BASE/app"
PORT=3210

if [ "$(id -u)" -ne 0 ]; then
  echo "Lance ce script en root (ssh root@IP, puis bash install-vps.sh)." >&2
  exit 1
fi

read -rp "Nom de domaine du site [fivegen.fr] : " DOMAIN
DOMAIN="${DOMAIN:-fivegen.fr}"
DOMAIN="${DOMAIN#http://}"; DOMAIN="${DOMAIN#https://}"; DOMAIN="${DOMAIN%%/*}"
read -rp "Ajouter aussi www.$DOMAIN (redirigé vers $DOMAIN) ? [O/n] " WWW

echo "==> Mises à jour du système"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get upgrade -yq
apt-get install -yq curl git ufw ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https unattended-upgrades

# Small plans (2 Go) need some swap for npm and the Lua test runner.
if ! swapon --show | grep -q . && [ "$(awk '/MemTotal/ {print $2}' /proc/meminfo)" -lt 4000000 ]; then
  echo "==> Fichier d'échange de 2 Go"
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "==> Node.js 24"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -yq nodejs
fi
node -v

echo "==> Caddy (HTTPS automatique)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -yq caddy
fi

echo "==> Utilisateur fivegen"
id fivegen >/dev/null 2>&1 || useradd --system --create-home --home-dir "$BASE" --shell /bin/bash fivegen
mkdir -p "$BASE/backups"
chown fivegen:fivegen "$BASE" "$BASE/backups"

# The repository is private: the VPS reads it with its own read-only key (deploy key).
KEY="$BASE/.ssh/id_ed25519"
if [ ! -f "$KEY" ]; then
  sudo -u fivegen mkdir -p "$BASE/.ssh"
  sudo -u fivegen ssh-keygen -t ed25519 -N "" -C "fivegen-vps" -f "$KEY" >/dev/null
fi
grep -qs github.com "$BASE/.ssh/known_hosts" || sudo -u fivegen sh -c "ssh-keyscan -t ed25519 github.com >> '$BASE/.ssh/known_hosts' 2>/dev/null"
until sudo -u fivegen git ls-remote "$REPO" >/dev/null 2>&1; do
  echo
  echo "--------------------------------------------------------------------------"
  echo "Ajoute cette clé sur GitHub (Title : VPS IONOS, ne coche PAS « Allow write access ») :"
  echo "https://github.com/mathiscavroy-ux/FiveGen/settings/keys/new"
  echo
  cat "$KEY.pub"
  echo "--------------------------------------------------------------------------"
  read -rp "Appuie sur Entrée une fois la clé ajoutée... "
done

echo "==> Code du site"
if [ -d "$APP/.git" ]; then
  sudo -u fivegen git -C "$APP" pull --ff-only
else
  sudo -u fivegen git clone "$REPO" "$APP"
fi
sudo -u fivegen -H sh -c "cd '$APP' && npm ci --omit=dev --no-audit --no-fund"

echo "==> Fichier .env"
ENV="$APP/.env"
if [ ! -f "$ENV" ]; then
  sudo -u fivegen cp "$APP/.env.example" "$ENV"
  set_env() {
    if grep -qE "^#? ?$1=" "$ENV"; then sed -i -E "s|^#? ?$1=.*|$1=$2|" "$ENV"; else echo "$1=$2" >> "$ENV"; fi
  }
  set_env PUBLIC_URL "https://$DOMAIN"
  set_env HOST 127.0.0.1
  set_env PORT "$PORT"
  set_env NODE_ENV production
  set_env TRUST_PROXY 1
  set_env BACKUP_DIR "$BASE/backups"
  NEW_ENV=1
fi
chmod 600 "$ENV"
chown fivegen:fivegen "$ENV"

echo "==> Service fivegen"
cat > /etc/systemd/system/fivegen.service <<EOF
[Unit]
Description=FiveGen
After=network-online.target
Wants=network-online.target

[Service]
User=fivegen
WorkingDirectory=$APP
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=3
TimeoutStopSec=20
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$BASE

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable fivegen >/dev/null

echo "==> Caddy"
{
  echo "$DOMAIN {"
  echo "    encode gzip"
  echo "    reverse_proxy 127.0.0.1:$PORT {"
  echo "        # live generation progress (server-sent events) goes out without buffering"
  echo "        flush_interval -1"
  echo "    }"
  echo "}"
  case "$WWW" in
    [nN]*) ;;
    *) printf '\nwww.%s {\n    redir https://%s{uri} permanent\n}\n' "$DOMAIN" "$DOMAIN" ;;
  esac
} > /etc/caddy/Caddyfile
systemctl enable caddy >/dev/null
systemctl reload caddy 2>/dev/null || systemctl restart caddy

echo "==> Pare-feu"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

echo "==> Sauvegarde chaque nuit à 4 h"
cat > /etc/cron.d/fivegen <<EOF
0 4 * * * fivegen cd $APP && /usr/bin/node scripts/backup.js >> $BASE/backups/backup.log 2>&1
EOF

echo "==> Mises à jour de sécurité automatiques"
dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null

IP="$(curl -4 -fsS https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
echo
echo "=========================================================================="
echo "Installation terminée."
echo
if [ "${NEW_ENV:-}" = 1 ]; then
  echo "1. Remplis les clés (ENGINE_API_KEY, ENGINE_MODEL, ADMIN_EMAIL, Stripe, SMTP...) :"
  echo "     nano $ENV"
  echo "   puis : systemctl restart fivegen"
else
  echo "1. .env existant conservé, site redémarré."
  systemctl restart fivegen
fi
echo "2. DNS chez IONOS (Domaines & SSL > $DOMAIN > DNS) : A @ -> $IP"
case "$WWW" in [nN]*) ;; *) echo "   et A www -> $IP" ;; esac
echo "   (supprime les enregistrements AAAA). HTTPS automatique dès que le DNS pointe ici."
echo "3. Pare-feu IONOS (Réseau > Stratégies de pare-feu) : ports 22, 80 et 443 ouverts."
echo "4. Stripe : webhook https://$DOMAIN/api/stripe/webhook"
echo
echo "État du site   : systemctl status fivegen"
echo "Journaux       : journalctl -u fivegen -f"
echo "Mise à jour    : bash $APP/deploy/update.sh"
echo "=========================================================================="
