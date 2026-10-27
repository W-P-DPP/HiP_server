"""作业模型与注册表。

不引入 Redis/Mongo：本服务是单实例、进程内串行（GPU 并发恒为 1），作业状态存内存即可。
落一份 JSONL 的唯一目的是让**容器重启后**仍能回答清楚「你那个任务怎么了」——
重启前在跑的任务会被标成 `interrupted`，比直接 404 更可诊断。
"""

from __future__ import annotations

import json
import threading
import time
import uuid
from contextvars import ContextVar
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path

#: 当前正在执行的作业 id。
#:
#: 由消费者在 `asyncio.to_thread(run_job, ...)` 前置位 —— asyncio 会在调用时复制
#: context，因此 torch 工作线程里 `emit()` 触发的进度回调能取到正确的 job id。
current_job: ContextVar[str | None] = ContextVar("indextts_current_job", default=None)


class JobState(str, Enum):
    queued = "queued"
    running = "running"
    succeeded = "succeeded"
    failed = "failed"
    #: 容器重启导致中断 —— 与 failed 区分，便于排查
    interrupted = "interrupted"
    cancelled = "cancelled"


TERMINAL_STATES = frozenset(
    {JobState.succeeded, JobState.failed, JobState.interrupted, JobState.cancelled}
)


@dataclass
class Job:
    id: str
    client_job_id: str
    text: str
    speed: str
    reference_path: Path
    output_path: Path
    state: JobState = JobState.queued
    progress: float = 0.0
    stage: str = "config"
    seg_cur: int | None = None
    seg_total: int | None = None
    audio_sec: float | None = None
    error: str | None = None
    trace: str | None = None
    queued_at: float = field(default_factory=time.time)
    started_at: float | None = None
    finished_at: float | None = None
    result_bytes: int | None = None
    result_sha256: str | None = None

    @staticmethod
    def new_id() -> str:
        return uuid.uuid4().hex

    @property
    def is_terminal(self) -> bool:
        return self.state in TERMINAL_STATES

    def update_progress(
        self,
        pct: float,
        stage: str,
        *,
        seg: tuple[int, int] | None = None,
        audio_sec: float | None = None,
    ) -> None:
        """记录进度。

        stage 永远更新（阶段标签要准），但 pct 只增不减 —— 推理内部的分段重试会让
        进度回调乱序抵达，回退的进度条比停滞的进度条更让人困惑。
        """
        if stage:
            self.stage = stage
        if pct is not None and pct >= self.progress:
            self.progress = float(pct)
        if seg and seg[1]:
            self.seg_cur, self.seg_total = seg[0], seg[1]
        if audio_sec is not None:
            self.audio_sec = audio_sec

    def snapshot(self, *, expose_trace: bool = False) -> dict:
        data: dict = {
            "job_id": self.id,
            "client_job_id": self.client_job_id,
            "state": self.state.value,
            "progress": round(self.progress, 4),
            "stage": self.stage,
            "segCur": self.seg_cur,
            "segTotal": self.seg_total,
            "audioSec": self.audio_sec,
            "queued_at": self.queued_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "wait_ms": int(((self.started_at or self.finished_at or time.time()) - self.queued_at) * 1000),
            "run_ms": int(((self.finished_at or time.time()) - self.started_at) * 1000) if self.started_at else None,
        }
        if self.error:
            data["error"] = self.error
        if expose_trace and self.trace:
            data["trace"] = self.trace
        if self.state is JobState.succeeded:
            data["result"] = {"bytes": self.result_bytes, "sha256": self.result_sha256}
        return data

    def to_record(self) -> dict:
        """落盘用（比 snapshot 多了内部字段），供重启后恢复。"""
        return {
            "job_id": self.id,
            "client_job_id": self.client_job_id,
            "state": self.state.value,
            "output_path": str(self.output_path),
            "queued_at": self.queued_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "progress": self.progress,
            "stage": self.stage,
            "result_bytes": self.result_bytes,
            "result_sha256": self.result_sha256,
            "error": self.error,
        }


