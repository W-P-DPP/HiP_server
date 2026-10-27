# =============================================================
# WxBot general-server 多阶段构建
# 构建阶段：安装依赖 + pnpm build → 运行阶段：仅生产依赖 + dist
# =============================================================



# ---------- 构建阶段 ----------
FROM node:22-alpine AS build

# 使用与 package.json `packageManager` 一致的 pnpm 版本
RUN npm install -g pnpm@10.13.1

WORKDIR /app

# 先复制依赖清单，充分利用 Docker 层缓存
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# 复制源码并构建（Vite SSR 打包，输出 dist/main.cjs）
COPY . .
RUN pnpm build

# ---------- 运行阶段 ----------
FROM node:22-alpine AS runtime

ENV NODE_ENV=production

ENV TZ=Asia/Shanghai
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

WORKDIR /app

RUN npm install -g pnpm@10.13.1

# 生产依赖（vite 已把业务代码打入单文件，node_modules 兜底动态 require 场景）
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# ffmpeg/ffprobe + CJK 字体（视频合成 toVideo / 背景素材管道依赖；Alpine 无 Microsoft YaHei，libass 回退 Noto Sans CJK）
# gcompat/libstdc++：nvidia-container-toolkit 注入的 nvidia-smi 是 glibc + C++ 程序，Alpine(musl)
# 下必须靠 gcompat 提供 ld-linux 兼容层才能执行（否则报 nvidia-smi: not found）。
# 设备与库的注入依赖 docker-compose.yml 给本服务加的 runtime: nvidia + utility 能力。
RUN apk add --no-cache ffmpeg font-noto-cjk gcompat libstdc++

# 构建产物 + 前端静态资源 + 运行环境变量
COPY --from=build /app/dist ./dist
# 前端页面静态资源（app.ts 以 process.cwd()/public 提供 /hip 与 /hip/login）
COPY --from=build /app/public ./public
COPY .env.production ./.env.production

# 容器内静态文件服务使用 /app/uploads，Winston 日志写入 /app/logs
RUN mkdir -p uploads logs

EXPOSE 40010

# 启动时自动加载 /app/.env.production
CMD ["node", "dist/main.cjs"]
