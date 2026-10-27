"""独立 Whisper ASR 服务（FastAPI + uvicorn）。

设计要点（与 `services/indextts/http/server.py` 同构）：

- **只做一件事**：音频字节 → SRT 文本。任务表、文件落库、归属校验全部留在 Node 业务侧。
- **无状态**：不挂载业务目录，唯一持久化的是自管 state 卷（上传音频 + SRT 产物 + job 注册表）。
- **GPU 并发恒为 1**：进程内 `asyncio.Queue` + 单消费者（一份热模型）。
- **`--workers` 必须为 1**：多进程会各加载一份模型并各自维护队列。

推理跑在 `asyncio.to_thread` 里，事件循环始终能响应 `/readyz` —— 否则加载模型的数十秒里
服务会被 healthcheck 与客户端误判为死掉。

契约以 `services/whisper/README.md` 为准，字段名不可随意改动：Node 侧
`utils/whisper/WhisperHttpClient.ts` 直接依赖 `POST /api/v1/jobs` 的 `job_id`、
`GET /api/v1/jobs/{id}` 的 `state/progress/stage/error`，以及 `/readyz` 的 200/503 语义。
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import sys
import time
import traceback
from contextlib import asynccontextmanager
from pathlib import Path

# uvicorn --app-dir 会把本目录放进 sys.path，但引擎在上一级，需要显式补上。
BRIDGE_DIR = Path(__file__).resolve().parent.parent
if str(BRIDGE_DIR) not in sys.path:
    sys.path.insert(0, str(BRIDGE_DIR))

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Request, UploadFile  # noqa: E402
from fastapi.responses import JSONResponse, PlainTextResponse  # noqa: E402

from whisper_engine import MIN_AUDIO_BYTES, load_model, readiness_report, transcribe_to_srt  # noqa: E402

from jobs import Job, JobRegistry, JobState, current_job  # noqa: E402
from settings import Settings  # noqa: E402

logging.basicConfig(
    level=logging.INFO,
    stream=sys.stdout,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("whisper.http")

#: 进度区间：模型加载 0.05→0.30，转写 0.30→0.99，落盘 1.0
_TRANSCRIBE_BASE = 0.30
_TRANSCRIBE_SPAN = 0.69


def _sha256_file(path: Path) -> str | None:
    try:
        digest = hashlib.sha256()
        with path.open("rb") as fh:
            for chunk in iter(lambda: fh.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()
    except Exception:
        return None


def _gpu_info() -> dict | None:
    """显存占用。失败一律返回 None —— 状态接口不该因为取不到 GPU 信息而挂掉。

    刻意走 `pynvml` 而**不是** `torch`：本服务的推理栈（faster-whisper / CTranslate2）不需要
    torch，为了一个状态字段把 2.5GB 的 torch 装进 venv 并不值得。
    """
    try:
        import pynvml

        pynvml.nvmlInit()
        try:
            handle = pynvml.nvmlDeviceGetHandleByIndex(0)
            name = pynvml.nvmlDeviceGetName(handle)
            if isinstance(name, bytes):
                name = name.decode("utf-8", "replace")
            mem = pynvml.nvmlDeviceGetMemoryInfo(handle)
            mib = 1024 * 1024
            return {
                "name": name,
                "mem_total_mib": int(mem.total // mib),
                "mem_used_mib": int(mem.used // mib),
            }
        finally:
            pynvml.nvmlShutdown()
    except Exception:
        return None


class AppState:
    """服务运行态：模型、队列、作业表、当前进度。"""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.cfg = settings.engine_config()
        self.queue: asyncio.Queue[str] = asyncio.Queue(maxsize=settings.max_queue)
        self.registry = JobRegistry(settings.registry_file)

        self.model = None
        self.model_ready = False
        self.model_error: str | None = None
        self.loading = False
        self.load_count = 0
        self.load_ms: int | None = None
        self.loaded_at: float | None = None

        self.stage: str | None = None
        self.pct: float = 0.0
        self.current_job_id: str | None = None

        self.stopping = False
        self.started_at = time.time()
        self.submitted = 0
        self._load_lock = asyncio.Lock()

    # ---- 进度（由引擎在工作线程里回调） ----

    def on_marker(self, pct: float, stage: str) -> None:
        """只做简单赋值 + 内存态更新，不碰事件循环 —— 可能跑在 torch 工作线程里。"""
        if stage == "whisper_transcribe":
            pct = _TRANSCRIBE_BASE + max(0.0, min(1.0, float(pct))) * _TRANSCRIBE_SPAN
        self.pct = float(pct)
        self.stage = stage
        job_id = current_job.get()
        if not job_id:
            return
        job = self.registry.get(job_id)
        if job is not None and not job.is_terminal:
            job.update_progress(pct, stage)

    # ---- 模型加载 ----

    async def load_model(self) -> None:
        """幂等加载；并发调用会等在途加载完成，不会重复加载。"""
        if self.model_ready:
            return
        async with self._load_lock:
            if self.model_ready:
                return
            await self._do_load()

    async def _do_load(self) -> None:
        self.loading = True
        self.model_error = None
        started = time.time()
        try:
            self.on_marker(0.05, "whisper_load")
            log.info(
                "loading Whisper model=%s device=%s compute=%s download_root=%s",
                self.settings.model,
                self.settings.device,
                self.settings.compute_type,
                self.settings.models_dir,
            )
            self.model = await asyncio.to_thread(load_model, self.cfg, self.on_marker)
            self.load_count += 1
            self.model_ready = True
            self.loaded_at = time.time()
            self.load_ms = int((self.loaded_at - started) * 1000)
            log.info("model ready in %.1fs (load_count=%d)", self.load_ms / 1000.0, self.load_count)
            if self.load_count > 1:
                log.warning(
                    "model loaded %d times in one process — check that uvicorn runs with --workers 1",
                    self.load_count,
                )
        except BaseException as exc:
            self.model_error = f"{exc}"
            log.error("model load failed: %s\n%s", exc, traceback.format_exc())
            raise
        finally:
            self.loading = False

    async def warmup(self) -> None:
        try:
            await self.load_model()
        except Exception:
            # 失败原因已记录在 self.model_error，由 /readyz 与 /status 暴露
            pass

    # ---- 后台任务 ----

    async def consumer(self) -> None:
        """单消费者 —— GPU 并发恒为 1。"""
        while True:
            job_id = await self.queue.get()
            try:
                job = self.registry.get(job_id)
                if job is None or job.state is not JobState.queued:
                    continue  # 排队期间被取消
                await self._execute(job)
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("consumer error job_id=%s", job_id)
            finally:
                self.queue.task_done()

    async def _execute(self, job: Job) -> None:
        try:
            if not self.model_ready:
                # 冷启动：把加载进度挂到这个 job 上，UI 才能显示「加载模型」而不是干等
                token = current_job.set(job.id)
                try:
                    job.update_progress(0.05, "whisper_load")
                    await self.load_model()
                finally:
                    current_job.reset(token)

            job.state = JobState.running
            job.started_at = time.time()
            self.current_job_id = job.id
            job.update_progress(_TRANSCRIBE_BASE, "whisper_transcribe")
            log.info(
                "job start job_id=%s client_job_id=%s language=%s",
                job.id,
                job.client_job_id,
                job.language or "auto",
            )

            token = current_job.set(job.id)
            try:
                srt, stats = await asyncio.to_thread(
                    transcribe_to_srt,
                    self.model,
                    job.audio_path,
                    language=job.language,
                    beam_size=self.settings.beam_size,
                    vad_filter=self.settings.vad_filter,
                    max_chars=self.settings.max_chars,
                    on_progress=self.on_marker,
                )
            finally:
                current_job.reset(token)
                self.current_job_id = None

            if not srt.strip() or not stats.get("cue_count"):
                raise RuntimeError("未识别到有效字幕，请确认音频包含清晰人声")

            job.srt_path.write_text(srt, encoding="utf-8")
            job.duration_sec = stats.get("duration_sec")
            job.cue_count = int(stats.get("cue_count") or 0)
            job.srt_bytes = job.srt_path.stat().st_size
            job.srt_sha256 = _sha256_file(job.srt_path)
            job.state = JobState.succeeded
            job.update_progress(1.0, "whisper_done")
            log.info(
                "job done job_id=%s cues=%s audio_sec=%s run_ms=%d",
                job.id,
                job.cue_count,
                job.duration_sec,
                int((time.time() - (job.started_at or time.time())) * 1000),
            )
        except Exception as exc:
            job.state = JobState.failed
            job.error = str(exc) or exc.__class__.__name__
            job.trace = traceback.format_exc()
            log.error("job failed job_id=%s client_job_id=%s: %s\n%s", job.id, job.client_job_id, exc, job.trace)
            self.current_job_id = None
        finally:
            if job.finished_at is None:
                job.finished_at = time.time()
            self.registry.persist(job)
            # 上传音频留到 job 过期，方便按 job_id 复现问题

    async def janitor(self) -> None:
        """定期清理过期作业记录与产物，避免长期运行后磁盘无界增长。"""
        while True:
            await asyncio.sleep(60)
            try:
                removed = self.registry.purge_expired(self.settings.result_ttl_ms)
                if removed:
                    log.info("purged %d expired job(s)", removed)
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("janitor error")

    # ---- 停机 ----

    def mark_queued_interrupted(self) -> int:
        count = 0
        for job in self.registry.all_jobs():
            if job.state is JobState.queued:
                job.state = JobState.interrupted
                job.error = "推理服务停机，任务未执行，请重新提交"
                job.finished_at = time.time()
                self.registry.persist(job)
                count += 1
        return count

    def ready_snapshot(self) -> dict:
        return {
            "state": "ready" if self.model_ready else ("loading" if self.loading else "not_ready"),
            "loading": self.loading,
            "stage": self.stage,
            "pct": round(self.pct, 4),
            "queue": self.queue.qsize(),
            "error": self.model_error,
        }


# --------------------------------------------------------------------------
# FastAPI 应用
# --------------------------------------------------------------------------


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = Settings.from_env()
    settings.ensure_dirs()

    state = AppState(settings)
    app.state.engine = state

    restored = state.registry.hydrate(settings.result_ttl_ms)
    if restored["interrupted"] or restored["restored"]:
        log.info(
            "registry restored: %d job(s) from previous run, %d marked interrupted",
            restored["restored"],
            restored["interrupted"],
        )
    if not settings.api_token:
        log.warning("WHISPER_API_TOKEN is empty — API is unauthenticated; keep the port on loopback/intranet only")

    # 权重状态：allow_download=false 时缺失会在首次加载时给出可读清单，这里先记一笔便于排障
    log.info("weights: %s", readiness_report(state.cfg))

    tasks = [
        asyncio.create_task(state.consumer(), name="consumer"),
        asyncio.create_task(state.janitor(), name="janitor"),
    ]
    if settings.eager_load:
        tasks.append(asyncio.create_task(state.warmup(), name="warmup"))

    log.info(
        "whisper service up (state=%s fingerprint=%s eager_load=%s)",
        settings.state_dir,
        settings.fingerprint(),
        settings.eager_load,
    )
    try:
        yield
    finally:
        state.stopping = True
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        pending = state.mark_queued_interrupted()
        if pending:
            log.warning("marked %d queued job(s) interrupted on shutdown", pending)
        log.info("whisper service down")


app = FastAPI(title="Whisper ASR Service", version="1.0.0", lifespan=lifespan)


def engine_of(request: Request) -> AppState:
    return request.app.state.engine


def require_token(request: Request, authorization: str | None = Header(default=None)) -> None:
    token = engine_of(request).settings.api_token
    if not token:
        return
    if authorization != f"Bearer {token}":
        raise HTTPException(status_code=401, detail="invalid or missing bearer token")


Auth = Depends(require_token)


@app.get("/healthz")
async def healthz() -> dict:
    """存活探针：恒 200，不碰 GPU、不等锁。"""
    return {"status": "ok"}


@app.get("/readyz")
async def readyz(request: Request):
    """就绪探针：模型加载完成前返回 503，供 compose healthcheck 与 Node 侧 ready() 使用。"""
    state = engine_of(request)
    snapshot = state.ready_snapshot()
    code = 200 if state.model_ready and not state.stopping else 503
    return JSONResponse(status_code=code, content=snapshot)


@app.get("/api/v1/status", dependencies=[Auth])
async def status(request: Request) -> dict:
    state = engine_of(request)
    current = state.registry.get(state.current_job_id) if state.current_job_id else None
    gpu = await asyncio.to_thread(_gpu_info)
    return {
        "ready": state.model_ready,
        "loading": state.loading,
        "model": state.settings.model,
        "device": state.settings.device,
        "compute_type": state.settings.compute_type,
        "load_count": state.load_count,
        "loaded_at": state.loaded_at,
        "load_ms": state.load_ms,
        "model_error": state.model_error,
        "stage": state.stage,
        "pct": round(state.pct, 4),
        "gpu": gpu,
        "queue": {
            "depth": state.queue.qsize(),
            "max": state.settings.max_queue,
            "submitted": state.submitted,
            **state.registry.counts(),
        },
        "current": current.snapshot() if current else None,
        "weight_check": readiness_report(state.cfg),
        "config_fingerprint": state.settings.fingerprint(),
        "uptime_ms": int((time.time() - state.started_at) * 1000),
        "version": app.version,
    }


@app.post("/api/v1/jobs", status_code=202, dependencies=[Auth])
async def submit_job(
    request: Request,
    audio: UploadFile = File(..., description="待转写音频（wav/mp3/m4a/…；扩展名影响解码，须带真实后缀）"),
    language: str = Form("", description="语种，如 zh/en；auto 或留空则自动检测"),
    client_job_id: str = Form("", description="调用方的幂等键，Node 侧传 Mongo taskId"),
) -> dict:
    state = engine_of(request)
    settings = state.settings

    if state.stopping:
        raise HTTPException(status_code=503, detail="service is shutting down")

    # 幂等：同一个 client_job_id 重投不应重复消耗 GPU。
    #
    # 刻意**不过滤终态**：真正要挡的场景是「Node 提交成功但响应丢失（超时/断连）」——
    # 重试时原任务往往已跑完，若因「已终态」而放行新建，就正好造成重复识别。
    # clientJobId 是 Mongo taskId，一条任务只该被识别一次。注册表按 result_ttl_ms 清理，
    # 因此「能查到」≈「未过期」。
    client_job_id = (client_job_id or "").strip()
    existing = state.registry.find_by_client(client_job_id)
    if existing is not None:
        log.info(
            "job deduplicated job_id=%s client_job_id=%s state=%s",
            existing.id,
            client_job_id,
            existing.state.value,
        )
        return {
            "job_id": existing.id,
            "client_job_id": existing.client_job_id,
            "state": existing.state.value,
            "deduplicated": True,
        }

    max_bytes = settings.max_upload_mb * 1024 * 1024
    data = await audio.read(max_bytes + 1)
    if len(data) > max_bytes:
        raise HTTPException(status_code=413, detail=f"音频超过 {settings.max_upload_mb}MB 上限")
    if len(data) < MIN_AUDIO_BYTES:
        raise HTTPException(status_code=400, detail=f"音频为空或过小（<{MIN_AUDIO_BYTES} 字节）")

    if state.queue.qsize() >= settings.max_queue:
        raise HTTPException(status_code=429, detail="队列已满，请稍后重试")

    # 保留上传文件的后缀：faster-whisper 依赖它（经由 ffmpeg）选择解码器
    suffix = Path(audio.filename or "").suffix or ".audio"
    job_id = Job.new_id()
    job = Job(
        id=job_id,
        client_job_id=client_job_id,
        audio_path=settings.refs_dir / f"{job_id}{suffix}",
        srt_path=settings.out_dir / f"{job_id}.srt",
        language=settings.resolve_language(language),
    )
    job.audio_path.write_bytes(data)

    state.registry.add(job)
    state.submitted += 1
    state.registry.persist(job)

    try:
        state.queue.put_nowait(job.id)
    except asyncio.QueueFull:
        # 理论上不会发生（前面已按 qsize 预检），构造竞态时兜底
        job.state = JobState.cancelled
        job.error = "队列已满"
        raise HTTPException(status_code=429, detail="队列已满，请稍后重试") from None

    log.info(
        "job accepted job_id=%s client_job_id=%s language=%s bytes=%d queue=%d",
        job.id,
        job.client_job_id,
        job.language or "auto",
        len(data),
        state.queue.qsize(),
    )
    return {
        "job_id": job.id,
        "client_job_id": job.client_job_id,
        "state": job.state.value,
        "queue_position": state.queue.qsize(),
        "accepted_at": job.queued_at,
    }


@app.get("/api/v1/jobs/{job_id}", dependencies=[Auth])
async def get_job(request: Request, job_id: str) -> dict:
    job = engine_of(request).registry.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    return job.snapshot(expose_trace=engine_of(request).settings.expose_trace)


@app.get("/api/v1/jobs/{job_id}/result", dependencies=[Auth])
async def get_job_result(request: Request, job_id: str):
    job = engine_of(request).registry.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    if job.state is not JobState.succeeded:
        raise HTTPException(status_code=409, detail=f"job is {job.state.value}, no result available")
    if not job.srt_path.is_file():
        raise HTTPException(status_code=410, detail="result expired or removed")
    return PlainTextResponse(job.srt_path.read_text(encoding="utf-8"), media_type="text/plain; charset=utf-8")


@app.delete("/api/v1/jobs/{job_id}", dependencies=[Auth])
async def cancel_job(request: Request, job_id: str) -> dict:
    state = engine_of(request)
    job = state.registry.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    if job.state is JobState.running:
        # 推理无法安全打断，拒绝取消而不是假装成功
        raise HTTPException(status_code=409, detail="job is running and cannot be cancelled")
    if job.state is JobState.queued:
        job.state = JobState.cancelled
        job.error = "已取消"
        job.finished_at = time.time()
        state.registry.persist(job)
        log.info("job cancelled job_id=%s", job.id)
    return job.snapshot()


@app.post("/api/v1/admin/warmup", dependencies=[Auth])
async def warmup(request: Request) -> dict:
    """幂等触发模型加载（EAGER_LOAD=false 或加载失败后手动拉起）。"""
    state = engine_of(request)
    if not state.model_ready:
        asyncio.create_task(state.warmup())
    return state.ready_snapshot()
