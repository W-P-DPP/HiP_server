#!/usr/bin/env bash
#
# WxBot general-server 一键部署脚本
# =====================================================================
# 把 README「生产部署教程」的 7 个步骤收敛成一条命令：
#   前置检查（Docker + 硬件要求）→ 准备密钥与 .env → 创建共享网络 → 启动推理服务（GPU + scenedetect）
#   → 构建并启动 app → 健康校验 → 输出访问入口
#
# 用法：
#   ./deploy.sh                 # 全量部署（默认）
#   ./deploy.sh app             # 只部署 app（GPU 服务已在运行）
#   ./deploy.sh gpu             # 只部署 GPU 服务
#   ./deploy.sh preflight       # 只做前置检查，不启动任何东西
#   ./deploy.sh verify          # 只做健康校验
#   ./deploy.sh status          # 查看容器状态
#   ./deploy.sh logs [服务名]    # 跟踪日志
#   ./deploy.sh down            # 停止全部（保留数据卷与网络）
#
# 选项：
#   --no-indextts | --no-whisper | --no-heygem   跳过对应 GPU 服务
#   --no-scenedetect 跳过 scenedetect（纯 CPU 场景切分服务）
#   --no-build       app 不做构建，直接 up -d
#   --force          compose up 时强制重建容器
#   --no-wait        不等待服务就绪（冷启动可达 1-3 分钟）
#   --timeout <秒>   就绪等待超时（默认 900，覆盖 Whisper 首次权重下载）
#   -h | --help      显示帮助
#
# 说明：脚本不含任何交互提示，可直接用于 Jenkins。
# =====================================================================

set -euo pipefail

# ---- 路径与全局 ----
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

APP_PROJECT_DIR="$ROOT_DIR"
INDEXTTS_DIR="$ROOT_DIR/services/indextts"
WHISPER_DIR="$ROOT_DIR/services/whisper"
HEYGEM_DIR="$ROOT_DIR/services/heygem"
SCENEDETECT_DIR="$ROOT_DIR/services/scenedetect"

APP_PORT="40010"
INDEXTTS_PORT="39010"
WHISPER_PORT="39020"
HEYGEM_PORT="8383"
SCENEDETECT_PORT="39040"

COMMAND="up"
BUILD_APP=1
FORCE_RECREATE=0
WAIT_READY=1
WAIT_TIMEOUT=900
WITH_INDEXTTS=1
WITH_WHISPER=1
WITH_HEYGEM=1
WITH_SCENEDETECT=1

# =====================================================================
# 最低硬件要求（部署前检查用）
# =====================================================================
# 阈值来源：README「生产部署 · 前置条件」与各服务 README 的显存/体积实测值。
# 全部可用同名环境变量覆盖，便于按机型微调。CPU / 内存 / 磁盘不达标即中止；
# GPU 只在本次确实要启动 GPU 服务时作硬性要求，显存硬门槛默认 20GB（单卡设计口径）。
# 注：VLM（图片理解）不在本脚本的部署范围内，故不计入显存/磁盘预算。
HW_MIN_CPU_CORES="${HW_MIN_CPU_CORES:-4}"            # CLUSTER_WORKERS='auto'=核数-2，≥4 才有并行价值
HW_BASE_MEM_GB="${HW_BASE_MEM_GB:-8}"               # app（Node + ffmpeg）+ Docker 的基础内存
HW_BASE_DISK_GB="${HW_BASE_DISK_GB:-15}"           # app 镜像、构建中间层、uploads/logs、Docker 自身
HW_GPU_VRAM_MARGIN_MB="${HW_GPU_VRAM_MARGIN_MB:-1024}"  # 显存安全余量
HW_MIN_GPU_VRAM_MB="${HW_MIN_GPU_VRAM_MB:-20480}"       # 显存硬门槛：README「本方案按单卡 20GB 设计」

# 各 GPU 服务的显存占用（MB，README 实测）
HW_VRAM_INDEXTTS_MB="${HW_VRAM_INDEXTTS_MB:-8192}"   # IndexTTS2 FP16 峰值 ~8GB
HW_VRAM_WHISPER_MB="${HW_VRAM_WHISPER_MB:-3072}"     # Whisper large-v3 fp16 ~3GB
HW_VRAM_HEYGEM_MB="${HW_VRAM_HEYGEM_MB:-3277}"       # duix/HeyGem ~3.2GB

