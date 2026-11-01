module fakenews-comics

go 1.26.0

require (
	github.com/nwaples/rardecode/v2 v2.4.0
	golang.org/x/image v0.47.0
	golang.org/x/text v0.43.0
	modernc.org/sqlite v1.61.0
)

require (
	github.com/jolestar/go-commons-pool/v2 v2.1.2 // indirect
	github.com/tetratelabs/wazero v1.12.0 // indirect
)

require (
	github.com/dustin/go-humanize v1.1.0 // indirect
	github.com/google/uuid v1.6.0 // indirect
	github.com/klippa-app/go-pdfium v1.21.4
	github.com/mattn/go-isatty v0.0.24 // indirect
	github.com/ncruces/go-strftime v1.1.0 // indirect
	github.com/remyoudompheng/bigfft v0.0.0-20230129092748-24d4a6f8daec // indirect
	golang.org/x/sys v0.49.0 // indirect
	modernc.org/libc v1.79.0 // indirect
	modernc.org/mathutil v1.7.1 // indirect
	modernc.org/memory v1.12.1 // indirect
)

replace github.com/klippa-app/go-pdfium => ./third_party/go-pdfium

// rar/cbr 解码（用户提供的模块，GitHub 直连被墙，vendor 在 third_party/）
replace github.com/nwaples/rardecode/v2 => ./third_party/rardecode
