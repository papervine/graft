#!/usr/bin/env bash
#
# Cloud Agent install phase.
#
# besdk pins its whole multi-language toolchain (Node, Go, PHP, JDK 21, Maven, the .NET SDK, uv,
# Python, google-java-format) in `devbox.json`/`devbox.lock`, so this script provisions devbox +
# Nix and then does the repository bootstrap the language suites expect: JS deps, a TypeScript
# build, the Python virtualenv, and the PHP Composer dependencies.
#
# It is idempotent: every step is either guarded or safe to re-run, so `install` can run again over
# a warm checkout without duplicating state.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

NIX_PROFILE=/nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh
NIX_SOCKET=/nix/var/nix/daemon-socket/socket
NIX_DAEMON=/nix/var/nix/profiles/default/bin/nix-daemon

# The Cloud Agent VM has no systemd (PID 1 is tini), so the multi-user Nix daemon that `devbox`
# needs is not started for us. Launch it by hand and wait for its socket. Safe to call repeatedly.
#
# The liveness test is a *process* check, not a socket-file check: an environment build snapshots
# the disk, so the daemon's socket file survives into the next boot with nothing listening on it.
# Trusting the file would skip the (re)start and leave `devbox` with "Connection refused".
start_nix_daemon() {
  pgrep -x nix-daemon >/dev/null 2>&1 && return 0
  [ -x "$NIX_DAEMON" ] || return 1
  sudo rm -f "$NIX_SOCKET"
  sudo sh -c "nohup '$NIX_DAEMON' >/nix/var/log/nix-daemon.log 2>&1 &"
  for _ in $(seq 1 60); do
    [ -S "$NIX_SOCKET" ] && pgrep -x nix-daemon >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

# 1. devbox itself (a single static binary in /usr/local/bin).
if ! command -v devbox >/dev/null 2>&1; then
  curl -fsSL https://get.jetify.com/devbox -o /tmp/install-devbox.sh
  yes | bash /tmp/install-devbox.sh -f
fi

# 2. Nix is installed by the first `devbox install`. Without a running daemon that first run
#    fails on a missing socket, so we let it install Nix, start the daemon ourselves, then retry.
if [ ! -e "$NIX_PROFILE" ]; then
  devbox install || true
fi
start_nix_daemon
# shellcheck disable=SC1090
[ -e "$NIX_PROFILE" ] && . "$NIX_PROFILE"

# 3. The pinned toolchain. On a warm store this is a no-op; on a cold one it populates /nix.
devbox install

# 4. JavaScript workspace: dependencies, then the TypeScript build the CLI and targets run from.
devbox run -- pnpm install --frozen-lockfile
devbox run -- pnpm build

# 5. Python toolchain. One virtualenv under runtime-python serves both the runtime and target
#    suites (the target's tests inject its src/ onto sys.path).
devbox run -- sh -c 'cd packages/runtime-python && { [ -d .venv ] || uv venv .venv; } && uv pip install --python .venv/bin/python -e . ruff mypy pytest pytest-asyncio'

# 6. PHP Composer dependencies for both PHP packages.
devbox run -- sh -c 'cd packages/runtime-php && composer install --no-interaction && cd ../target-php && composer install --no-interaction'

echo "install: besdk toolchain and dependencies are ready."