# 各服务的宿主内存增量（GB）
HW_MEM_INDEXTTS_GB="${HW_MEM_INDEXTTS_GB:-3}"
HW_MEM_WHISPER_GB="${HW_MEM_WHISPER_GB:-2}"
HW_MEM_HEYGEM_GB="${HW_MEM_HEYGEM_GB:-2}"
HW_MEM_SCENEDETECT_GB="${HW_MEM_SCENEDETECT_GB:-1}"

# 各服务的磁盘增量（GB：权重 / 宿主 venv / 镜像）
HW_DISK_INDEXTTS_GB="${HW_DISK_INDEXTTS_GB:-25}"     # engine + 权重 ~22GB
HW_DISK_WHISPER_GB="${HW_DISK_WHISPER_GB:-8}"        # 宿主 venv + large-v3 ~3GB
HW_DISK_HEYGEM_GB="${HW_DISK_HEYGEM_GB:-16}"         # 上游镜像 ~15GB
HW_DISK_SCENEDETECT_GB="${HW_DISK_SCENEDETECT_GB:-2}"

# ---- 输出helpers ----
if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_DIM=$'\033[2m'; C_RED=$'\033[31m'; C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'; C_BOLD=$'\033[1m'
else
  C_RESET=""; C_DIM=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""; C_BOLD=""
fi

log()     { printf '%s\n' "$*"; }
info()    { printf '%s\n' "${C_BLUE}[信息]${C_RESET} $*"; }
ok()      { printf '%s\n' "${C_GREEN}[完成]${C_RESET} $*"; }
warn()    { printf '%s\n' "${C_YELLOW}[警告]${C_RESET} $*"; }
err()     { printf '%s\n' "${C_RED}[错误]${C_RESET} $*" >&2; }
die()     { err "$*"; exit 1; }
step()    { printf '\n%s\n' "${C_BOLD}==> $*${C_RESET}"; }
hint()    { printf '%s\n' "${C_DIM}    $*${C_RESET}"; }

usage() { sed -n '3,29p' "$0" | sed 's/^# \{0,1\}//'; }

# =====================================================================
# 参数解析
# =====================================================================
POSITIONAL=()
while [ $# -gt 0 ]; do
  case "$1" in
    up|app|gpu|preflight|verify|status|logs|down|restart)
      COMMAND="$1"; shift ;;
    --no-indextts) WITH_INDEXTTS=0; shift ;;
    --no-whisper)  WITH_WHISPER=0; shift ;;
    --no-heygem)   WITH_HEYGEM=0; shift ;;
    --no-scenedetect) WITH_SCENEDETECT=0; shift ;;
    --no-build)    BUILD_APP=0; shift ;;
    --force)       FORCE_RECREATE=1; shift ;;
    --no-wait)     WAIT_READY=0; shift ;;
    --timeout)     WAIT_TIMEOUT="${2:-}"; shift 2 ;;
    -h|--help)     usage; exit 0 ;;
    --*)           die "未知选项：$1（用 --help 查看用法）" ;;
    *)             POSITIONAL+=("$1"); shift ;;
  esac
done

case "$WAIT_TIMEOUT" in
  ''|*[!0-9]*) die "--timeout 需为正整数秒" ;;
esac

# =====================================================================
# 公共函数
# =====================================================================
COMPOSE=()

detect_compose() {
  if docker compose version >/dev/null 2>&1; then
    COMPOSE=(docker compose)
  elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE=(docker-compose)
  else
    die "未找到 docker compose（需要 Compose v2：'docker compose version' 应可用）"
  fi
}

# 读取 .env 文件中的键（取最后一条匹配，去掉行尾注释与包裹引号）
env_value() {
  local file="$1" key="$2" line value
  [ -f "$file" ] || return 1
  line="$(grep -E "^[[:space:]]*${key}=" "$file" 2>/dev/null | tail -n 1 || true)"
  [ -n "$line" ] || return 1
  value="${line#*=}"
  value="${value%$'\r'}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  case "$value" in
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
  esac
  printf '%s' "$value"
}

# 写入/覆盖 .env 文件中的键（不存在则追加）
set_env_value() {
  local file="$1" key="$2" value="$3" tmp
  tmp="$(mktemp)"
  awk -v k="$key" -v v="$value" '
    BEGIN { done = 0 }
    $0 ~ "^[[:space:]]*" k "=" { print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }
  ' "$file" > "$tmp"
  mv "$tmp" "$file"
}

container_health() {
  local name="$1" status
  status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$name" 2>/dev/null || true)"
  printf '%s' "$status"
}

