package routes

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"fakenews-comics/internal/env"
)

// browseTestEnv 起一个 ComicRoot 指向临时目录的 env，注册路由后返回测试 server。
//
//	 root/
//	   日漫/
//	     海贼王/          （直接含 1 张图 → leafHint=true）
//	   美漫/              （空目录 → leafHint=false）
//	   私藏/              （.开头 → SkipDirName，不列）
func browseTestEnv(t *testing.T) (*httptest.Server, string) {
	t.Helper()
	root := t.TempDir()
	for _, d := range []string{"日漫/海贼王", "美漫", ".私藏"} {
		if err := os.MkdirAll(filepath.Join(root, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "日漫/海贼王/001.jpg"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	Register(mux, env.Env{ComicRoot: root})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv, root
}

type browseResp struct {
	Code int `json:"code"`
	Data struct {
		Path     string `json:"path"`
		Root     string `json:"root"`
		LeafHint bool   `json:"leafHint"`
		Items    []struct {
			Name     string `json:"name"`
			Path     string `json:"path"`
			LeafHint bool   `json:"leafHint"`
		} `json:"items"`
	} `json:"data"`
}

func browse(t *testing.T, srv *httptest.Server, q string) (*browseResp, int) {
	t.Helper()
	url := srv.URL + "/api/libraries/browse"
	if q != "" {
		url += "?path=" + q
	}
	resp, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out browseResp
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return &out, resp.StatusCode
}

// TestBrowseListsSubDirsSkippingHidden 从根浏览：只列子目录、跳过隐藏项、leafHint 对齐扫描器语义。
func TestBrowseListsSubDirsSkippingHidden(t *testing.T) {
	srv, root := browseTestEnv(t)
	out, code := browse(t, srv, "")
	if code != http.StatusOK || out.Code != 0 {
		t.Fatalf("应成功，got http=%d code=%d", code, out.Code)
	}
	if out.Data.Path != filepath.ToSlash(root) {
		t.Fatalf("path 应回显根目录，got %q", out.Data.Path)
	}
	names := map[string]bool{}
	for _, it := range out.Data.Items {
		names[it.Name] = true
		if it.Name == "私藏" || it.Name == ".私藏" {
			t.Errorf("隐藏目录不应列出: %q", it.Name)
		}
	}
	if !names["日漫"] || !names["美漫"] {
		t.Fatalf("应列出 日漫/美漫，got %v", names)
	}
	for _, it := range out.Data.Items {
		// leafHint 是「该目录**直接**含图/压缩包」：日漫 的图在 海贼王 里，
		// 所以 日漫=false；嵌套情形的提示在 TestBrowseNestedPath 里覆盖。
		want := false
		if it.LeafHint != want {
			t.Errorf("%s leafHint 应为 %v，got %v", it.Name, want, it.LeafHint)
		}
	}
}

// TestBrowseNestedPath 相对/嵌套路径按根内解析，并回显实际目录。
func TestBrowseNestedPath(t *testing.T) {
	srv, root := browseTestEnv(t)
	out, code := browse(t, srv, "日漫")
	if code != http.StatusOK || out.Code != 0 {
		t.Fatalf("相对路径应成功，got http=%d code=%d", code, out.Code)
	}
	if out.Data.Path != filepath.ToSlash(root)+"/日漫" {
		t.Fatalf("path 应解析到根内子目录，got %q", out.Data.Path)
	}
	// 海贼王 直接含图 → leafHint=true
	if len(out.Data.Items) != 1 || out.Data.Items[0].Name != "海贼王" || !out.Data.Items[0].LeafHint {
		t.Fatalf("应只列海贼王且 leafHint=true，got %+v", out.Data.Items)
	}
}

// TestBrowseRejectsPathEscape ".." 与根外绝对路径必须拒绝——browse 是无登录门禁内
// 的目录读取接口，路径校验是它的安全边界。
func TestBrowseRejectsPathEscape(t *testing.T) {
	srv, _ := browseTestEnv(t)
	for _, q := range []string{
		"..",
		"../..",
		"%2e%2e%2f%2e%2e", // URL 编码的 ../..（Query 已解码）
		"/etc",
		"C:/Windows",
	} {
		_, code := browse(t, srv, q)
		if code != http.StatusNotFound {
			t.Errorf("path=%q 应被拒绝（404），got http=%d", q, code)
		}
	}
}

// TestBrowseMissingDirReturns404 不存在的路径 → 404 + 可读 message（fnOS 未授权场景的提示载体）。
func TestBrowseMissingDirReturns404(t *testing.T) {
	srv, _ := browseTestEnv(t)
	out, code := browse(t, srv, "不存在的目录")
	if code != http.StatusNotFound || out.Code == 0 {
		t.Fatalf("应 404，got http=%d code=%d", code, out.Code)
	}
}
