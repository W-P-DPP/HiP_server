import AdmZip from 'adm-zip';

/**
 * 列出 zip 文件中的顶级文件夹名称
 * @param filePath zip 文件的绝对路径
 * @returns 顶级文件夹名数组（去重、不含路径前缀）
 */
export function listZipFolders(filePath: string): string[] {
  try {
    const zip = new AdmZip(filePath);
    const entries = zip.getEntries();

    const folders = new Set<string>();

    for (const entry of entries) {
      if (entry.isDirectory) {
        // entryName 格式如 "src/" 或 "src/components/"
        const name = entry.entryName.replace(/\/+$/, '');
        // 只取顶级目录（不含 '/' 即不在子目录中）
        const slashIdx = name.indexOf('/');
        if (slashIdx === -1) {
          // 根级目录，如 "src"
          folders.add(name);
        } else {
          // 子目录，取顶级部分，如 "src/components" → "src"
          folders.add(name.slice(0, slashIdx));
        }
      }
    }

    return Array.from(folders).sort();
  } catch {
    // zip 文件损坏或无法读取时返回空数组
    return [];
  }
}
