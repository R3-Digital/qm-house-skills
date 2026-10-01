#!/usr/bin/env bash
# mule-runtime helper for QM sandboxes (Fly Sprites, Ubuntu, x86_64 or aarch64).
# Installs Temurin 17, Maven and Mule into the home directory without apt, runs Mule in the
# foreground for QM's background tool, deploys apps and runs a hello-world smoke test.
# Every download is pinned and checked against a known checksum. Prints no secrets.
#
# Usage: mule.sh setup [--heap MB] [--ee-zip FILE] [--license FILE] [--no-prefill]
#        mule.sh run                 foreground "bin/mule console"; start it with the background tool
#        mule.sh status | env | logs [N] | stop
#        mule.sh deploy JAR [--wait SECONDS]
#        mule.sh build-hello         build the hello-world app (also pre-fills ~/.m2)
#        mule.sh smoke               deploy hello-world and curl it (Mule must be running)
#        mule.sh heap MB             set the JVM heap in conf/wrapper.conf (restart Mule after)
#        mule.sh license-info        EE only: evaluation flag and expiry (Mule stopped)
# Exit: 0 ok, 2 usage, 3 download or checksum failure, 4 not installed, 5 Mule not running,
#       6 deploy or smoke failure, 7 Mule already running.
set -euo pipefail
umask 022

ROOT="${MULE_RUNTIME_ROOT:-$HOME}"
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.mule-runtime.env"
PORT="${MULE_HTTP_PORT:-8081}"

JDK_VER="17.0.20.1+1"
JDK_DIR="$ROOT/jdk17"
JDK_URL_BASE="https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.20.1%2B1"
JDK_X64_FILE="OpenJDK17U-jdk_x64_linux_hotspot_17.0.20.1_1.tar.gz"
JDK_X64_SHA256="3808d1d15e3ec6bd5b84057fb5d84c33d8a1536a258146bcea2e603fc726e08e"
JDK_ARM_FILE="OpenJDK17U-jdk_aarch64_linux_hotspot_17.0.20.1_1.tar.gz"
JDK_ARM_SHA256="457b57af8f9c93ec39080bb8c764f559dc8c89a6da1a39d718a400b7890d3e41"

MVN_VER="3.9.16"
MVN_DIR="$ROOT/apache-maven-$MVN_VER"
MVN_URL="https://archive.apache.org/dist/maven/maven-3/$MVN_VER/binaries/apache-maven-$MVN_VER-bin.tar.gz"
MVN_SHA512="831a8591fe20c8243b1dbe7d71e3244f31d1665b0804b2e825e38cbbe5ce0cafb8338851f90780735568773e0a6cd07bbec107cda0b896b008b861075358b6f6"

CE_VER="4.12.0"
CE_DIR="$ROOT/mule-standalone-$CE_VER"
CE_URL="https://repository.mulesoft.org/nexus/content/repositories/releases/org/mule/distributions/mule-standalone/$CE_VER/mule-standalone-$CE_VER.tar.gz"
CE_SHA256="3d860ae6066051ef38d1edff778c11c4c067754b8ad04f08809db99f8fa385ff"

HELLO_DIR="$ROOT/mule-hello"

log() { printf '[mule-runtime] %s\n' "$*"; }
die() { local code=$1; shift; printf '[mule-runtime] ERROR: %s\n' "$*" >&2; exit "$code"; }

# Download URL to FILE and check it. ALGO is sha256 or sha512.
fetch() {
  local url=$1 file=$2 algo=$3 want=$4 got
  log "downloading $(basename "$file")"
  curl -fsSL --retry 3 --retry-delay 2 -o "$file.part" "$url" || { rm -f "$file.part"; die 3 "download failed: $url"; }
  got=$("${algo}sum" "$file.part" | cut -d' ' -f1)
  if [ "$got" != "$want" ]; then rm -f "$file.part"; die 3 "$algo mismatch for $(basename "$file") (got $got)"; fi
  mv "$file.part" "$file"
  log "$algo ok"
}

# Extract a .tar.gz whose single top directory becomes DEST.
untar_to() {
  local file=$1 dest=$2 tmp
  tmp=$(mktemp -d "$ROOT/.mule-runtime-x.XXXXXX")
  tar xzf "$file" -C "$tmp"
  local top
  top=$(find "$tmp" -mindepth 1 -maxdepth 1 -type d | head -1)
  [ -n "$top" ] || die 3 "empty archive $(basename "$file")"
  rm -rf "$dest"
  mv "$top" "$dest"
  rm -rf "$tmp" "$file"
}

