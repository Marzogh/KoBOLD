package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func put(t *testing.T, root, path string, b []byte) {
	t.Helper()
	if e := os.MkdirAll(filepath.Dir(root+path), 0700); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(root+path, b, 0600); e != nil {
		t.Fatal(e)
	}
}
func fixture(t *testing.T) (string, ed25519.PrivateKey, Descriptor) {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	pub, key, e := ed25519.GenerateKey(rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	keys, _ := json.Marshal(map[string]string{"test": base64.StdEncoding.EncodeToString(pub)})
	put(t, root, system+"/release-keys.json", keys)
	d := Descriptor{Installer: installer, Profile: "libra-colour-390-4.46.23836", Version: "0.1.0", Files: map[string]string{}}
	for _, path := range []string{system + "/provenance", system + "/controller.sh", home + "/releases/0.1.0/bin/tailscaled", "/etc/udev/rules.d/98-kobold-0.1.0.rules"} {
		data := []byte("fixture:" + path)
		put(t, root, path, data)
		d.Files[path] = digest(data)
	}
	put(t, root, "/mnt/onboard/.kobo/version", []byte("N428-FAKE,4.9.77,4.46.23836,x,y,000000000390"))
	signDescriptor(t, root, key, d)
	return root, key, d
}
func signDescriptor(t *testing.T, root string, key ed25519.PrivateKey, d Descriptor) {
	b, _ := json.Marshal(d)
	env := Envelope{KeyID: "test", Payload: base64.StdEncoding.EncodeToString(b), Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(key, b))}
	b, _ = json.Marshal(env)
	put(t, root, system+"/release.json", b)
}
func loadState(t *testing.T, root string) State {
	t.Helper()
	b, e := os.ReadFile(root + statePath)
	if e != nil {
		t.Fatal(e)
	}
	var s State
	if e = json.Unmarshal(b, &s); e != nil {
		t.Fatal(e)
	}
	return s
}
func TestReceiptContinuityAndRecovery(t *testing.T) {
	root, _, _ := fixture(t)
	a := strings.Repeat("a", 32)
	if e := record(root, "inspect", a); e != nil {
		t.Fatal(e)
	}
	s := loadState(t, root)
	if s.Receipt.Status != "prepared" || s.Receipt.Sequence != 1 {
		t.Fatal("incorrect initial state")
	}
	if e := record(root, "startup", a); e == nil {
		t.Fatal("startup before health")
	}
	b, e := os.ReadFile(root + home + "/reports/" + a + "/installation.json")
	if e != nil {
		t.Fatal(e)
	}
	var env Envelope
	json.Unmarshal(b, &env)
	payload, _ := decode(env.Payload)
	pub, _ := decode(env.KeyID)
	sig, _ := decode(env.Signature)
	if !ed25519.Verify(pub, payload, sig) {
		t.Fatal("invalid receipt")
	}
	if e := record(root, "inspect", a); e == nil {
		t.Fatal("replay accepted")
	}
	if e := record(root, "enable", strings.Repeat("b", 32)); e != nil {
		t.Fatal(e)
	}
	next := loadState(t, root)
	if next.Receipt.Previous != s.Digest || next.Receipt.Status != "healthy" || next.Receipt.PublicKey != s.Receipt.PublicKey {
		t.Fatal("lost continuity")
	}
	if e := record(root, "startup", a); e != nil {
		t.Fatal(e)
	}
	if e := record(root, "disable", strings.Repeat("c", 32)); e != nil {
		t.Fatal(e)
	}
	if e := record(root, "startup", a); e == nil {
		t.Fatal("disabled startup")
	}
	os.Remove(root + "/etc/udev/rules.d/98-kobold-0.1.0.rules")
	if e := record(root, "uninstall", strings.Repeat("d", 32)); e != nil {
		t.Fatal(e)
	}
	if loadState(t, root).Receipt.Status != "removed" {
		t.Fatal("uninstall state")
	}
	if e := record(root, "inspect", strings.Repeat("e", 32)); e == nil {
		t.Fatal("silent reinstall")
	}
}
func TestRefuseAlteredFilesKeysStateIdentity(t *testing.T) {
	for _, scenario := range []string{"payload", "root", "untrusted", "signature", "identity", "private-state", "symlink", "permissions"} {
		t.Run(scenario, func(t *testing.T) {
			root, _, _ := fixture(t)
			if e := record(root, "inspect", strings.Repeat("a", 32)); e != nil {
				t.Fatal(e)
			}
			switch scenario {
			case "payload":
				put(t, root, home+"/releases/0.1.0/bin/tailscaled", []byte("modified"))
			case "root":
				put(t, root, system+"/controller.sh", []byte("modified"))
			case "untrusted":
				put(t, root, system+"/release-keys.json", []byte("{}"))
			case "signature":
				b, _ := os.ReadFile(root + system + "/release.json")
				var env Envelope
				json.Unmarshal(b, &env)
				env.Payload = base64.StdEncoding.EncodeToString([]byte("{}"))
				b, _ = json.Marshal(env)
				put(t, root, system+"/release.json", b)
			case "identity":
				put(t, root, "/mnt/onboard/.kobo/version", []byte("N428-OTHER,4.9.77,4.46.23836,x,y,000000000390"))
			case "private-state":
				put(t, root, statePath, []byte("broken"))
			case "symlink":
				os.Remove(root + system + "/controller.sh")
				os.Symlink(root+system+"/provenance", root+system+"/controller.sh")
			case "permissions":
				os.Chmod(root+statePath, 0644)
			}
			if e := record(root, "status", strings.Repeat("b", 32)); e == nil {
				t.Fatal("tampering accepted")
			}
		})
	}
}
func TestBadRequestsAndUnknownFirmware(t *testing.T) {
	root, _, _ := fixture(t)
	for _, args := range [][2]string{{"inspect", "../x"}, {"unknown", strings.Repeat("a", 32)}} {
		if e := record(root, args[0], args[1]); e == nil {
			t.Fatal("invalid request")
		}
	}
	put(t, root, "/mnt/onboard/.kobo/version", []byte("N428-FAKE,4.9.77,9.0.0,x,y,000000000390"))
	if e := record(root, "inspect", strings.Repeat("a", 32)); e == nil {
		t.Fatal("unknown firmware")
	}
}