class JobRegistry:
    """进程内作业表 + 一份用于重启后解释中断的 JSONL。"""

    def __init__(self, registry_file: Path) -> None:
        self._lock = threading.Lock()
        self._jobs: dict[str, Job] = {}
        self._by_client: dict[str, str] = {}
        self._file = registry_file
        self._loaded = False

    # ---- 基本操作 ----

    def add(self, job: Job) -> None:
        with self._lock:
            self._jobs[job.id] = job
            if job.client_job_id:
                self._by_client[job.client_job_id] = job.id

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self._jobs.get(job_id)

    def find_by_client(self, client_job_id: str) -> Job | None:
        if not client_job_id:
            return None
        with self._lock:
            job_id = self._by_client.get(client_job_id)
            return self._jobs.get(job_id) if job_id else None

    def all_jobs(self) -> list[Job]:
        with self._lock:
            return list(self._jobs.values())

    def counts(self) -> dict[str, int]:
        with self._lock:
            stats = {"queued": 0, "running": 0, "succeeded": 0, "failed": 0, "interrupted": 0, "cancelled": 0}
            for job in self._jobs.values():
                stats[job.state.value] = stats.get(job.state.value, 0) + 1
            return stats

    # ---- 持久化 ----

    def persist(self, job: Job) -> None:
        """追加一行。失败只影响可诊断性，绝不影响任务本身。"""
        try:
            self._file.parent.mkdir(parents=True, exist_ok=True)
            with self._file.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(job.to_record(), ensure_ascii=False) + "\n")
        except Exception:
            pass

    def hydrate(self, ttl_ms: int) -> dict[str, int]:
        """启动时读回 JSONL，把作业恢复到内存。返回 {'restored', 'interrupted'} 计数。

        三条规则：
        1. **同一个 job 取最后一行**。每个作业会落两行（提交时 queued、结束时终态），
           逐行处理会把已成功的作业误判成中断 —— 这是必须避免的谎报。
        2. 最后一行仍是 queued/running ⇒ 上次进程没跑完，登记为 `interrupted`
           （比让客户端干等到超时、或收到 404 都更可诊断）。
        3. 终态作业在 **TTL 内**一并恢复，这样容器重启后客户端仍能查到结果、下载产物，
           幂等键也依然有效。成功的作业若产物已不在，则不恢复（没有意义）。
        读完即截断文件：状态已全部在内存里，下次启动只需知道本次运行新增的作业。
        """
        if self._loaded:
            return {"restored": 0, "interrupted": 0}
        self._loaded = True

        latest: dict[str, dict] = {}
        if self._file.is_file():
            try:
                lines = self._file.read_text(encoding="utf-8").splitlines()
            except Exception:
                lines = []
            for line in lines:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except Exception:
                    continue
                job_id = str(rec.get("job_id") or "")
                if job_id:
                    latest[job_id] = rec

        now = time.time()
        cutoff = now - ttl_ms / 1000.0
        stats = {"restored": 0, "interrupted": 0}

        for job_id, rec in latest.items():
            try:
                queued_at = float(rec.get("queued_at") or now)
                output_path = Path(str(rec.get("output_path") or ""))
                started_at = rec.get("started_at")
                finished_at = rec.get("finished_at")
                state_value = str(rec.get("state") or "")
            except Exception:
                continue

            job = Job(
                id=job_id,
                client_job_id=str(rec.get("client_job_id") or ""),
                text="",
                speed="balanced",
                reference_path=Path(""),
                output_path=output_path,
                queued_at=queued_at,
                started_at=started_at,
                finished_at=finished_at,
                progress=float(rec.get("progress") or 0.0),
                stage=str(rec.get("stage") or "config"),
                result_bytes=rec.get("result_bytes"),
                result_sha256=rec.get("result_sha256"),
            )

            if state_value in (JobState.queued.value, JobState.running.value):
                job.state = JobState.interrupted
                job.error = "推理服务重启，任务中断，请重新提交"
                job.finished_at = now
                self.add(job)
                stats["interrupted"] += 1
                continue

            # 终态：过期的不恢复，成功的还要求产物仍在磁盘上
            if (finished_at or queued_at) < cutoff:
                continue
            if state_value == JobState.succeeded.value and not output_path.is_file():
                continue
            try:
                job.state = JobState(state_value)
            except ValueError:
                continue
            job.error = rec.get("error")
            self.add(job)
            stats["restored"] += 1

        try:
            self._file.write_text("", encoding="utf-8")
        except Exception:
            pass
        return stats

    def purge_expired(self, ttl_ms: int, now: float | None = None) -> int:
        """清掉过期作业记录与磁盘上的产物，防止长期运行后无限增长。"""
        now = now if now is not None else time.time()
        cutoff = now - ttl_ms / 1000.0
        removed = 0
        with self._lock:
            for job_id, job in list(self._jobs.items()):
                if not job.is_terminal:
                    continue
                if (job.finished_at or job.queued_at) > cutoff:
                    continue
                self._jobs.pop(job_id, None)
                if job.client_job_id:
                    self._by_client.pop(job.client_job_id, None)
                removed += 1
                _remove_quietly(job.output_path)
                _remove_quietly(job.reference_path)
        return removed


def _remove_quietly(path: Path) -> None:
    if not path or str(path) in ("", "."):
        return
    try:
        path.unlink(missing_ok=True)
    except Exception:
        pass