install_jdk() {
  if [ -x "$JDK_DIR/bin/java" ] && "$JDK_DIR/bin/java" -version 2>&1 | grep -q '"17\.'; then
    log "Temurin 17 already in $JDK_DIR (skip)"; return; fi
  local arch file sha
  arch=$(uname -m)
  case "$arch" in
    x86_64|amd64) file=$JDK_X64_FILE; sha=$JDK_X64_SHA256 ;;
    aarch64|arm64) file=$JDK_ARM_FILE; sha=$JDK_ARM_SHA256 ;;
    *) die 3 "unsupported CPU architecture $arch" ;;
  esac
  fetch "$JDK_URL_BASE/$file" "$ROOT/$file" sha256 "$sha"
  untar_to "$ROOT/$file" "$JDK_DIR"
  log "installed Temurin $JDK_VER in $JDK_DIR"
}

install_maven() {
  if [ -x "$MVN_DIR/bin/mvn" ]; then log "Maven $MVN_VER already in $MVN_DIR (skip)"; return; fi
  fetch "$MVN_URL" "$ROOT/apache-maven-$MVN_VER-bin.tar.gz" sha512 "$MVN_SHA512"
  untar_to "$ROOT/apache-maven-$MVN_VER-bin.tar.gz" "$MVN_DIR"
  log "installed Maven $MVN_VER in $MVN_DIR"
}

install_ce() {
  if [ -x "$CE_DIR/bin/mule" ]; then log "Mule Kernel $CE_VER already in $CE_DIR (skip)"; return; fi
  fetch "$CE_URL" "$ROOT/mule-standalone-$CE_VER.tar.gz" sha256 "$CE_SHA256"
  untar_to "$ROOT/mule-standalone-$CE_VER.tar.gz" "$CE_DIR"
  log "installed Mule Kernel (CE) $CE_VER in $CE_DIR"
}

# Unzip a supplied Enterprise distribution, keeping file modes. Prints the Mule home it created.
install_ee() {
  local zip=$1
  [ -f "$zip" ] || die 2 "EE zip not found: $zip"
  python3 - "$zip" "$ROOT" <<'PY'
import os, sys, zipfile
zpath, root = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(zpath) as z:
    names = z.namelist()
    tops = {n.split("/", 1)[0] for n in names if n.strip("/")}
    if len(tops) != 1:
        sys.exit("EE zip must have one top directory, found: %s" % sorted(tops)[:5])
    top = tops.pop()
    dest = os.path.realpath(os.path.join(root, top))
    if os.path.exists(os.path.join(dest, "bin", "mule")):
        print(dest); sys.exit(0)
    for info in z.infolist():
        target = os.path.realpath(os.path.join(root, info.filename))
        if not target.startswith(os.path.realpath(root) + os.sep):
            sys.exit("unsafe path in zip: %s" % info.filename)
        z.extract(info, root)
        mode = (info.external_attr >> 16) & 0o777
        if mode and not info.is_dir():
            os.chmod(target, mode)
    print(dest)
PY
}

mule_version_of() { # MULE_HOME -> version from the directory name, e.g. 4.12.1
  basename "$1" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1
}

write_env() {
  local home=$1
  cat > "$ENV_FILE" <<ENV
export JAVA_HOME="$JDK_DIR"
export MAVEN_HOME="$MVN_DIR"
export MULE_HOME="$home"
export PATH="$JDK_DIR/bin:$MVN_DIR/bin:\$PATH"
ENV
  log "wrote $ENV_FILE (MULE_HOME=$home)"
}

load_env() {
  [ -f "$ENV_FILE" ] || die 4 "not set up yet; run: mule.sh setup"
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  [ -x "$JAVA_HOME/bin/java" ] && [ -x "$MULE_HOME/bin/mule" ] || die 4 "install incomplete; run: mule.sh setup"
}

set_heap() {
  local mb=$1 conf="$MULE_HOME/conf/wrapper.conf"
  [[ "$mb" =~ ^[0-9]+$ ]] && [ "$mb" -ge 256 ] && [ "$mb" -le 6144 ] || die 2 "heap must be 256..6144 MB"
  [ -f "$conf.orig" ] || cp "$conf" "$conf.orig"
  sed -i -E "s/^wrapper\.java\.initmemory=.*/wrapper.java.initmemory=$mb/; s/^wrapper\.java\.maxmemory=.*/wrapper.java.maxmemory=$mb/" "$conf"
  log "heap set to $mb MB in $conf (original kept as wrapper.conf.orig); restart Mule to apply"
}

