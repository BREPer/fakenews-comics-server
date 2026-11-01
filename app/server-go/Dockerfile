# 肥牛漫画服务端镜像（Go 版）
#
# 不装运行时、不装原生依赖、不联网。
# 二进制由打包机交叉编译（CGO_ENABLED=0 GOOS=linux），PDFium 以 WASM 内嵌，
# 图像缩放用纯 Go 实现，因此 `FROM scratch` 即可运行：
#   - 镜像构建 = 两次 COPY，1~2 秒完成
#   - 不依赖任何基础镜像源
#   - 镜像体积只等于二进制（约 30MB）
#
# 时区：scratch 无 tzdata 包，二进制已通过 `import _ "time/tzdata"` 内嵌 IANA 库，
# TZ=Asia/Shanghai 正常生效。
#
# 健康检查：scratch 无 shell / curl / wget，用二进制自带的 -healthcheck 参数自检。
FROM scratch

# 预编译二进制（由 build.ps1 / make 交叉编译产出，见 bin/）
COPY bin/fakenews-comics-server-linux-amd64 /fakenews-comics-server
# 前端静态产物（fpk 预构建，位于 build context 根）
COPY web-dist /app/web-dist

ENV APP_PORT=3000 \
    DATA_DIR=/data \
    COMIC_ROOT=/comics \
    WEB_DIST=/app/web-dist \
    TZ=Asia/Shanghai

EXPOSE 3000

# start-period 给首屏扫描留时间；服务本身启动是毫秒级
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["/fakenews-comics-server", "-healthcheck"]

ENTRYPOINT ["/fakenews-comics-server"]