# 轮询 HTTP 就绪（探针返回 2xx/3xx 即视为就绪）
wait_http() {
  local name="$1" url="$2" timeout="$3" deadline=$((SECONDS + timeout))
  printf '    %s 就绪等待（最长 %ss）' "$name" "$timeout"
  while [ "$SECONDS" -lt "$deadline" ]; do
    if curl -fsS -o /dev/null --max-time 5 "$url" 2>/dev/null; then
      printf ' %s\n' "${C_GREEN}就绪${C_RESET}"
      return 0
    fi
    printf '.'
    sleep 5
  done
  printf ' %s\n' "${C_YELLOW}超时${C_RESET}"
  return 1
}

# =====================================================================
# 硬件要求检查
# =====================================================================
# 探测宿主机资源；探测失败返回 0/空，调用方按「未知」处理，避免误判为不达标。
detect_cpu_cores() { nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 0; }
detect_mem_gb()    { awk '/^MemTotal:/ {printf "%d", $2/1024/1024}' /proc/meminfo 2>/dev/null || echo 0; }
detect_disk_free_gb() { df -Pk "$1" 2>/dev/null | awk 'NR==2 {printf "%d", $4/1024/1024}'; }
# 单卡最大显存（MiB）；多卡时取最大值，因为各服务都绑定 0 号卡
detect_gpu_vram_mb() {
  nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null \
    | awk 'BEGIN {m = 0} {gsub(/[^0-9]/, "", $1); if ($1 + 0 > m) m = $1 + 0} END {printf "%d", m}'
}

