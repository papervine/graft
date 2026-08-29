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

if [ ! -S "$NIX_SOCKET" ] && [ -x "$NIX_DAEMON" ]; then
  sudo sh -c "nohup '$NIX_DAEMON' >/tmp/nix-daemon.log 2>&1 &"
  for _ in $(seq 1 60); do
    [ -S "$NIX_SOCKET" ] && break
    sleep 1
  done
fi
