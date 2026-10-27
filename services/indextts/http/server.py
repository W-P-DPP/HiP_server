"""独立 IndexTTS GPU 推理服务（FastAPI + uvicorn）。

设计要点：

- **只做一件事**：文本 + 参考音字节 → wav 字节。Mongo 任务队列、文件落库、试听回写、
  归属校验全部留在 Node 业务侧，本服务不含任何业务逻辑。
- **无状态**：不挂载业务目录，唯一持久化的是自管 state 卷（参考音临时文件 + 产物 +
  job 注册表）。因此可以直接搬到另一台 GPU 机器。
- **GPU 并发恒为 1**：进程内 `asyncio.Queue` + 单消费者。跨 dev/prod 的串行化由此保证，
  「一份热模型同时服务两边」正是靠这里。
- **`--workers` 必须为 1**：多进程会各加载一份模型（7.8GB×N）并各自维护队列。
  `/api/v1/status` 的 `load_count` 就是用来尽早发现这种误配的。

推理跑在 `asyncio.to_thread` 里，事件循环始终能响应 `/readyz` —— 否则加载模型的
1–3 分钟里服务会被 healthcheck 和客户端误判为已经死掉。
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

# uvicorn --app-dir 会把本目录放进 sys.path，但桥接层（indextts_engine / job_runner /
# progress）在上一级，需要显式补上。
BRIDGE_DIR = Path(__file__).resolve().parent.parent
if str(BRIDGE_DIR) not in sys.path:
    sys.path.insert(0, str(BRIDGE_DIR))

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Request, UploadFile  # noqa: E402
from fastapi.responses import FileResponse, JSONResponse  # noqa: E402

from indextts_engine import create_index_tts2, readiness_report  # noqa: E402
from job_runner import MIN_REFERENCE_BYTES, run_job  # noqa: E402
from progress import add_sink, emit  # noqa: E402

from jobs import Job, JobRegistry, JobState, current_job  # noqa: E402
from settings import Settings  # noqa: E402

logging.basicConfig(
    level=logging.INFO,
    stream=sys.stdout,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("indextts.http")

#: 与 indextts_engine.SPEED_PRESETS 的键一致
_SPEED_MODES = ("fast", "balanced", "quality")


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
    """显存占用。失败一律返回 None —— 状态接口不该因为取不到 GPU 信息而挂掉。"""
    try:
        import torch

        if not torch.cuda.is_available():
            return None
        free, total = torch.cuda.mem_get_info()
        mib = 1024 * 1024
        return {
            "name": torch.cuda.get_device_name(0),
            "mem_total_mib": int(total // mib),
            "mem_used_mib": int((total - free) // mib),
        }
    except Exception:
        return None


def _host_probe(cfg: dict) -> tuple[dict | None, dict]:
    """GPU 信息 + 权重完整性。

    两项都是阻塞的（CUDA 驱动调用、十来个文件 stat/glob），因此由调用方放进线程执行 ——
    状态接口不该和推理抢事件循环，否则并发时的 /readyz 会变慢甚至超时。
    """
    try:
        readiness = readiness_report(cfg)
    except Exception as exc:
        readiness = {"error": str(exc)}
    return _gpu_info(), readiness


class AppState:
    """服务运行态：模型、队列、作业表、当前进度。"""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.cfg = settings.engine_config()
        self.queue: asyncio.Queue[str] = asyncio.Queue(maxsize=settings.max_queue)
        self.registry = JobRegistry(settings.registry_file)

        self.tts = None
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

    # ---- 进度汇（由 progress.add_sink 注册） ----

    def on_marker(self, pct: float, stage: str, *, seg=None, audio_sec=None) -> None:
        """可能在 torch 工作线程里被调用 —— 只做简单赋值，不碰事件循环。"""
        self.pct = float(pct)
        self.stage = stage
        job_id = current_job.get()
        if not job_id:
            return
        job = self.registry.get(job_id)
        if job is not None and not job.is_terminal:
            job.update_progress(pct, stage, seg=seg, audio_sec=audio_sec)

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
            emit(0.05, "config")
            emit(0.10, "indextts_load")
            log.info(
                "loading IndexTTS2 (first load may take 1-3 minutes) install=%s model=%s",
                self.settings.install_dir,
                self.settings.model_dir,
            )
            # out_dir 指向可写 state 卷：checkpoints 以只读方式挂载，
            # 生成的 config.agent.yaml 不能写回权重目录。
            self.tts = await asyncio.to_thread(create_index_tts2, self.cfg, self.settings.gen_dir)
            self.load_count += 1
            self.model_ready = True
            self.loaded_at = time.time()
            self.load_ms = int((self.loaded_at - started) * 1000)
            emit(0.14, "indextts_ready")
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
                    job.update_progress(0.10, "indextts_load")
                    await self.load_model()
                finally:
                    current_job.reset(token)

            job.state = JobState.running
            job.started_at = time.time()
            self.current_job_id = job.id
            job.update_progress(0.15, "indextts_synth")
            log.info("job start job_id=%s client_job_id=%s speed=%s", job.id, job.client_job_id, job.speed)

            token = current_job.set(job.id)
            try:
                output = await asyncio.to_thread(
                    run_job,
                    self.tts,
                    self.cfg,
                    text=job.text,
                    output=job.output_path,
                    reference=str(job.reference_path),
                    speed=job.speed,
                )
            finally:
                current_job.reset(token)
                self.current_job_id = None

            job.output_path = Path(output)
            job.result_bytes = job.output_path.stat().st_size
            job.result_sha256 = _sha256_file(job.output_path)
            job.state = JobState.succeeded
            job.update_progress(1.0, "indextts_done")
            log.info(
                "job done job_id=%s bytes=%s run_ms=%d",
                job.id,
                job.result_bytes,
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
            # 参考音留到 job 过期，方便按 job_id 复现问题

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
        log.warning("INDEXTTS_API_TOKEN is empty — API is unauthenticated; keep the port on loopback/intranet only")

    add_sink(state.on_marker)

    tasks = [
        asyncio.create_task(state.consumer(), name="consumer"),
        asyncio.create_task(state.janitor(), name="janitor"),
    ]
    if settings.eager_load:
        tasks.append(asyncio.create_task(state.warmup(), name="warmup"))

    log.info(
        "indextts service up (state=%s fingerprint=%s eager_load=%s)",
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
        log.info("indextts service down")


app = FastAPI(title="IndexTTS GPU Service", version="2.0.0", lifespan=lifespan)


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
    """就绪探针：模型加载完成前返回 503，供 compose healthcheck 与 Node 侧 ensureReady 使用。"""
    state = engine_of(request)
    snapshot = state.ready_snapshot()
    code = 200 if state.model_ready and not state.stopping else 503
    return JSONResponse(status_code=code, content=snapshot)


@app.get("/api/v1/status", dependencies=[Auth])
async def status(request: Request) -> dict:
    state = engine_of(request)
    current = state.registry.get(state.current_job_id) if state.current_job_id else None
    gpu, readiness = await asyncio.to_thread(_host_probe, state.cfg)
    return {
        "ready": state.model_ready,
        "loading": state.loading,
        "model": "IndexTTS2",
        "use_fp16": state.settings.use_fp16,
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
        "weight_check": readiness,
        "config_fingerprint": state.settings.fingerprint(),
        "uptime_ms": int((time.time() - state.started_at) * 1000),
        "version": app.version,
    }


@app.post("/api/v1/jobs", status_code=202, dependencies=[Auth])
async def submit_job(
    request: Request,
    reference: UploadFile = File(..., description="参考音 wav，零样本克隆的音色来源"),
    text: str = Form(""),
    speed: str = Form("balanced"),
    client_job_id: str = Form("", description="调用方的幂等键，Node 侧传 Mongo taskId"),
) -> dict:
    state = engine_of(request)
    settings = state.settings

    if state.stopping:
        raise HTTPException(status_code=503, detail="service is shutting down")

    body = (text or "").strip()
    if not body:
        raise HTTPException(status_code=400, detail="文案为空（text 必填）")
    if len(body) > settings.max_text_chars:
        raise HTTPException(
            status_code=400,
            detail=f"文案过长：{len(body)} 字，上限 {settings.max_text_chars} 字",
        )
    if speed not in _SPEED_MODES:
        raise HTTPException(status_code=400, detail=f"speed 仅支持 {list(_SPEED_MODES)}，收到 {speed!r}")

    # 幂等：同一个 client_job_id 重投不应重复消耗 GPU。
    #
    # 注意这里**不过滤终态**。幂等真正要挡的场景是：Node 提交成功但响应丢失（超时/断连），
    # 重试时原任务往往已经跑完了 —— 若因「已终态」而放行新建，就正好造成了重复推理。
    # clientJobId 是 Mongo taskId，一条任务只会被执行一次，不存在需要再跑一遍的语义。
    # 注册表按 result_ttl_ms 清理过期条目，因此「能查到」≈「未过期」。
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
    data = await reference.read(max_bytes + 1)
    if len(data) > max_bytes:
        raise HTTPException(status_code=413, detail=f"参考音超过 {settings.max_upload_mb}MB 上限")
    if len(data) < MIN_REFERENCE_BYTES:
        raise HTTPException(status_code=400, detail=f"参考音为空或过小（<{MIN_REFERENCE_BYTES} 字节）")
    if not (data[:4] == b"RIFF" and data[8:12] == b"WAVE"):
        raise HTTPException(status_code=400, detail="参考音不是合法的 WAV 文件（缺少 RIFF/WAVE 头）")

    if state.queue.qsize() >= settings.max_queue:
        raise HTTPException(status_code=429, detail="队列已满，请稍后重试")

    job = Job(
        id=Job.new_id(),
        client_job_id=client_job_id,
        text=body,
        speed=speed,
        reference_path=settings.refs_dir / f"{Job.new_id()}.wav",
        output_path=settings.out_dir / f"{Job.new_id()}.wav",
    )
    job.reference_path.write_bytes(data)

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
        "job accepted job_id=%s client_job_id=%s chars=%d speed=%s ref_bytes=%d queue=%d",
        job.id,
        job.client_job_id,
        len(body),
        speed,
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
    state = engine_of(request)
    job = state.registry.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    if job.state is not JobState.succeeded:
        raise HTTPException(status_code=409, detail=f"job is {job.state.value}, no result available")
    if not job.output_path.is_file():
        raise HTTPException(status_code=410, detail="result expired or removed")
    return FileResponse(job.output_path, media_type="audio/wav", filename=f"{job.id}.wav")


@app.delete("/api/v1/jobs/{job_id}", dependencies=[Auth])
async def cancel_job(request: Request, job_id: str) -> dict:
    state = engine_of(request)
    job = state.registry.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    if job.state is JobState.running:
        # CUDA 推理无法安全打断，拒绝取消而不是假装成功
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
