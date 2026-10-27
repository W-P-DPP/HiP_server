"""独立图片理解（Qwen3-VL）服务（FastAPI + uvicorn）。

设计要点（与 `services/whisper/http/server.py` 同构）：

- **只做一件事**：图片字节 → 结构化 JSON（或自由文本）。任务表、文件落库、归属校验全部留在
  Node 业务侧。
- **无状态**：不挂载业务目录，唯一持久化的是自管 state 卷（上传图片 + 结果 JSON + job 注册表）。
- **GPU 并发恒为 1**：进程内 `asyncio.Queue` + 单消费者（一份热模型）。
- **`--workers` 必须为 1**：多进程会各加载一份模型并各自维护队列。

推理跑在 `asyncio.to_thread` 里，事件循环始终能响应 `/readyz` —— 否则加载模型的数十秒里
服务会被 healthcheck 与客户端误判为死掉。

契约以 `services/vlm/README.md` 为准，字段名不可随意改动：Node 侧
`utils/vlm/VlmHttpClient.ts` 直接依赖 `POST /api/v1/jobs` 的 `job_id`、
`GET /api/v1/jobs/{id}` 的 `state/progress/stage/error`，以及 `/readyz` 的 200/503 语义。
"""

from __future__ import annotations

import asyncio
import gc
import json
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
from fastapi.responses import JSONResponse  # noqa: E402

from vlm_engine import (  # noqa: E402
    MIN_IMAGE_BYTES,
    STRICT_REMINDER,
    load_model,
    readiness_report,
    understand,
)

from jobs import Job, JobRegistry, JobState, current_job  # noqa: E402
from settings import Settings  # noqa: E402