func TestUnlistedPayloadExecutableIsRefused(t *testing.T) {
	root, _, _ := fixture(t)
	put(t, root, home+"/releases/0.1.0/bin/uname", []byte("untrusted executable"))
	if e := record(root, "inspect", strings.Repeat("a", 32)); e == nil {
		t.Fatal("unlisted executable accepted")
	}
}

func TestHostMetadataScope(t *testing.T) {
	for _, path := range []string{"._bin", "bin/._tailscaled", ".DS_Store", "desktop.ini", "lib/Thumbs.db", ".directory"} {
		t.Run(path, func(t *testing.T) {
			root, _, _ := fixture(t)
			put(t, root, home+"/releases/0.1.0/"+path, []byte("host metadata"))
			if e := record(root, "inspect", strings.Repeat("a", 32)); e != nil {
				t.Fatal(e)
			}
		})
	}
	for _, scenario := range []string{"orphan", "symlink", "oversized", "hash"} {
		t.Run(scenario, func(t *testing.T) {
			root, _, _ := fixture(t)
			path := home + "/releases/0.1.0/bin/._tailscaled"
			switch scenario {
			case "orphan":
				path = home + "/releases/0.1.0/._unknown"
				put(t, root, path, []byte("unknown"))
			case "symlink":
				if e := os.Symlink("tailscaled", root+path); e != nil {
					t.Fatal(e)
				}
			case "oversized":
				put(t, root, path, make([]byte, 1024*1024+1))
			case "hash":
				put(t, root, home+"/releases/0.1.0/bin/tailscaled", []byte("changed"))
			}
			if e := record(root, "inspect", strings.Repeat("a", 32)); e == nil {
				t.Fatal("unsafe file accepted")
			}
		})
	}
}
