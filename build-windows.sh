#!/usr/bin/env bash
# Cross-build Callio for Windows from Linux. On Windows (or with GitHub Actions, see
# .github/workflows/build.yml): build office/ with cargo, copy callio-office.exe to office/bin/,
# then run  npm ci && npx tauri build
#
# Linux prerequisites: mingw-w64, nsis, Node 20+, Rust stable with the std *source* installed at
# $(rustc --print sysroot)/lib/rustlib/src/rust (rustup component add rust-src), because the
# Windows std is built from source here (-Zbuild-std). If `rustup target add x86_64-pc-windows-gnu`
# works for you, you can drop -Zbuild-std and the shim.
set -euo pipefail
cd "$(dirname "$0")"
export RUSTC_BOOTSTRAP=1
# The shim makes the Tauri CLI accept the target even though only its source std exists.
export PATH="$PWD/scripts/cross-shim:$PATH"
mkdir -p "$(rustc --print sysroot)/lib/rustlib/x86_64-pc-windows-gnu/lib"
# the office engine (Word documents, spreadsheets, PDF tools): a separate program next to Callio.exe,
# built first because the installer carries it. It catches panics per request, so it keeps unwinding.
(cd office && cargo build --release --target x86_64-pc-windows-gnu -Zbuild-std=std,panic_unwind)
# the installer and the portable zip take the engine from office/bin
mkdir -p office/bin && cp office/target/x86_64-pc-windows-gnu/release/callio-office.exe office/bin/
npx tauri build --target x86_64-pc-windows-gnu --bundles nsis -- -Zbuild-std=std,panic_abort