check_hardware() {
  step "硬件要求检查"
  local failed=0

  # 按本次启用的服务累加显存/内存/磁盘增量
  local need_vram_mb="$HW_GPU_VRAM_MARGIN_MB"
  local need_mem_gb="$HW_BASE_MEM_GB"
  local need_disk_gb="$HW_BASE_DISK_GB"
  local gpu_services=0

  if [ "$WITH_INDEXTTS" -eq 1 ]; then
    gpu_services=1
    need_vram_mb=$((need_vram_mb + HW_VRAM_INDEXTTS_MB))
    need_mem_gb=$((need_mem_gb + HW_MEM_INDEXTTS_GB))
    need_disk_gb=$((need_disk_gb + HW_DISK_INDEXTTS_GB))
  fi
  if [ "$WITH_WHISPER" -eq 1 ]; then
    gpu_services=1
    need_vram_mb=$((need_vram_mb + HW_VRAM_WHISPER_MB))
    need_mem_gb=$((need_mem_gb + HW_MEM_WHISPER_GB))
    need_disk_gb=$((need_disk_gb + HW_DISK_WHISPER_GB))
  fi
  if [ "$WITH_HEYGEM" -eq 1 ]; then
    gpu_services=1
    need_vram_mb=$((need_vram_mb + HW_VRAM_HEYGEM_MB))
    need_mem_gb=$((need_mem_gb + HW_MEM_HEYGEM_GB))
    need_disk_gb=$((need_disk_gb + HW_DISK_HEYGEM_GB))
  fi
  if [ "$WITH_SCENEDETECT" -eq 1 ]; then
    need_mem_gb=$((need_mem_gb + HW_MEM_SCENEDETECT_GB))
    need_disk_gb=$((need_disk_gb + HW_DISK_SCENEDETECT_GB))
  fi

  # 显存取「启用服务实测之和 + 余量」与硬门槛（20GB）中的较大者
  if [ "$need_vram_mb" -lt "$HW_MIN_GPU_VRAM_MB" ]; then
    need_vram_mb="$HW_MIN_GPU_VRAM_MB"
  fi

  # ---- CPU ----
  local cpu_cores
  cpu_cores="$(detect_cpu_cores)"
  if [ "${cpu_cores:-0}" -le 0 ]; then
    warn "无法探测 CPU 核数，跳过该项检查"
  elif [ "$cpu_cores" -lt "$HW_MIN_CPU_CORES" ]; then
    err "CPU 核数不足：${cpu_cores} < ${HW_MIN_CPU_CORES}（CLUSTER_WORKERS='auto' 取 核数-2）"
    failed=1
  else
    ok "CPU：${cpu_cores} 核（最低 ${HW_MIN_CPU_CORES}）"
  fi

  # ---- 内存 ----
  local mem_gb
  mem_gb="$(detect_mem_gb)"
  if [ "${mem_gb:-0}" -le 0 ]; then
    warn "无法探测内存，跳过该项检查"
  elif [ "$mem_gb" -lt "$need_mem_gb" ]; then
    err "内存不足：${mem_gb}GB < 最低 ${need_mem_gb}GB"
    hint "阈值 = 基础 ${HW_BASE_MEM_GB}GB + 已启用服务的增量；可用 --no-* 减少服务或覆盖 HW_BASE_MEM_GB"
    failed=1
  else
    ok "内存：${mem_gb}GB（最低 ${need_mem_gb}GB）"
  fi

  # ---- 磁盘（权重/venv 落在部署目录所在分区）----
  local root_free
  root_free="$(detect_disk_free_gb "$ROOT_DIR")"; root_free="${root_free:-0}"
  if [ "$root_free" -lt "$need_disk_gb" ]; then
    err "磁盘空间不足：${ROOT_DIR} 所在分区可用 ${root_free}GB < 最低 ${need_disk_gb}GB"
    hint "权重与 venv 占大头；可清理镜像与构建缓存：docker system prune -af"
    failed=1
  else
    ok "磁盘：${ROOT_DIR} 可用 ${root_free}GB（最低 ${need_disk_gb}GB）"
  fi

  # Docker 数据根可能独立分区，镜像层写在这里，单独提示
  local docker_root docker_free
  docker_root="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)"
  if [ -n "$docker_root" ]; then
    docker_free="$(detect_disk_free_gb "$docker_root")"; docker_free="${docker_free:-0}"
    if [ "$docker_free" -lt 20 ]; then
      warn "Docker 数据根 ${docker_root} 可用仅 ${docker_free}GB，拉取 duix 镜像（约 15GB）可能失败"
    else
      info "Docker 数据根 ${docker_root} 可用 ${docker_free}GB"
    fi
  fi

  # ---- GPU（只在本次要启动 GPU 服务时作硬性要求）----
  local gpu_required="$gpu_services"
  [ "$COMMAND" = "app" ] && gpu_required=0   # app 命令不启动 GPU 服务，缺卡只提示
  if [ "$gpu_services" -eq 0 ]; then
    info "未启用任何 GPU 服务，跳过显存检查"
  elif ! command -v nvidia-smi >/dev/null 2>&1; then
    if [ "$gpu_required" -eq 1 ]; then
      err "未检测到 nvidia-smi：已启用 GPU 服务（indextts/whisper/heygem），但宿主机无 NVIDIA 驱动"
      failed=1
    else
      warn "未检测到 nvidia-smi（app 容器声明了 nvidia 运行时，/system/resources 的 gpu 会为空）"
    fi
  else
    local gpu_count max_vram
    gpu_count="$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | grep -c . || true)"
    max_vram="$(detect_gpu_vram_mb)"; max_vram="${max_vram:-0}"
    if [ "$max_vram" -lt "$need_vram_mb" ]; then
      err "GPU 显存不足：单卡最大 ${max_vram}MiB < 最低要求 ${need_vram_mb}MiB"
      hint "显存门槛 ${HW_MIN_GPU_VRAM_MB}MiB（约 20GB，本方案按单卡 20GB 设计）；确需下调可设 HW_MIN_GPU_VRAM_MB"
      failed=1
    else
      ok "GPU：${gpu_count:-?} 张，单卡最大 ${max_vram}MiB（最低 ${need_vram_mb}MiB）"
    fi
  fi

  [ "$failed" -eq 0 ] || die "硬件要求不满足，中止部署"
  ok "硬件要求满足"
}

