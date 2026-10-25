package main

import (
	"archive/tar"
	"compress/gzip"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestUSBCollectionPreservesOriginalFilesAndExportsBackup(t *testing.T) {
	root, e := filepath.EvalSymlinks(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	id := strings.Repeat("c", 32)
	nonce := strings.Repeat("d", 32)
	base := collectionRoot(id)
	home := collectionHome(id)
	rule := collectionRule(id)
	version := []byte("N428-FAKE,4.9.77,4.46.23836,x,y,000000000390")
	put(t, root, "/mnt/onboard/.kobo/version", version)
	put(t, root, "/mnt/onboard/keep.epub", []byte("KEEP BOOK"))
	put(t, root, "/etc/original.conf", []byte("KEEP SETTINGS"))
	put(t, root, "/etc/udev/rules.d/original.rules", []byte("ORIGINAL RULE"))
	os.Symlink("original.conf", root+"/etc/link.conf")
	pub, key, _ := ed25519.GenerateKey(rand.Reader)
	keys, _ := json.Marshal(map[string]string{"test": base64.StdEncoding.EncodeToString(pub)})
	put(t, root, base+"/release-keys.json", keys)
	put(t, root, base+"/bootstrap.sh", []byte("fixture"))
	put(t, root, rule, []byte("collector rule"))
	files := map[string]string{}
	for _, p := range []string{base + "/release-keys.json", base + "/bootstrap.sh", rule} {
		b, _ := os.ReadFile(root + p)
		files[p] = digest(b)
	}
	payload, _ := json.Marshal(CollectionDescriptor{Purpose: "collect-preflight", ID: id, Files: files})
	env := Envelope{KeyID: "test", Payload: base64.StdEncoding.EncodeToString(payload), Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(key, payload))}
	b, _ := json.Marshal(env)
	put(t, root, base+"/release.json", b)
	request, _ := json.Marshal(CollectionRequest{ID: nonce, Identity: digest(version)})
	put(t, root, home+"/request.json", request)
	old := collectionPlatform
	collectionPlatform = func() (string, string, error) { return "armv7l", "4.9.77", nil }
	t.Cleanup(func() { collectionPlatform = old })
	if e = collect(root, id); e != nil {
		t.Fatal(e)
	}
	if _, e = os.Lstat(root + rule); !os.IsNotExist(e) {
		t.Fatal("collector rule retained")
	}
	for p, want := range map[string]string{"/etc/original.conf": "KEEP SETTINGS", "/mnt/onboard/keep.epub": "KEEP BOOK", "/etc/udev/rules.d/original.rules": "ORIGINAL RULE"} {
		b, _ = os.ReadFile(root + p)
		if string(b) != want {
			t.Fatal("original changed", p)
		}
	}
	report := root + home + "/reports/" + nonce
	b, e = os.ReadFile(report + "/report.json")
	if e != nil {
		t.Fatal(e)
	}
	json.Unmarshal(b, &env)
	data, _ := decode(env.Payload)
	sig, _ := decode(env.Signature)
	public, _ := decode(env.KeyID)
	if !ed25519.Verify(public, data, sig) {
		t.Fatal("bad report signature")
	}
	var r CollectionReport
	json.Unmarshal(data, &r)
	if !r.RuleRemoved || r.Identity != digest(version) || len(r.Absent) != 3 {
		t.Fatal("incorrect preflight")
	}
	f, _ := os.Open(report + "/system-before-trial.tar.gz")
	defer f.Close()
	gz, _ := gzip.NewReader(f)
	defer gz.Close()
	archive := tar.NewReader(gz)
	seen := map[string]bool{}
	for {
		h, e := archive.Next()
		if e == io.EOF {
			break
		}
		if e != nil {
			t.Fatal(e)
		}
		seen[h.Name] = true
		if h.Name == "etc/link.conf" && h.Linkname != "original.conf" {
			t.Fatal("link dereferenced")
		}
	}
	if seen[strings.TrimPrefix(rule, "/")] || !seen["etc/original.conf"] || !seen["etc/udev/rules.d/original.rules"] {
		t.Fatal("wrong backup scope")
	}
	if e = collect(root, id); e != nil {
		t.Fatal("completed event repeated", e)
	}
}
