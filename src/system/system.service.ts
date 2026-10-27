import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Logger } from '../../utils/index.ts';
import type { System } from '../../type/index.d.ts';
import { sleep } from '../../utils/sleep.ts';
import { getVersion } from '../../utils/system/getVersion.ts';
import { SystemConstants } from '../../utils/constant/SystemConstants.ts';

const execFileAsync = promisify(execFile);

/** 保留两位小数 */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** PowerShell 磁盘行的解析形态（内部私有类型，不对外） */
interface WindowsDiskRow {
  DeviceID: string;
  FileSystem?: string;
  Size?: number;
  FreeSpace?: number;
}

class SystemService {

  async getCloudVersion(){
    const cloudVersion = SystemConstants.VERSION
    return cloudVersion
  }
  async getVersion(){
    const local_version = SystemConstants.VERSION
    const remote_version =await getVersion()
    return {local_version,remote_version}
  }

  /** 系统资源总览：CPU 采样 sleep 与磁盘/GPU 子进程并行，缩短响应耗时 */
  async getResources(): Promise<System.Resources> {
    const [cpu, disk, gpu] = await Promise.all([
      this.getCpuInfo(),
      this.getDiskInfo(),
      this.getGpuInfo(),
    ]);
    return {
      cpu,
      memory: this.getMemoryInfo(),
      disk,
      gpu,
      process: this.getProcessInfo(),
    };
  }

  /** 实时 CPU 使用率：采样两次 os.cpus()（间隔 ~150ms）求增量 */
  private async getCpuInfo(): Promise<System.Cpu> {
    const before = this.sampleCpuTimes();
    await sleep(150);
    const after = this.sampleCpuTimes();

    let idleDelta = 0;
    let totalDelta = 0;
    for (let i = 0; i < after.length; i++) {
      idleDelta += after[i]!.idle - before[i]!.idle;
      totalDelta += after[i]!.total - before[i]!.total;
    }
    return {
      usagePercent: totalDelta > 0 ? round2(100 * (1 - idleDelta / totalDelta)) : 0,
      // cores: os.cpus().length,
      // model: os.cpus()[0]?.model ?? 'unknown',
    };
  }

  /** 采样各核 CPU 时间（idle 含 irq，total 含全部状态） */
  private sampleCpuTimes(): { idle: number; total: number }[] {
    return os.cpus().map((cpu) => ({
      idle: cpu.times.idle + cpu.times.irq,
      total: cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq,
    }));
  }



  private getMemoryInfo(): System.Memory {
    const total = os.totalmem();
    const free = os.freemem();
    const used = total - free;
    return {
      total,
      used,
      free,
      percent: total > 0 ? round2((used / total) * 100) : 0,
    };
  }

