#!/bin/sh
set -e

APP_DIR="/opt/Gens Launcher"

if [ -f "$APP_DIR/chrome-sandbox" ]; then
    chown root:root "$APP_DIR/chrome-sandbox"
    chmod 4755 "$APP_DIR/chrome-sandbox"
fi

# Ubuntu 23.10+ / 24.04+ : autoriser userns via AppArmor pour le binaire installé
if [ -d /etc/apparmor.d ] && command -v apparmor_parser >/dev/null 2>&1; then
    PROFILE="/etc/apparmor.d/gens-launcher"
    cat > "$PROFILE" <<'EOF'
abi <abi/4.0>,
include <tunables/global>

profile gens-launcher "/opt/Gens Launcher/gens-launcher*" flags=(unconfined) {
  userns,
}
EOF
    apparmor_parser -r -T -W "$PROFILE" 2>/dev/null || true
fi