# =====================================================================
# 前置检查
# =====================================================================
preflight() {
  step "前置检查"
  local failed=0

  # ---- Docker ----
  if ! command -v docker >/dev/null 2>&1; then
    err "未安装 docker"
    failed=1
  elif ! docker info >/dev/null 2>&1; then
    err "docker 守护进程不可用（当前用户是否有权限？可试 'sudo usermod -aG docker \$USER'）"
    failed=1
  else
    ok "docker 可用：$(docker --version)"
    detect_compose
    ok "compose 可用：$("${COMPOSE[@]}" version --short 2>/dev/null || "${COMPOSE[@]}" version | head -n1)"
  fi
  [ "$failed" -eq 0 ] || die "Docker 环境不可用，中止"

  # ---- 硬件要求（CPU / 内存 / 磁盘 / GPU）----
  check_hardware

  # ---- NVIDIA ----
  if nvidia-smi -L >/dev/null 2>&1; then
    ok "NVIDIA 驱动可用：$(nvidia-smi -L | head -n1)"
  else
    warn "宿主机未检测到 nvidia-smi：GPU 服务无法启动，/system/resources 的 gpu 也会为空"
  fi
  if docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q '"nvidia"'; then
    ok "docker 已注册 nvidia 运行时"
  else
    warn "docker 未注册 nvidia 运行时（需安装并配置 nvidia-container-toolkit）"
    hint "验证：docker run --rm --gpus all nvidia/cuda:12.8.1-base-ubuntu24.04 nvidia-smi"
  fi

  # ---- 根目录 .env.production ----
  if [ -f "$ROOT_DIR/.env.production" ]; then
    ok "找到 .env.production"
    local server_url
    server_url="$(env_value "$ROOT_DIR/.env.production" SERVER_URL || true)"
    [ -n "$server_url" ] && hint "SERVER_URL = $server_url"
  else
    err "缺少 .env.production（app 镜像依赖它提供数据库/Redis/密钥等配置）"
    failed=1
  fi

  # ---- RSA 私钥（登录/注册必需）----
  if [ -f "$ROOT_DIR/keys/rsa_private.pem" ]; then
    ok "找到 RSA 私钥 keys/rsa_private.pem"
  else
    warn "缺少 keys/rsa_private.pem：登录/注册会返回「服务端密码解密密钥不可用」"
    hint "放置方式见 README 第 1 步；必须与前端 hip-front/src/constant/crypto.ts 的公钥成对"
  fi

  # ---- 运行期目录 ----
  local dir
  for dir in keys uploads logs services/heygem/data; do
    mkdir -p "$ROOT_DIR/$dir"
  done
  ok "运行期目录就绪（keys / uploads / logs / services/heygem/data）"

  # ---- GPU 服务的引擎与权重 ----
  if [ "$WITH_INDEXTTS" -eq 1 ]; then
    if [ -d "$INDEXTTS_DIR/engine/.venv" ] && [ -d "$INDEXTTS_DIR/engine/checkpoints" ]; then
      ok "IndexTTS 引擎与权重就绪（约 22GB）"
    else
      warn "IndexTTS 引擎不完整：需要 services/indextts/engine/{.venv,checkpoints}"
      hint "安装方式见 services/indextts/README.md「权重与引擎」"
    fi
  fi
  if [ "$WITH_WHISPER" -eq 1 ]; then
    if [ -d "$WHISPER_DIR/engine/.venv" ]; then
      ok "Whisper 宿主 venv 就绪"
    else
      warn "缺少 services/whisper/engine/.venv"
      hint "安装方式见 services/whisper/README.md「宿主验证」"
    fi
  fi

  # ---- HOST_ROOT / UV_PYTHON_DIR（GPU compose 按这两个变量挂载宿主路径）----
  if [ "$ROOT_DIR" = "/home/hip/桌面/work/general_server" ]; then
    ok "HOST_ROOT 与 compose 默认值一致"
  else
    info "HOST_ROOT 将导出为：$ROOT_DIR（覆盖 compose 里的作者本机默认路径）"
  fi
  hint "UV_PYTHON_DIR = $UV_PYTHON_DIR（uv 安装的 Python 运行时，venv 符号链接依赖它）"

  # ---- duix 共享卷 ----
  if [ "$WITH_HEYGEM" -eq 1 ]; then
    if docker volume inspect wxbot-heygem-data >/dev/null 2>&1; then
      ok "共享卷 wxbot-heygem-data 已存在"
    else
      info "共享卷 wxbot-heygem-data 将在首次启动 duix 时创建"
    fi
  fi

  [ "$failed" -eq 0 ] || die "前置检查未通过"
  ok "前置检查通过"
}

# =====================================================================
# 密钥与 .env 准备
# =====================================================================
prepare_env() {
  step "准备服务密钥"

  ensure_service_env "$INDEXTTS_DIR" "INDEXTTS_API_TOKEN"
  ensure_service_env "$WHISPER_DIR" "WHISPER_API_TOKEN"
  ensure_service_env "$SCENEDETECT_DIR" "SCENEDETECT_API_TOKEN"
}

