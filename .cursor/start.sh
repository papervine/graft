#!/usr/bin/env bash
#
# Cloud Agent start phase — runs on every boot.
#
# The Nix store and all installed packages persist in the environment build, but the multi-user Nix
# daemon that `devbox run` talks to is a live process, and this VM has no systemd to bring it back.
# Start it (idempotently) so `devbox run -- …` works as soon as the agent is up.
set -euo pipefail

NIX_SOCKET=/nix/var/nix/daemon-socket/socket
NIX_DAEMON=/nix/var/nix/profiles/default/bin/nix-daemon

# Liveness is a process check, not a socket-file check: the build snapshots the disk, so a dead
# daemon's socket file survives the boot with nothing listening. Clear it and start fresh.
if ! pgrep -x nix-daemon >/dev/null 2>&1 && [ -x "$NIX_DAEMON" ]; then
  sudo rm -f "$NIX_SOCKET"
  sudo sh -c "nohup '$NIX_DAEMON' >/nix/var/log/nix-daemon.log 2>&1 &"
  for _ in $(seq 1 60); do
    [ -S "$NIX_SOCKET" ] && pgrep -x nix-daemon >/dev/null 2>&1 && break
    sleep 1
  done
fi