hello_jar() { find "$HELLO_DIR/target" -maxdepth 1 -name '*-mule-application.jar' 2>/dev/null | head -1; }

mule_pid() { pgrep -f -- "-Dmule.home=$MULE_HOME" | head -1 || true; }

build_hello() {
  local ver
  ver=$(mule_version_of "$MULE_HOME")
  [ -n "$ver" ] || die 4 "cannot tell the Mule version from $MULE_HOME"
  rm -rf "$HELLO_DIR"
  cp -r "$SKILL_DIR/assets/hello-mule" "$HELLO_DIR"
  sed -i "s/@MULE_VERSION@/$ver/g" "$HELLO_DIR/pom.xml" "$HELLO_DIR/mule-artifact.json"
  log "building hello-world for Mule $ver (first build downloads about 200 MB into ~/.m2)"
  local t0=$SECONDS
  (cd "$HELLO_DIR" && mvn -B -q -DskipTests package) || die 6 "Maven build failed"
  log "built $(hello_jar) in $((SECONDS - t0))s"
}

deploy() {
  local jar=$1 wait=${2:-180} name anchor
  [ -f "$jar" ] || die 2 "no such jar: $jar"
  name=$(basename "$jar" .jar)
  anchor="$MULE_HOME/apps/$name-anchor.txt"
  if [ -f "$anchor" ] && [ -f "$MULE_HOME/apps/$name.jar" ] && cmp -s "$jar" "$MULE_HOME/apps/$name.jar"; then
    log "$name is already deployed (same jar)"; return 0; fi
  local since i=0
  since=$(date +%s)
  cp "$jar" "$MULE_HOME/apps/"
  log "copied $name.jar to $MULE_HOME/apps"
  if [ -z "$(mule_pid)" ]; then log "Mule is not running; the app deploys when Mule starts"; return 0; fi
  while [ $i -lt "$wait" ]; do
    if [ -f "$anchor" ] && [ "$(stat -c %Y "$anchor")" -ge "$since" ]; then log "deployed $name"; return 0; fi
    sleep 1; i=$((i + 1))
  done
  grep -E " ERROR " "$MULE_HOME/logs/mule.log" | tail -n 20 >&2 || true
  die 6 "$name not deployed after ${wait}s; see $MULE_HOME/logs"
}

cmd=${1:-}
[ -n "$cmd" ] || { sed -n '6,16p' "$0"; exit 2; }
shift || true