# 用 .env.example 初始化服务 .env，并把根 .env.production 里的同名 token 同步过去，
# 避免「Node 与 GPU 服务 token 不一致 → 接口一律 401」这类高频故障。
ensure_service_env() {
  local dir="$1" key="$2" example="$1/.env.example" target="$1/.env"

  if [ ! -f "$example" ]; then
    warn "$dir 缺少 .env.example，跳过（请手工创建 .env 并设置 $key）"
    return 0
  fi
  if [ ! -f "$target" ]; then
    cp "$example" "$target"
    info "已从 .env.example 创建 $(basename "$dir")/.env"
  fi

  local root_token svc_token
  root_token="$(env_value "$ROOT_DIR/.env.production" "$key" || true)"
  svc_token="$(env_value "$target" "$key" || true)"

  if [ -z "$root_token" ]; then
    if [ -n "$svc_token" ] && [ "$svc_token" != "change-me-please" ]; then
      warn ".env.production 未设置 $key，将沿用服务端已有值（请确认 Node 侧也能读到同一个值）"
    else
      warn ".env.production 与服务 .env 都没有可用的 $key，请手工设置后再执行部署"
    fi
  elif [ "$root_token" != "$svc_token" ]; then
    set_env_value "$target" "$key" "$root_token"
    ok "已把 .env.production 的 $key 同步到 $(basename "$dir")/.env"
  else
    ok "$(basename "$dir")/.env 的 $key 与 .env.production 一致"
  fi

  chmod 600 "$target" 2>/dev/null || true
}

# =====================================================================
# 共享网络
# =====================================================================
ensure_network() {
  step "确保共享网络 wxbot-gpu"
  if docker network inspect wxbot-gpu >/dev/null 2>&1; then
    ok "网络 wxbot-gpu 已存在"
  else
    docker network create wxbot-gpu >/dev/null
    ok "已创建网络 wxbot-gpu"
  fi
}

# =====================================================================
# GPU 服务
# =====================================================================
# 在子 shell 中按目录执行 compose，并把 HOST_ROOT / UV_PYTHON_DIR 传给 compose
# （两个 GPU compose 全篇用它们做挂载路径，必须覆盖作者本机默认值）。
# 注意变量在调用点展开，不能做成顶层数组 —— 那时 main() 还没设置 UV_PYTHON_DIR。
gpu_compose() {
  local dir="$1"; shift
  ( cd "$dir" && env "HOST_ROOT=$ROOT_DIR" "UV_PYTHON_DIR=${UV_PYTHON_DIR:-}" "${COMPOSE[@]}" "$@" )
}

start_gpu_service() {
  local name="$1" dir="$2" mode="$3"; shift 3   # mode: build | pull
  step "启动 GPU 服务：$name"
  local up_args=(up -d)
  [ "$FORCE_RECREATE" -eq 1 ] && up_args+=(--force-recreate)
  [ "$mode" = "build" ] && up_args+=(--build)
  gpu_compose "$dir" "${up_args[@]}"
  ok "$name 已启动（首次冷启动加载模型需要时间）"
}

start_gpu_services() {
  if [ "$WITH_INDEXTTS" -eq 1 ]; then
    start_gpu_service "IndexTTS（音色克隆）" "$INDEXTTS_DIR" build
  else
    info "已按 --no-indextts 跳过 IndexTTS"
  fi

  if [ "$WITH_WHISPER" -eq 1 ]; then
    start_gpu_service "Whisper（字幕识别）" "$WHISPER_DIR" build
  else
    info "已按 --no-whisper 跳过 Whisper"
  fi

  if [ "$WITH_HEYGEM" -eq 1 ]; then
    start_gpu_service "duix/HeyGem（数字人对口型，镜像约 15GB）" "$HEYGEM_DIR" pull
  else
    info "已按 --no-heygem 跳过 duix"
  fi

  if [ "$WITH_SCENEDETECT" -eq 1 ]; then
    start_gpu_service "scenedetect（场景切分，纯 CPU）" "$SCENEDETECT_DIR" build
  else
    info "已按 --no-scenedetect 跳过 scenedetect"
  fi

  if [ "$WAIT_READY" -eq 1 ]; then
    step "等待服务就绪"
    [ "$WITH_INDEXTTS" -eq 1 ] && \
      wait_http "IndexTTS" "http://127.0.0.1:${INDEXTTS_PORT}/readyz" "$WAIT_TIMEOUT" || true
    [ "$WITH_WHISPER" -eq 1 ] && \
      wait_http "Whisper" "http://127.0.0.1:${WHISPER_PORT}/readyz" "$WAIT_TIMEOUT" || true
    [ "$WITH_HEYGEM" -eq 1 ] && \
      wait_http "duix" "http://127.0.0.1:${HEYGEM_PORT}/easy/query?code=health_probe" "$WAIT_TIMEOUT" || true
    [ "$WITH_SCENEDETECT" -eq 1 ] && \
      wait_http "scenedetect" "http://127.0.0.1:${SCENEDETECT_PORT}/healthz" "$WAIT_TIMEOUT" || true
    info "就绪探针返回 503 属正常（模型加载中）；也可稍后执行 ./deploy.sh verify 复查"
  else
    info "已按 --no-wait 跳过就绪等待"
  fi
}

