#!/bin/sh
set -e

PROFILE="/etc/apparmor.d/gens-launcher"
if [ -f "$PROFILE" ]; then
    if command -v apparmor_parser >/dev/null 2>&1; then
        apparmor_parser -R "$PROFILE" 2>/dev/null || true
    fi
    rm -f "$PROFILE"
fi