case "$cmd" in
  setup)
    HEAP="" EE_ZIP="" LICENSE="" PREFILL=1
    while [ $# -gt 0 ]; do
      case "$1" in
        --heap) HEAP=${2:-}; shift 2 ;;
        --ee-zip) EE_ZIP=${2:-}; shift 2 ;;
        --license) LICENSE=${2:-}; shift 2 ;;
        --no-prefill) PREFILL=0; shift ;;
        *) die 2 "unknown option $1" ;;
      esac
    done
    mkdir -p "$ROOT"
    install_jdk
    install_maven
    if [ -n "$EE_ZIP" ]; then
      HOME_DIR=$(install_ee "$EE_ZIP")
      [ -x "$HOME_DIR/bin/mule" ] || die 4 "EE zip did not contain bin/mule"
      log "Mule Enterprise in $HOME_DIR"
    else
      [ -z "$LICENSE" ] || die 2 "--license only applies with --ee-zip (Mule Kernel does not take a licence)"
      install_ce
      HOME_DIR=$CE_DIR
    fi
    write_env "$HOME_DIR"
    load_env
    if [ -n "$LICENSE" ]; then
      [ -f "$LICENSE" ] || die 2 "licence file not found: $LICENSE"
      [ -z "$(mule_pid)" ] || die 7 "stop Mule before installing a licence (mule.sh stop)"
      log "installing the supplied Enterprise licence"
      "$MULE_HOME/bin/mule" -installLicense "$LICENSE"
      [ -f "$MULE_HOME/conf/muleLicenseKey.lic" ] || die 6 "licence install did not create conf/muleLicenseKey.lic"
      "$MULE_HOME/bin/mule" -verifyLicense 2>&1 | grep -oE 'Evaluation = [a-z]+|Expiration Date = [^,]+' || true
    fi
    [ -z "$HEAP" ] || set_heap "$HEAP"
    if [ "$PREFILL" = 1 ]; then build_hello; fi
    java -version 2>&1 | head -1
    mvn -v 2>/dev/null | head -1
    log "setup done. Start Mule with the background tool: bash $SKILL_DIR/scripts/mule.sh run"
    ;;
  env)
    [ -f "$ENV_FILE" ] || die 4 "not set up yet"
    cat "$ENV_FILE"
    ;;
  run)
    load_env
    [ -z "$(mule_pid)" ] || die 7 "Mule is already running (pid $(mule_pid))"
    log "starting Mule in the foreground: $MULE_HOME/bin/mule console"
    exec "$MULE_HOME/bin/mule" console
    ;;
  status)
    load_env
    pid=$(mule_pid)
    log "MULE_HOME=$MULE_HOME version=$(mule_version_of "$MULE_HOME")"
    if [ -z "$pid" ]; then log "Mule: NOT running (after a cold wake or restart, start it again with the background tool)"; exit 5; fi
    log "Mule: running, pid $pid, rss $(($(ps -o rss= -p "$pid") / 1024)) MB, up $(ps -o etime= -p "$pid" | tr -d ' ')"
    for a in "$MULE_HOME"/apps/*-anchor.txt; do [ -e "$a" ] && log "deployed: $(basename "$a" -anchor.txt)"; done
    ;;
  logs)
    load_env
    tail -n "${1:-100}" "$MULE_HOME/logs/mule.log"
    ;;
  stop)
    load_env
    pid=$(mule_pid)
    [ -n "$pid" ] || { log "Mule is not running"; exit 0; }
    "$MULE_HOME/bin/mule" stop >/dev/null 2>&1 || true
    for _ in $(seq 1 30); do [ -z "$(mule_pid)" ] && break; sleep 1; done
    if [ -n "$(mule_pid)" ]; then
      wp=$(pgrep -f -- "wrapper.*$MULE_HOME/conf/wrapper.conf" | head -1 || true)
      if [ -n "$wp" ]; then kill -TERM "$wp" 2>/dev/null || true; else kill -TERM "$(mule_pid)" 2>/dev/null || true; fi
      for _ in $(seq 1 30); do [ -z "$(mule_pid)" ] && break; sleep 1; done
    fi
    if [ -n "$(mule_pid)" ]; then die 6 "Mule did not stop"; fi
    log "Mule stopped"
    ;;
  license-info)
    load_env
    [ -z "$(mule_pid)" ] || die 7 "stop Mule first; MuleSoft documents -verifyLicense with the runtime stopped"
    "$MULE_HOME/bin/mule" -verifyLicense 2>&1 | grep -oE 'Evaluation = [a-z]+|Expiration Date = [^,]+|Entitlements = .*' || log "no licence information printed (Mule Kernel has no licence)"
    ;;
  heap)
    load_env
    set_heap "${1:-}"
    ;;
  deploy)
    load_env
    jar=${1:-}; [ -n "$jar" ] || die 2 "usage: mule.sh deploy JAR [--wait SECONDS]"
    w=180; [ "${2:-}" = "--wait" ] && w=${3:-180}
    deploy "$jar" "$w"
    ;;
  build-hello)
    load_env
    build_hello
    ;;
  smoke)
    load_env
    [ -n "$(mule_pid)" ] || die 5 "Mule is not running; start it with the background tool first"
    jar=$(hello_jar)
    if [ -z "$jar" ]; then build_hello; jar=$(hello_jar); fi
    t0=$SECONDS
    deploy "$jar" 180
    body=""
    for _ in 1 2 3 4 5; do body=$(curl -fsS --max-time 10 "http://localhost:$PORT/hello" 2>/dev/null) && break; sleep 2; done
    [ -n "$body" ] || die 6 "curl http://localhost:$PORT/hello failed"
    [ "$body" = "Hello from Mule on a QM sprite" ] || die 6 "unexpected response: $body"
    pid=$(mule_pid)
    log "SMOKE OK: GET http://localhost:$PORT/hello -> \"$body\" (deploy+request $((SECONDS - t0))s, Mule rss $(($(ps -o rss= -p "$pid") / 1024)) MB)"
    free -m | sed -n '1,2p'
    ;;
  *)
    die 2 "unknown command $cmd"
    ;;
esac
