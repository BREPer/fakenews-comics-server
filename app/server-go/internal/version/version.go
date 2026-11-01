// Package version 是应用版本的唯一真源。
// 发版时同步两处：本文件、根目录 manifest 的 version（前端 app/web/package.json 的 version 一并跟上）。
package version

// AppName 应用名。
const AppName = "肥牛漫画"

// AppVersion 语义化版本（x.y.z），需与 fpk manifest 一致。
// 是 var 不是 const：打包脚本用 -ldflags "-X fakenews-comics/internal/version.AppVersion=x.y.z"
// 注入，避免「manifest 改了但二进制里还是旧版本」的错配。
var AppVersion = "2.1.0"
