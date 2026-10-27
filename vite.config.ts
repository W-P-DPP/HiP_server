import { defineConfig } from 'vite';
import { builtinModules } from 'module';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkgPath = join(__dirname, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, { encoding: 'utf-8' }));

// 获取所有依赖（包括dependencies和devDependencies）
const allDependencies = {
  ...pkg.dependencies,
  ...pkg.devDependencies,
};

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '#': resolve(__dirname, 'mcp'),
    },
  },
  build: {
    ssr: 'main.ts',
    outDir: 'dist',
    target: 'node18',
    minify:'esbuild',
    rollupOptions: {
      // 只排除Node.js内置模块，其他全部打包
      external: [...builtinModules, 'ws'],
      output: {
        format: 'cjs',
        entryFileNames: '[name].cjs',
        // 确保所有代码内联
        inlineDynamicImports: true,
      },
    },
    // 增加文件大小警告阈值（因为打包所有依赖会变大）
    chunkSizeWarningLimit: 10000,
    // 生成sourcemap便于调试
    // sourcemap: true,
  },
  
  ssr: {
    // 将所有依赖都打包，不排除任何包
    noExternal: true,  // 改为 true，而不是只包含dependencies
    // 或者使用：noExternal: Object.keys(allDependencies),
  },
});