package main

import (
	"archive/tar"
	"compress/gzip"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"
)

type CollectionDescriptor struct {
	Purpose string            `json:"purpose"`
	ID      string            `json:"id"`
	Files   map[string]string `json:"files"`
}
type CollectionRequest struct {
	ID       string `json:"id"`
	Identity string `json:"identitySha256"`
}
type CollectionReport struct {
	Purpose      string   `json:"purpose"`
	ID           string   `json:"id"`
	Nonce        string   `json:"nonce"`
	Descriptor   string   `json:"descriptorSha256"`
	Identity     string   `json:"identitySha256"`
	Profile      string   `json:"profileId"`
	Observed     string   `json:"observedAt"`
	Architecture string   `json:"architecture"`
	Kernel       string   `json:"kernel"`
	RootFree     uint64   `json:"rootFreeBytes"`
	OnboardFree  uint64   `json:"onboardFreeBytes"`
	Absent       []string `json:"absentRootPaths"`
	Parents      bool     `json:"parentsAreRealDirectories"`
	BackupHash   string   `json:"systemBackupSha256"`
	BackupSize   int64    `json:"systemBackupSize"`
	RuleRemoved  bool     `json:"collectorRuleRemoved"`
}

var collectionPlatform = func() (string, string, error) {
	a, e := exec.Command("/bin/uname", "-m").Output()
	if e != nil {
		return "", "", e
	}
	k, e := exec.Command("/bin/uname", "-r").Output()
	return strings.TrimSpace(string(a)), strings.TrimSpace(string(k)), e
}

