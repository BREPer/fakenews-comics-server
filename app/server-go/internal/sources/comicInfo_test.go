package sources

import "testing"

func TestXMLTag(t *testing.T) {
	xml := `<ComicInfo><Series>海贼王</Series><Writer>尾田</Writer><Genre>Action, Adventure</Genre></ComicInfo>`
	if got := XMLTag(xml, "Series"); got != "海贼王" {
		t.Errorf("XMLTag Series = %q", got)
	}
	if got := XMLTag(xml, "Writer"); got != "尾田" {
		t.Errorf("XMLTag Writer = %q", got)
	}
	if got := XMLTag(xml, "Missing"); got != "" {
		t.Errorf("XMLTag Missing = %q, want empty", got)
	}
	// 实体解码 + CDATA
	xml2 := `<ComicInfo><Summary>A &amp; B</Summary><Notes><![CDATA[hello world]]></Notes></ComicInfo>`
	if got := XMLTag(xml2, "Summary"); got != "A & B" {
		t.Errorf("实体解码 = %q", got)
	}
	if got := XMLTag(xml2, "Notes"); got != "hello world" {
		t.Errorf("CDATA = %q", got)
	}
}

func TestSplitList(t *testing.T) {
	got := SplitList("Action, Adventure；Drama")
	if len(got) != 3 || got[0] != "Action" || got[2] != "Drama" {
		t.Fatalf("SplitList = %v", got)
	}
	if len(SplitList("")) != 0 {
		t.Error("空串应返回空")
	}
}

func TestParseComicInfo(t *testing.T) {
	xml := `<ComicInfo><Series>海贼王</Series><Title>第03卷</Title><Writer>尾田荣一郎</Writer><Genre>Action</Genre></ComicInfo>`
	meta := ParseComicInfo(xml)
	if meta == nil {
		t.Fatal("解析失败")
	}
	if meta.Title != "海贼王 - 第03卷" {
		t.Errorf("Title = %q, want 海贼王 - 第03卷", meta.Title)
	}
	if meta.Author != "尾田荣一郎" || len(meta.Genre) != 1 || meta.Genre[0] != "Action" {
		t.Errorf("字段不符: %+v", meta)
	}
	if ParseComicInfo("") != nil {
		t.Error("空 xml 应返回 nil")
	}
}