  /** 磁盘全部分区；命令失败时降级返回空数组（监控端点不应因磁盘整体 500） */
  private async getDiskInfo(): Promise<System.Disk[]> {
    try {
      return process.platform === 'win32' ? await this.getWindowsDisk() : await this.getLinuxDisk();
    } catch (err) {
      Logger.getInstance().warn(`[system] disk info unavailable: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /** Linux: df -kP 输出 POSIX 单行格式，解析全部挂载点（含 Docker overlay） */
  private async getLinuxDisk(): Promise<System.Disk[]> {
    const { stdout } = await execFileAsync('df', ['-kP'], { timeout: 5000 });
    return this.parseLinuxDf(stdout);
  }

  private parseLinuxDf(stdout: string): System.Disk[] {
    const disks: System.Disk[] = [];
    // 列：Filesystem / 1024-blocks / Used / Available / Capacity% / Mounted on
    const rowPattern = /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)$/;
    for (const line of stdout.split('\n')) {
      if (line.startsWith('Filesystem')) continue;
      const m = line.match(rowPattern);
      if (!m) continue;
      // 容器/多挂载点下 df 会列出大量重复或无关的文件系统（tmpfs/shm/宿主机设备等）；
      // 只保留 Docker overlay 挂载，避免出现多份相同磁盘信息
      if (m[1] !== 'overlay') continue;
      const total = Number(m[2]) * 1024;
      const used = Number(m[3]) * 1024;
      const free = Number(m[4]) * 1024;
      disks.push({
        name: m[1]!,
        mount: m[6]!,
        fsType: undefined,
        total,
        used,
        free,
        usagePercent: total > 0 ? round2((used / total) * 100) : 0,
      });
    }
    return disks;
  }

  /** Windows: PowerShell 枚举本地固定磁盘（DriveType=3），输出 JSON */
  private async getWindowsDisk(): Promise<System.Disk[]> {
    const script =
      'Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ' +
      "Select-Object DeviceID,FileSystem,@{N='Size';E={$_.Size}},@{N='FreeSpace';E={$_.FreeSpace}} | " +
      'ConvertTo-Json -Compress';
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 8000 }
    );
    const parsed = JSON.parse(stdout.trim()) as WindowsDiskRow | WindowsDiskRow[];
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows
      .filter((row) => row.Size != null && row.FreeSpace != null)
      .map((row) => {
        const total = Number(row.Size);
        const free = Number(row.FreeSpace);
        const used = total - free;
        return {
          name: row.DeviceID,
          mount: `${row.DeviceID}\\`,
          fsType: row.FileSystem,
          total,
          used,
          free,
          usagePercent: total > 0 ? round2((used / total) * 100) : 0,
        };
      });
  }

  /** GPU 信息（NVIDIA nvidia-smi）；命令缺失/失败时降级返回空数组（监控端点不应整体 500） */
  private async getGpuInfo(): Promise<System.Gpu[]> {
    try {
      const { stdout } = await execFileAsync(
        'nvidia-smi',
        [
          '--query-gpu=name,utilization.gpu,memory.total,memory.used,temperature.gpu',
          '--format=csv,noheader,nounits',
        ],
        { timeout: 3000 },
      );
      return this.parseNvidiaSmi(stdout);
    } catch (err) {
      Logger.getInstance().warn(
        `[system] GPU info unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /** 解析 nvidia-smi csv,noheader,nounits 输出为 Gpu[]；nvidia-smi 显存单位 MiB，转字节与 Memory/Disk 单位统一 */
  private parseNvidiaSmi(stdout: string): System.Gpu[] {
    const gpus: System.Gpu[] = [];
    for (const raw of stdout.trim().split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const [name, usageStr, totalStr, usedStr, tempStr] = line.split(',').map((s) => s.trim());
      const total = Number(totalStr);
      if (!name || !Number.isFinite(total) || total <= 0) continue; // 跳过脏行
      const used = Number.isFinite(Number(usedStr)) ? Math.max(Number(usedStr), 0) : 0;
      gpus.push({
        name,
        utilizationPercent: round2(Number.isFinite(Number(usageStr)) ? Math.max(Number(usageStr), 0) : 0),
        temperature: Number.isFinite(Number(tempStr)) ? Math.max(Number(tempStr), 0) : 0,
        memory: {
          total: Math.round(total * 1024 * 1024), // MiB → byte
          used: Math.round(used * 1024 * 1024),
          percent: round2((used / total) * 100),
        },
      });
    }
    return gpus;
  }

  private getProcessInfo(): Partial<System.Process> {
    const mem = process.memoryUsage();
    return {
      // nodeVersion: process.version,
      platform: process.platform,
      // arch: process.arch,
      // hostname: os.hostname(),
      // pid: process.pid,
      // systemUptime: os.uptime(),
      // uptime: process.uptime(),
      // Windows 下 os.loadavg() 恒为 [0,0,0]，语义仅在 Linux 有效
      // loadAverage: os.loadavg(),
      memory: { rss: mem.rss, heapTotal: mem.heapTotal, heapUsed: mem.heapUsed, external: mem.external },
      // cwd: process.cwd(),
    };
  }
}

export const systemService = new SystemService();