logging.basicConfig(
    level=logging.INFO,
    stream=sys.stdout,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("vlm.http")

#: JSON 解析失败时允许的总尝试次数（首次 + 一次追加严格提醒的重试）
MAX_ATTEMPTS = 2

#: 报错时附进 message 的原始输出长度上限（整段塞进 Node 侧的 message 字段会很难看）
_RAW_TEXT_EXCERPT = 300


def _gpu_info() -> dict | None:
    """显存占用。失败一律返回 None —— 状态接口不该因为取不到 GPU 信息而挂掉。"""
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


def _release_cuda_memory() -> None:
    """回收 Python 侧之后，把 CUDA allocator 的缓存块也还回去。

    必须在**丢掉模型引用之后**调用：`torch.cuda.empty_cache()` 只能释放「已无人引用」的
    缓存块，引用还在的话它其实什么也做不了 —— 这正是「代码里 del 了但 nvidia-smi 没掉」的原因。

    非 CUDA 环境（`VLM_DEVICE=cpu`）与 torch 不可用时静默跳过：卸载是为了省显存，
    拿不到显存这件事本身不该让流程失败。
    """
    gc.collect()
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


class AppState:
    """服务运行态：模型、队列、作业表、当前进度。"""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.cfg = settings.engine_config()
        self.queue: asyncio.Queue[str] = asyncio.Queue(maxsize=settings.max_queue)
        self.registry = JobRegistry(settings.registry_file)

        self.engine: dict | None = None
        self.model_ready = False
        self.model_error: str | None = None
        self.loading = False
        self.load_count = 0
        self.load_ms: int | None = None
        self.loaded_at: float | None = None

        #: 模型被空闲卸载的次数。
        #: 与 load_count 配合才能区分两类「加载了不止一次」：多 worker 误配（没有卸载记录的重复加载）
        #: 与正常的「卸载后重载」。
        self.unload_count = 0
        self.last_unload_at: float | None = None
        #: 最近一次「用完」的时间（加载成功时与任务结算时刷新），空闲卸载据此计时
        self.last_used_at: float | None = None
        #: 是否有任务正在处理（从队列取出到结算之间）。空闲卸载的前置条件之一：
        #: 只看 queue.qsize() 会漏掉「刚被取走、还没置 current_job_id」的那个窗口
        self.processing = False

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
        self.pct = max(0.0, min(1.0, float(pct)))
        self.stage = stage
        job_id = current_job.get()
        if not job_id:
            return
        job = self.registry.get(job_id)
        if job is not None and not job.is_terminal:
            job.update_progress(self.pct, stage)

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
            self.on_marker(0.05, "vlm_load")
            log.info(
                "loading Qwen3-VL model=%s device=%s attn=%s 4bit=%s models_dir=%s",
                self.settings.model,
                self.settings.device,
                self.settings.attn,
                self.cfg.get("load_in_4bit"),
                self.settings.models_dir,
            )
            self.engine = await asyncio.to_thread(load_model, self.cfg, self.on_marker)
            self.load_count += 1
            self.model_ready = True
            self.loaded_at = time.time()
            self.last_used_at = self.loaded_at
            self.load_ms = int((self.loaded_at - started) * 1000)
            log.info(
                "model ready in %.1fs (load_count=%d unload_count=%d)",
                self.load_ms / 1000.0,
                self.load_count,
                self.unload_count,
            )
            # 一份热模型在进程内只该被加载一次。空闲卸载会**合法地**推高 load_count，
            # 所以要先减掉卸载次数再看：仍有富余说明同时存在两份模型 —— 典型是多 worker 误配。
            if self.load_count - self.unload_count > 1:
                log.warning(
                    "model loaded %d times with only %d unload(s) in one process — "
                    "check that uvicorn runs with --workers 1",
                    self.load_count,
                    self.unload_count,
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

    # ---- 空闲卸载 ----

    async def unload_model(self, reason: str) -> None:
        """把模型从显存卸下来。

        与 `load_model` 共用同一把锁，因此卸载与加载严格串行，不会出现「边卸边载」。

        释放分三步，缺一不可：丢掉唯一引用（engine）→ `gc` 回收可能的环状引用 →
        清 CUDA allocator 的缓存块。只做第一步的话，张量仍被循环引用或缓存池攥着，
        `nvidia-smi` 上看不到显存回落。
        """
        if not self.model_ready:
            return
        async with self._load_lock:
            if not self.model_ready:
                return
            self.engine = None
            self.model_ready = False
            self.unload_count += 1
            self.last_unload_at = time.time()
            self.stage = "vlm_unloaded"
            self.pct = 0.0
            await asyncio.to_thread(_release_cuda_memory)
            log.info(
                "model unloaded (%s) load_count=%d unload_count=%d",
                reason,
                self.load_count,
                self.unload_count,
            )

    async def idle_unloader(self) -> None:
        """空闲超过 `VLM_IDLE_UNLOAD_MS` 就把模型卸下来。阈值 <= 0 时该循环直接退出。

        三个前置条件同时成立才动手，任一不成立就跳过这一轮：
        ① 模型在位；② 队列为空；③ 没有任务正在处理。

        ②③ 缺一不可 —— 只看 `queue.qsize() == 0` 会漏掉「任务刚被消费者取走、
        还没置 current_job_id」的那一瞬，那样就会把正要用的模型卸掉（虽然 `_execute`
        会立刻重载、结果仍正确，但白等一次冷加载）。
        """
        idle_ms = self.settings.resolve_idle_unload_ms()
        if idle_ms <= 0:
            log.info(
                "idle unload disabled (VLM_IDLE_UNLOAD_MS=%s) — model stays resident until the process exits",
                self.settings.idle_unload_ms,
            )
            return

        idle_sec = idle_ms / 1000.0
        # 轮询粒度：取阈值的 1/4、封顶 30s —— 阈值调很小（如 5s）时也能及时卸载
        tick = max(1.0, min(30.0, idle_sec / 4))
        log.info("idle unload enabled: after %.0fs idle (tick=%.1fs)", idle_sec, tick)

        while True:
            await asyncio.sleep(tick)
            try:
                if not self.model_ready or self.processing or self.queue.qsize() > 0:
                    continue
                if self.last_used_at is None:
                    continue
                if time.time() - self.last_used_at < idle_sec:
                    continue
                await self.unload_model(f"idle > {idle_sec:.0f}s")
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("idle unloader error")

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
        # 立刻置位：空闲卸载器据此判断「有任务在用」。放在最前面（早于模型检查），
        # 才能盖住「刚被消费者取走」到「current_job_id 置位」之间的那段空窗。
        self.processing = True
        try:
            if not self.model_ready:
                # 冷启动：把加载进度挂到这个 job 上，UI 才能显示「加载模型」而不是干等
                token = current_job.set(job.id)
                try:
                    job.update_progress(0.05, "vlm_load")
                    await self.load_model()
                finally:
                    current_job.reset(token)

            assert self.engine is not None  # load_model 成功即非空

            job.state = JobState.running
            job.started_at = time.time()
            self.current_job_id = job.id
            log.info(
                "job start job_id=%s client_job_id=%s mode=%s",
                job.id,
                job.client_job_id,
                job.mode,
            )

            base_prompt = self.settings.resolve_prompt(job.prompt, job.mode)
            job.resolved_prompt = base_prompt
            text = ""
            parsed: dict | None = None
            truncated = False

            for attempt in range(1, MAX_ATTEMPTS + 1):
                job.attempts = attempt
                prompt = base_prompt if attempt == 1 else base_prompt + STRICT_REMINDER
                if attempt > 1:
                    log.warning("retrying with strict reminder job_id=%s", job.id)

                token = current_job.set(job.id)
                try:
                    outcome = await asyncio.to_thread(
                        understand,
                        self.engine,
                        job.image_path,
                        prompt,
                        max_new_tokens=self.settings.max_new_tokens,
                        on_progress=self.on_marker,
                    )
                finally:
                    current_job.reset(token)

                text = str(outcome.get("text") or "")
                parsed = outcome.get("json") if isinstance(outcome.get("json"), dict) else None
                job.elapsed_ms = outcome.get("elapsed_ms")
                truncated = bool(outcome.get("truncated"))

                # text 模式本就不要求 JSON，一次通过
                if job.mode != "json" or parsed is not None:
                    break
                # 被长度上限截断时**重试没有意义**：同样会截在同一处，只是再烧一次 GPU
                # （实测两次都截断）。直接跳出，交给下面的失败分支报「调大上限」。
                if truncated:
                    break

            job.raw_text = text
            job.truncated = truncated

            if job.mode == "json":
                if parsed is None:
                    excerpt = text.strip().replace("\n", " ")[:_RAW_TEXT_EXCERPT]
                    if truncated:
                        # 与「模型不会输出 JSON」分开报：这条是**我们把它切断了**，
                        # 笼统说成解析失败会把排查带偏（实测吃过这个亏）。
                        raise RuntimeError(
                            f"输出被长度上限截断（VLM_MAX_NEW_TOKENS="
                            f"{self.settings.max_new_tokens} token），JSON 因此不完整。"
                            f"请调大 VLM_MAX_NEW_TOKENS，或把对 description 的长度要求改短。"
                            f"原始输出片段：{excerpt or '（空）'}"
                        )
                    raise RuntimeError(
                        f"模型未产出可解析的 JSON（已尝试 {job.attempts} 次）。"
                        f"原始输出片段：{excerpt or '（空）'}"
                    )
                job.parsed = parsed
                job.parse_ok = True
            else:
                if not text.strip():
                    raise RuntimeError("模型未产出任何文本")
                # text 模式同样拦截断：用户要的就是这段文字本身，被切掉一半等于交付物不完整，
                # 静默返回半句话比报错更糟（调用方无从知道它是残缺的）。
                if truncated:
                    raise RuntimeError(
                        f"输出被长度上限截断（VLM_MAX_NEW_TOKENS="
                        f"{self.settings.max_new_tokens} token）。请调大 VLM_MAX_NEW_TOKENS。"
                    )
                job.parsed = None
                job.parse_ok = False

            # 结果落盘：GET /result 直接回这份 JSON
            job.model = self.settings.model
            job.result_path.write_text(
                json.dumps(job.payload(), ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            job.state = JobState.succeeded
            job.update_progress(1.0, "vlm_done")
            log.info(
                "job done job_id=%s mode=%s attempts=%d parse_ok=%s run_ms=%d",
                job.id,
                job.mode,
                job.attempts,
                job.parse_ok,
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
            # 上传图片留到 job 过期，方便按 job_id 复现问题
            # 「用完」的时刻在这里刷新：空闲卸载从此刻开始计时
            self.processing = False
            self.last_used_at = time.time()

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
        log.warning("VLM_API_TOKEN is empty — API is unauthenticated; keep the port on loopback/intranet only")

    # 权重状态：allow_download=false 时缺失会在首次加载时给出可读清单，这里先记一笔便于排障
    log.info("weights: %s", readiness_report(state.cfg))

    tasks = [
        asyncio.create_task(state.consumer(), name="consumer"),
        asyncio.create_task(state.janitor(), name="janitor"),
        # 空闲卸载循环：阈值 <=0 时它自己会立刻退出，故无条件启动
        asyncio.create_task(state.idle_unloader(), name="idle_unloader"),
    ]
    if settings.eager_load:
        tasks.append(asyncio.create_task(state.warmup(), name="warmup"))

    log.info(
        "vlm service up (state=%s fingerprint=%s eager_load=%s idle_unload=%sms)",
        settings.state_dir,
        settings.fingerprint(),
        settings.eager_load,
        settings.resolve_idle_unload_ms(),
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
        log.info("vlm service down")


app = FastAPI(title="Qwen3-VL Image Understanding Service", version="1.0.0", lifespan=lifespan)


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
    engine = state.engine or {}
    return {
        "ready": state.model_ready,
        "loading": state.loading,
        "model": state.settings.model,
        "device": state.settings.device,
        "attn": state.settings.attn,
        "load_in_4bit": state.cfg.get("load_in_4bit"),
        "min_pixels": state.settings.min_pixels,
        "max_pixels": state.settings.max_pixels,
        "max_new_tokens": state.settings.max_new_tokens,
        "load_count": state.load_count,
        "loaded_at": state.loaded_at,
        "load_ms": engine.get("load_ms", state.load_ms),
        "unload_count": state.unload_count,
        "last_unload_at": state.last_unload_at,
        "last_used_at": state.last_used_at,
        "idle_ms": round((time.time() - state.last_used_at) * 1000) if state.last_used_at else None,
        "idle_unload_ms": state.settings.resolve_idle_unload_ms(),
        "processing": state.processing,
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
    image: UploadFile = File(..., description="待理解图片（jpg/png/webp/bmp；须带真实后缀）"),
    prompt: str = Form("", description="自定义指令；留空用服务端默认"),
    mode: str = Form("json", description="输出形态：json（结构化字段）或 text（自由文本）"),
    client_job_id: str = Form("", description="调用方的幂等键，Node 侧传 Mongo taskId"),
) -> dict:
    state = engine_of(request)
    settings = state.settings

    if state.stopping:
        raise HTTPException(status_code=503, detail="service is shutting down")

    # 幂等：同一个 client_job_id 重投不应重复消耗 GPU。
    #
    # 刻意**不过滤终态**：真正要挡的场景是「Node 提交成功但响应丢失（超时/断连）」——
    # 重试时原任务往往已跑完，若因「已终态」而放行新建，就正好造成重复推理。
    # clientJobId 是 Mongo taskId，一条任务只该被理解一次。注册表按 result_ttl_ms 清理，
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
    data = await image.read(max_bytes + 1)
    if len(data) > max_bytes:
        raise HTTPException(status_code=413, detail=f"图片超过 {settings.max_upload_mb}MB 上限")
    if len(data) < MIN_IMAGE_BYTES:
        raise HTTPException(status_code=400, detail=f"图片为空或过小（<{MIN_IMAGE_BYTES} 字节）")

    if state.queue.qsize() >= settings.max_queue:
        raise HTTPException(status_code=429, detail="队列已满，请稍后重试")

    # 保留上传文件的后缀：处理器的图片加载会按扩展名选解码器
    suffix = Path(image.filename or "").suffix or ".img"
    job_id = Job.new_id()
    job = Job(
        id=job_id,
        client_job_id=client_job_id,
        image_path=settings.images_dir / f"{job_id}{suffix}",
        result_path=settings.out_dir / f"{job_id}.json",
        prompt=(prompt or "").strip(),
        mode=settings.resolve_mode(mode),
    )
    job.image_path.write_bytes(data)

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
        "job accepted job_id=%s client_job_id=%s mode=%s bytes=%d queue=%d",
        job.id,
        job.client_job_id,
        job.mode,
        len(data),
        state.queue.qsize(),
    )
    return {
        "job_id": job.id,
        "client_job_id": job.client_job_id,
        "state": job.state.value,
        "mode": job.mode,
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
    if not job.result_path.is_file():
        raise HTTPException(status_code=410, detail="result expired or removed")
    return JSONResponse(content=json.loads(job.result_path.read_text(encoding="utf-8")))


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