func collectionRoot(id string) string { return "/usr/local/kobold-preflight-" + id }
func collectionRule(id string) string {
	return "/etc/udev/rules.d/98-kobold-preflight-" + id + ".rules"
}
func collectionHome(id string) string { return "/mnt/onboard/.adds/kobold-preflight/" + id }
func freeBytes(path string) (uint64, error) {
	var s syscall.Statfs_t
	e := syscall.Statfs(path, &s)
	return s.Bavail * uint64(s.Bsize), e
}
func originalEtc(root, excluded, destination string) error {
	// Stream a bounded archive. Preserve symlinks as links; never dereference them.
	f, e := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if e != nil {
		return e
	}
	defer f.Close()
	gz := gzip.NewWriter(f)
	tw := tar.NewWriter(gz)
	e = filepath.WalkDir(root+"/etc", func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		relativeRoot := root
		if relativeRoot == "" {
			relativeRoot = "/"
		}
		relative, e := filepath.Rel(relativeRoot, path)
		if e != nil {
			return e
		}
		if "/"+filepath.ToSlash(relative) == excluded {
			return nil
		}
		info, e := entry.Info()
		if e != nil {
			return e
		}
		link := ""
		if info.Mode()&os.ModeSymlink != 0 {
			link, e = os.Readlink(path)
			if e != nil {
				return e
			}
		} else if !info.Mode().IsRegular() && !info.IsDir() {
			return fmt.Errorf("unsupported system file: %s", relative)
		}
		if info.Size() > 256<<20 {
			return errors.New("system file exceeds backup limit")
		}
		header, e := tar.FileInfoHeader(info, link)
		if e != nil {
			return e
		}
		header.Name = filepath.ToSlash(relative)
		if e = tw.WriteHeader(header); e != nil {
			return e
		}
		if info.Mode().IsRegular() {
			source, e := os.Open(path)
			if e != nil {
				return e
			}
			n, copyErr := io.CopyN(tw, source, info.Size())
			source.Close()
			if copyErr != nil {
				return copyErr
			}
			after, e := os.Lstat(path)
			if e != nil {
				return e
			}
			if n != info.Size() || !os.SameFile(info, after) || after.Size() != info.Size() || !after.ModTime().Equal(info.ModTime()) {
				return errors.New("system file changed during backup")
			}
		}
		return nil
	})
	closeTar := tw.Close()
	closeGzip := gz.Close()
	if e != nil {
		return e
	}
	if closeTar != nil {
		return closeTar
	}
	if closeGzip != nil {
		return closeGzip
	}
	return f.Sync()
}
func collect(root, id string) error {
	if !regexp.MustCompile(`^[a-f0-9]{32}$`).MatchString(id) {
		return errors.New("invalid collector ID")
	}
	base := collectionRoot(id)
	home := collectionHome(id)
	// Do nothing on later udev events once the request was consumed.
	if _, e := os.Lstat(root + home + "/request.json"); os.IsNotExist(e) {
		return nil
	}
	var env Envelope
	var keys map[string]string
	var descriptor CollectionDescriptor
	b, e := read(root, base+"/release.json")
	if e != nil {
		return e
	}
	if e = json.Unmarshal(b, &env); e != nil {
		return e
	}
	b, e = read(root, base+"/release-keys.json")
	if e != nil {
		return e
	}
	if e = json.Unmarshal(b, &keys); e != nil {
		return e
	}
	pub, e := decode(keys[env.KeyID])
	if e != nil || len(pub) != 32 {
		return errors.New("untrusted collector")
	}
	payload, e := decode(env.Payload)
	if e != nil {
		return e
	}
	sig, e := decode(env.Signature)
	if e != nil || !ed25519.Verify(pub, payload, sig) {
		return errors.New("collector signature failed")
	}
	if e = json.Unmarshal(payload, &descriptor); e != nil {
		return e
	}
	if descriptor.Purpose != "collect-preflight" || descriptor.ID != id {
		return errors.New("wrong collector descriptor")
	}
	rule := collectionRule(id)
	if _, ok := descriptor.Files[rule]; !ok {
		return errors.New("collector rule missing")
	}
	for path, expected := range descriptor.Files {
		if !(strings.HasPrefix(path, base+"/") || path == rule) {
			return errors.New("collector scope")
		}
		data, e := read(root, path)
		if e != nil {
			return e
		}
		if digest(data) != expected {
			return errors.New("collector file changed")
		}
	}
	b, e = read(root, home+"/request.json")
	if e != nil {
		return e
	}
	if len(b) > 1024 {
		return errors.New("request too large")
	}
	var request CollectionRequest
	if e = json.Unmarshal(b, &request); e != nil {
		return e
	}
	if !regexp.MustCompile(`^[a-f0-9]{32}$`).MatchString(request.ID) {
		return errors.New("invalid request")
	}
	version, e := read(root, "/mnt/onboard/.kobo/version")
	if e != nil {
		return e
	}
	if digest(version) != request.Identity {
		return errors.New("wrong reader")
	}
	fields := strings.Split(strings.TrimSpace(string(version)), ",")
	if len(fields) < 6 || !strings.HasPrefix(fields[0], "N428") || fields[2] != "4.46.23836" || !strings.HasSuffix(fields[5], "390") {
		return errors.New("unsupported reader")
	}
	architecture, kernel, e := collectionPlatform()
	if e != nil {
		return e
	}
	report := CollectionReport{Purpose: "collect-preflight", ID: id, Nonce: request.ID, Descriptor: digest(payload), Identity: digest(version), Profile: "libra-colour-390-4.46.23836", Observed: time.Now().UTC().Format(time.RFC3339), Architecture: architecture, Kernel: kernel, Parents: true, Absent: []string{}}
	for _, path := range []string{"/usr", "/usr/local", "/etc", "/etc/udev", "/etc/udev/rules.d"} {
		i, e := os.Lstat(root + path)
		if e != nil || !i.IsDir() || i.Mode()&os.ModeSymlink != 0 {
			report.Parents = false
		}
	}
	for _, path := range []string{system, "/usr/local/kobold-state", "/etc/udev/rules.d/98-kobold-0.1.0.rules"} {
		if _, e := os.Lstat(root + path); os.IsNotExist(e) {
			report.Absent = append(report.Absent, path)
		} else if e != nil {
			return e
		}
	}
	if !report.Parents {
		return errors.New("system directory parents are unsafe")
	}
	report.RootFree, e = freeBytes(root + "/")
	if e != nil {
		return e
	}
	report.OnboardFree, e = freeBytes(root + "/mnt/onboard")
	if e != nil {
		return e
	}
	out := home + "/reports/" + request.ID
	// Claim a report exactly once. A partial attempt is retained, never overwritten.
	if e = os.MkdirAll(root+home+"/reports", 0700); e != nil {
		return e
	}
	for q := root + home + "/reports"; q != "/" && q != "."; q = filepath.Dir(q) {
		i, e := os.Lstat(q)
		if e != nil {
			return e
		}
		if i.Mode()&os.ModeSymlink != 0 {
			return errors.New("symlink output")
		}
	}
	if e = os.Mkdir(root+out, 0700); e != nil {
		return e
	}
	backup := root + out + "/system-before-trial.tar.gz"
	if e = originalEtc(root, rule, backup); e != nil {
		return e
	}
	f, e := os.Open(backup)
	if e != nil {
		return e
	}
	h := sha256.New()
	if _, e = io.Copy(h, f); e != nil {
		f.Close()
		return e
	}
	f.Close()
	info, e := os.Stat(backup)
	if e != nil {
		return e
	}
	report.BackupHash = fmt.Sprintf("%x", h.Sum(nil))
	report.BackupSize = info.Size()
	public, private, e := ed25519.GenerateKey(rand.Reader)
	if e != nil {
		return e
	}
	if e = atomic(root, base+"/receipt-key.json", []byte(base64.StdEncoding.EncodeToString(private))); e != nil {
		return e
	}
	// Remove only our freshly added, hash-verified rule. Original /etc is untouched.
	current, e := read(root, rule)
	if e != nil || digest(current) != descriptor.Files[rule] {
		return errors.New("collector rule changed; retained")
	}
	if e = os.Remove(root + rule); e != nil {
		return e
	}
	report.RuleRemoved = true
	data, e := json.Marshal(report)
	if e != nil {
		return e
	}
	env = Envelope{KeyID: base64.StdEncoding.EncodeToString(public), Payload: base64.StdEncoding.EncodeToString(data), Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(private, data))}
	b, e = json.Marshal(env)
	if e != nil {
		return e
	}
	if e = atomic(root, out+"/report.json", b); e != nil {
		return e
	}
	if e = atomic(root, home+"/last-result.txt", []byte(request.ID+"\n")); e != nil {
		return e
	}
	return os.Rename(root+home+"/request.json", root+out+"/request.json")
}
