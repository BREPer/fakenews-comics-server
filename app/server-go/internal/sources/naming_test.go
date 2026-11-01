package sources

import "testing"

func TestParseName(t *testing.T) {
	cases := []struct {
		in    string
		title string
		vol   int
	}{
		{"海贼王", "海贼王", 0},
		{"海贼王.cbz", "海贼王", 0},
		{"[SubGroup] 海贼王 (Digital)", "海贼王 ( )", 0}, // TS 同款：digital 剥成空格后剩空括号，与 TS 行为一致
		{"海贼王 第03卷", "海贼王 第03卷", 3}, // 卷号只提取不删除（TS 行为）
		{"海贼王 v2", "海贼王 v2", 2},
		{"海贼王_扫描版", "海贼王 扫描版", 0},
	}
	for _, c := range cases {
		got := ParseName(c.in)
		if got.Title != c.title || got.Volume != c.vol {
			t.Errorf("ParseName(%q) = {%q, %d}, want {%q, %d}", c.in, got.Title, got.Volume, c.title, c.vol)
		}
	}
}

func TestGuessAuthor(t *testing.T) {
	if got := GuessAuthor("海贼王 (尾田荣一郎)"); got != "尾田荣一郎" {
		t.Errorf("GuessAuthor = %q, want 尾田荣一郎", got)
	}
	if got := GuessAuthor("海贼王"); got != "" {
		t.Errorf("GuessAuthor = %q, want empty", got)
	}
}