# =====================================================================
# app
# =====================================================================
start_app() {
  step "部署 app（hip-server）"
  if [ "$BUILD_APP" -eq 1 ]; then
    info "构建镜像（多阶段：pnpm install → vite build → 运行阶段仅生产依赖）"
    "${COMPOSE[@]}" -f "$APP_PROJECT_DIR/docker-compose.yml" build
  else
    info "已按 --no-build 跳过构建"
  fi

  local up_args=(up -d)
  [ "$FORCE_RECREATE" -eq 1 ] && up_args+=(--force-recreate)
  "${COMPOSE[@]}" -f "$APP_PROJECT_DIR/docker-compose.yml" "${up_args[@]}"
  ok "app 已启动"

  if [ "$WAIT_READY" -eq 1 ]; then
    step "等待 app 健康检查通过"
    local deadline=$((SECONDS + 180)) status=""
    printf '    hip-server'
    while [ "$SECONDS" -lt "$deadline" ]; do
      status="$(container_health hip-server)"
      case "$status" in
        healthy) printf ' %s\n' "${C_GREEN}healthy${C_RESET}"; break ;;
        unhealthy) printf ' %s\n' "${C_RED}unhealthy${C_RESET}"; break ;;
      esac
      printf '.'
      sleep 3
    done
    case "$status" in
      healthy) : ;;
      unhealthy) warn "容器不健康，用 './deploy.sh logs app' 查看日志" ;;
      *) printf ' %s\n' "${C_YELLOW}仍在启动${C_RESET}" ;;
    esac
  fi
}

stop_all() {
  step "停止全部服务"
  "${COMPOSE[@]}" -f "$APP_PROJECT_DIR/docker-compose.yml" down --remove-orphans || warn "app 停止失败"
  gpu_compose "$INDEXTTS_DIR" down || warn "indextts 停止失败"
  gpu_compose "$WHISPER_DIR" down || warn "whisper 停止失败"
  gpu_compose "$HEYGEM_DIR" down || warn "duix 停止失败"
  gpu_compose "$SCENEDETECT_DIR" down || warn "scenedetect 停止失败"
  ok "已停止（数据卷、网络、镜像均保留）"
}

# =====================================================================
# 校验与状态
# =====================================================================
verify() {
  step "健康校验"

  local name health
  for name in hip-server indextts-server whisper-server duix-avatar-gen-video scenedetect-server; do
    if docker inspect "$name" >/dev/null 2>&1; then
      health="$(container_health "$name")"
      if [ "$health" = "healthy" ] || [ "$health" = "running" ]; then
        ok "$name：$health"
      else
        warn "$name：$health"
      fi
    else
      info "$name：未运行"
    fi
  done

  step "接口探测"
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${APP_PORT}/" 2>/dev/null || true)"
  if [ -n "$code" ] && [ "$code" != "000" ]; then
    ok "app HTTP 响应正常（GET / → $code，无 / 路由返回 404 即为正常）"
  else
    warn "app HTTP 无响应（http://127.0.0.1:${APP_PORT}/）"
  fi

  local pair label url
  for pair in \
    "IndexTTS|http://127.0.0.1:${INDEXTTS_PORT}/readyz" \
    "Whisper|http://127.0.0.1:${WHISPER_PORT}/readyz" \
    "duix|http://127.0.0.1:${HEYGEM_PORT}/easy/query?code=health_probe" \
    "scenedetect|http://127.0.0.1:${SCENEDETECT_PORT}/healthz"; do
    label="${pair%%|*}"; url="${pair#*|}"
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$url" 2>/dev/null || true)"
    case "$code" in
      2*|3*) ok "$label 就绪（$code）" ;;
      503)   info "$label 模型加载中（503）" ;;
      *)     warn "$label 不可达或异常（${code:-无响应}）" ;;
    esac
  done

  step "提示"
  hint "引擎接线状态（需 JWT）："
  hint "  GET /hip/api/voiceTrainV2/engine/status"
  hint "  GET /hip/api/subtitles/engine/status"
  hint "  GET /hip/api/digitalHuman/engine/status"
  hint "  GET /hip/api/videoPipelineV2/engine/status"
  hint "  GET /hip/api/system/resources（gpu 字段非空说明 nvidia 运行时注入成功）"
}

show_status() {
  step "容器状态"
  docker ps -a --filter "name=hip-server" --filter "name=indextts-server" \
    --filter "name=whisper-server" --filter "name=duix-avatar-gen-video" \
    --filter "name=scenedetect-server" \
    --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
  log ""
  step "共享资源"
  docker network inspect wxbot-gpu --format '网络 wxbot-gpu：{{.Name}}（{{len .Containers}} 个容器）' 2>/dev/null || warn "网络 wxbot-gpu 不存在"
  docker volume ls --filter "name=wxbot-heygem-data" --format '卷：{{.Name}}' | grep . || warn "卷 wxbot-heygem-data 不存在"
}

show_logs() {
  local target="${1:-app}"
  case "$target" in
    app|hip-server)      exec "${COMPOSE[@]}" -f "$APP_PROJECT_DIR/docker-compose.yml" logs -f --tail=200 ;;
    indextts)            exec gpu_compose "$INDEXTTS_DIR" logs -f --tail=200 ;;
    whisper)             exec gpu_compose "$WHISPER_DIR" logs -f --tail=200 ;;
    heygem|duix)         exec gpu_compose "$HEYGEM_DIR" logs -f --tail=200 ;;
    scenedetect)         exec gpu_compose "$SCENEDETECT_DIR" logs -f --tail=200 ;;
    *) die "未知服务：$target（可选 app | indextts | whisper | heygem | scenedetect）" ;;
  esac
}

# =====================================================================
# 主流程
# =====================================================================
summary() {
  local server_url
  server_url="$(env_value "$ROOT_DIR/.env.production" SERVER_URL || true)"
  step "部署完成"
  log "  应用入口      http://127.0.0.1:${APP_PORT}/hip        （路由前缀 /hip）"
  log "  对外域名      ${server_url:-未配置 SERVER_URL}"
  log "  用户认证      POST http://127.0.0.1:${APP_PORT}/hip/auth/login"
  log "  MCP 端点      http://127.0.0.1:${APP_PORT}/hip/mcp"
  log ""
  log "  IndexTTS      http://127.0.0.1:${INDEXTTS_PORT}   容器 indextts-server:8000"
  log "  Whisper       http://127.0.0.1:${WHISPER_PORT}   容器 whisper-server:8000"
  log "  duix/HeyGem   http://127.0.0.1:${HEYGEM_PORT}   容器 duix-avatar-gen-video:8383"
  log "  scenedetect   http://127.0.0.1:${SCENEDETECT_PORT}   容器 scenedetect-server:8000（场景切分，CPU）"
  log ""
  hint "微信签名回调需公网可达：GET  {前缀}/hip/wx"
  hint "讯飞训练回调需公网可达：ALL  {前缀}/hip/api/voiceTrain/trainsCallback"
  hint "后续：./deploy.sh verify | status | logs app | down"
}

main() {
  # uv 安装的 Python 运行时：GPU 服务的 venv 符号链接依赖它，compose 会按同路径挂进容器
  if [ -z "${UV_PYTHON_DIR:-}" ]; then
    if command -v uv >/dev/null 2>&1 && uv python dir >/dev/null 2>&1; then
      UV_PYTHON_DIR="$(uv python dir)"
    else
      UV_PYTHON_DIR="$HOME/.local/share/uv/python"
    fi
  fi
  export HOST_ROOT="$ROOT_DIR"
  export UV_PYTHON_DIR

  case "$COMMAND" in
    preflight)
      detect_compose; preflight ;;
    verify)
      detect_compose; verify ;;
    status)
      detect_compose; show_status ;;
    logs)
      detect_compose; show_logs "${POSITIONAL[@]:-}" ;;
    down)
      detect_compose; stop_all ;;
    restart)
      detect_compose; preflight; stop_all; ensure_network; prepare_env
      start_gpu_services; start_app; verify; summary ;;
    gpu)
      detect_compose; preflight; prepare_env; ensure_network
      start_gpu_services; verify; summary ;;
    app)
      detect_compose; preflight; start_app; verify; summary ;;
    up)
      detect_compose; preflight; prepare_env; ensure_network
      start_gpu_services; start_app; verify; summary ;;
    *)
      die "未知命令：$COMMAND" ;;
  esac
}

main "$@"
