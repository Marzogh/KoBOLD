// Signed installation receipts and fixed, validated device operations.
package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

const installer = "org.kobold.kobo-tailscale/v1"
const system = "/usr/local/kobold-0.1.0"
const home = "/mnt/onboard/.adds/kobold"
const canonicalRule = "/etc/udev/rules.d/98-kobold-0.1.0.rules"
const statePath = "/usr/local/kobold-state/installation.json"

type Envelope struct {
	KeyID     string `json:"keyId"`
	Payload   string `json:"payload"`
	Signature string `json:"signature"`
}
type Descriptor struct {
	Purpose   string            `json:"purpose"`
	Installer string            `json:"installer"`
	Profile   string            `json:"profile"`
	Version   string            `json:"version"`
	Files     map[string]string `json:"files"`
}
type Receipt struct {
	PreviousRelease string            `json:"previousRelease,omitempty"`
	Installer       string            `json:"installer"`
	InstallationID  string            `json:"installationId"`
	Identity        string            `json:"identity"`
	Profile         string            `json:"profile"`
	Version         string            `json:"version"`
	Release         string            `json:"release"`
	PublicKey       string            `json:"publicKey"`
	Sequence        uint64            `json:"sequence"`
	Previous        string            `json:"previous"`
	Nonce           string            `json:"nonce"`
	Status          string            `json:"status"`
	Files           map[string]string `json:"files"`
	Reports         map[string]string `json:"reportFiles"`
}
type State struct {
	PrivateKey string            `json:"privateKey"`
	Receipt    Receipt           `json:"receipt"`
	Digest     string            `json:"digest"`
	ReportData map[string][]byte `json:"reportData,omitempty"`
}

func digest(b []byte) string          { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }
func decode(s string) ([]byte, error) { return base64.StdEncoding.Strict().DecodeString(s) }
func read(root, path string) ([]byte, error) {
	if !strings.HasPrefix(path, "/") || filepath.Clean(path) != path {
		return nil, errors.New("unsafe path")
	}
	p := root + path
	for q := p; q != "/" && q != "."; q = filepath.Dir(q) {
		i, e := os.Lstat(q)
		if e != nil {
			return nil, e
		}
		if i.Mode()&os.ModeSymlink != 0 {
			return nil, errors.New("symlink refused")
		}
	}
	i, e := os.Stat(p)
	if e != nil {
		return nil, e
	}
	if !i.Mode().IsRegular() || i.Size() > 256<<20 {
		return nil, errors.New("invalid file")
	}
	return os.ReadFile(p)
}
func atomic(root, path string, data []byte) error { return atomicMode(root, path, data, 0600) }
func atomicMode(root, path string, data []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	if e := os.MkdirAll(root+dir, 0700); e != nil {
		return e
	}
	// Check all existing parent components, including the USB report directory.
	for p := root + dir; p != "/" && p != "."; p = filepath.Dir(p) {
		i, e := os.Lstat(p)
		if e != nil {
			return e
		}
		if i.Mode()&os.ModeSymlink != 0 {
			return errors.New("symlink parent")
		}
	}
	if i, e := os.Lstat(root + path); e == nil && !i.Mode().IsRegular() {
		return errors.New("nonregular output")
	}
	f, e := os.CreateTemp(root+dir, ".receipt-")
	if e != nil {
		return e
	}
	defer os.Remove(f.Name())
	if e = f.Chmod(mode); e != nil {
		f.Close()
		return e
	}
	if _, e = f.Write(data); e != nil {
		f.Close()
		return e
	}
	if e = f.Sync(); e != nil {
		f.Close()
		return e
	}
	if e = f.Close(); e != nil {
		return e
	}
	if e = os.Rename(f.Name(), root+path); e != nil {
		return e
	}
	d, e := os.Open(root + dir)
	if e != nil {
		return e
	}
	defer d.Close()
	return d.Sync()
}
func release(root string) (Descriptor, string, error) {
	return releaseAt(root, system, home, canonicalRule)
}

// Legacy descriptors are accepted only by the explicit migration reader.
func releaseAt(root, system, home, rule string) (Descriptor, string, error) {
	var d Descriptor
	var env Envelope
	var keys map[string]string
	b, e := read(root, system+"/release.json")
	if e != nil {
		return d, "", e
	}
	if e = json.Unmarshal(b, &env); e != nil {
		return d, "", e
	}
	b, e = read(root, system+"/release-keys.json")
	if e != nil {
		return d, "", e
	}
	if e = json.Unmarshal(b, &keys); e != nil {
		return d, "", e
	}
	pub, e := decode(keys[env.KeyID])
	if e != nil || len(pub) != ed25519.PublicKeySize {
		return d, "", errors.New("untrusted release key")
	}
	payload, e := decode(env.Payload)
	if e != nil {
		return d, "", e
	}
	sig, e := decode(env.Signature)
	if e != nil || !ed25519.Verify(pub, payload, sig) {
		return d, "", errors.New("release signature failed")
	}
	if e = json.Unmarshal(payload, &d); e != nil {
		return d, "", e
	}
	if d.Installer != installer || d.Profile != "libra-colour-390-4.46.23836" || d.Version != "0.1.0" || len(d.Files) < 4 {
		return d, "", errors.New("unsupported release")
	}
	for path, expected := range d.Files {
		if !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(expected) {
			return d, "", errors.New("invalid hash")
		}
		if !(strings.HasPrefix(path, system+"/") || strings.HasPrefix(path, home+"/releases/0.1.0/") || path == rule) {
			return d, "", errors.New("invalid release scope")
		}
	}
	return d, digest(payload), nil
}

// Metadata is permitted only as a regular bounded file, never a symlink or executable candidate.
func hostMetadata(path string, files map[string]string) bool {
	name := filepath.Base(path)
	switch strings.ToLower(name) {
	case ".ds_store", "desktop.ini", "thumbs.db", ".directory":
		return true
	}
	if !strings.HasPrefix(name, "._") {
		return false
	}
	companion := filepath.Join(filepath.Dir(path), strings.TrimPrefix(name, "._"))
	if files[companion] != "" {
		return true
	}
	for known := range files {
		if strings.HasPrefix(known, companion+"/") {
			return true
		}
	}
	return false
}
func payloadScope(root string, files map[string]string) error {
	count := 0
	return filepath.WalkDir(root+home+"/releases/0.1.0", func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		count++
		if count > 1000 {
			return errors.New("unexpected payload size")
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return errors.New("payload symlink refused")
		}
		if entry.IsDir() {
			return nil
		}
		info, e := entry.Info()
		if e != nil {
			return e
		}
		relative := strings.TrimPrefix(path, root)
		if info.Mode().IsRegular() && files[relative] == "" && info.Size() <= 1024*1024 && hostMetadata(relative, files) {
			return nil
		}
		if !info.Mode().IsRegular() || files[relative] == "" {
			return errors.New("unlisted payload file refused")
		}
		return nil
	})
}
func record(root, action, nonce string) error {
	return recordWithExport(root, action, nonce, true)
}

// A namespace transaction commits its private receipt before publishing any
// signature on USB. Failed activation must not leave a usable future receipt.
func recordWithExport(root, action, nonce string, export bool) error {
	if !regexp.MustCompile(`^[a-f0-9]{32}$`).MatchString(nonce) {
		return errors.New("invalid nonce")
	}
	status := map[string]string{"startup": "verified", "verify": "verified", "inspect": "prepared", "enrol": "installed", "status": "installed", "enable": "healthy", "disable": "disabled", "uninstall": "removed"}[action]
	if status == "" {
		return errors.New("unknown action")
	}
	d, releaseHash, e := release(root)
	if e != nil {
		return e
	}
	version, e := read(root, "/mnt/onboard/.kobo/version")
	if e != nil {
		return e
	}
	fields := strings.Split(strings.TrimSpace(string(version)), ",")
	if len(fields) < 6 || !strings.HasPrefix(fields[0], "N428") || fields[2] != "4.46.23836" || !strings.HasSuffix(fields[5], "390") {
		return errors.New("unsupported reader")
	}
	if e = payloadScope(root, d.Files); e != nil {
		return e
	}
	files := map[string]string{}
	for path, expected := range d.Files {
		if action == "uninstall" && path == "/etc/udev/rules.d/98-kobold-0.1.0.rules" {
			if _, e = os.Lstat(root + path); os.IsNotExist(e) {
				continue
			}
		}
		b, e := read(root, path)
		if e != nil {
			return e
		}
		if digest(b) != expected {
			return fmt.Errorf("installed file changed: %s", path)
		}
		files[path] = expected
	}
	var state State
	b, e := read(root, statePath)
	if os.IsNotExist(e) {
		if action == "verify" || action == "startup" {
			return errors.New("installation state missing")
		}
		// Existing state or identity is never silently replaced after corruption.
		if _, statErr := os.Lstat(root + statePath); !os.IsNotExist(statErr) {
			return errors.New("inaccessible installation state")
		}
		pub, priv, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			return err
		}
		id := make([]byte, 16)
		if _, err = rand.Read(id); err != nil {
			return err
		}
		state.PrivateKey = base64.StdEncoding.EncodeToString(priv)
		state.Receipt = Receipt{Installer: installer, InstallationID: hex.EncodeToString(id), Identity: digest(version), Profile: d.Profile, Version: d.Version, Release: releaseHash, PublicKey: base64.StdEncoding.EncodeToString(pub)}
	} else {
		if e != nil {
			return e
		}
		i, e := os.Stat(root + statePath)
		if e != nil {
			return e
		}
		if i.Mode().Perm()&0077 != 0 {
			return errors.New("private state permissions")
		}
		if e = json.Unmarshal(b, &state); e != nil {
			return e
		}
		r := state.Receipt
		if r.Installer != installer || r.Identity != digest(version) || r.Profile != d.Profile || r.Release != releaseHash {
			return errors.New("installation continuity mismatch; explicit repair required")
		}
		if r.Status == "removed" {
			return errors.New("removed installation requires explicit repair")
		}
	}
	if action == "startup" {
		if state.Receipt.Status != "healthy" {
			return errors.New("startup not accepted")
		}
		return nil
	}
	priv, e := decode(state.PrivateKey)
	if e != nil || len(priv) != ed25519.PrivateKeySize {
		return errors.New("invalid private state")
	}
	if base64.StdEncoding.EncodeToString(ed25519.PrivateKey(priv).Public().(ed25519.PublicKey)) != state.Receipt.PublicKey {
		return errors.New("device key mismatch")
	}
	if action == "verify" {
		return nil
	}
	if state.Receipt.Sequence > 0 && state.Receipt.Nonce == nonce {
		return errors.New("replayed request")
	}
	state.Receipt.Sequence++
	state.Receipt.Previous = state.Digest
	state.Receipt.Nonce = nonce
	if action == "status" && state.Receipt.Status == "healthy" {
		status = "healthy"
	}
	state.Receipt.Status = status
	state.Receipt.Files = files
	state.Receipt.Reports = map[string]string{}
	state.ReportData = map[string][]byte{}
	for _, name := range []string{"status-private.json", "sign-in.txt", "system-backup.sha256"} {
		data, err := read(root, home+"/reports/"+nonce+"/"+name)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return err
		}
		state.Receipt.Reports[name] = digest(data)
		state.ReportData[name] = data
	}
	payload, e := json.Marshal(state.Receipt)
	if e != nil {
		return e
	}
	state.Digest = digest(payload)
	env := Envelope{KeyID: state.Receipt.PublicKey, Payload: base64.StdEncoding.EncodeToString(payload), Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(priv, payload))}
	b, e = json.Marshal(state)
	if e != nil {
		return e
	}
	if e = atomic(root, statePath, b); e != nil {
		return e
	}
	if !export {
		return nil
	}
	// State is authoritative. An interrupted export requires a new challenged job;
	// never roll the private sequence back to match an older USB copy.
	b, e = json.Marshal(env)
	if e != nil {
		return e
	}
	return atomic(root, home+"/reports/"+nonce+"/installation.json", b)
}
func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: provenance ACTION NONCE")
		os.Exit(1)
	}
	root := os.Getenv("KS_TEST_ROOT")
	if root != "" {
		if !filepath.IsAbs(root) || root == "/" {
			os.Exit(1)
		}
		if _, e := os.Stat(root + "/.kobold-test-root"); e != nil {
			os.Exit(1)
		}
	} else if os.Geteuid() != 0 {
		os.Exit(1)
	}
	var err error
	if strings.HasPrefix(os.Args[1], "ready-") {
		action := strings.TrimPrefix(os.Args[1], "ready-")
		if action != "enrol" && action != "status" && action != "enable" {
			err = errors.New("unknown readiness action")
		} else {
			err = readyStatus(root, action, os.Args[2])
		}
	} else if strings.HasPrefix(os.Args[1], "job-") {
		err = job(root, os.Args[1], os.Args[2])
	} else if os.Args[1] == "collect" {
		err = collect(root, os.Args[2])
	} else if os.Args[1] == "connect" {
		err = connect(root, os.Args[2])
	} else if os.Args[1] == "check-health" {
		err = checkHealth(root, os.Args[2])
	} else {
		err = record(root, os.Args[1], os.Args[2])
	}
	if e := err; e != nil {
		if (os.Args[1] == "collect" || os.Args[1] == "connect") && regexp.MustCompile(`^[a-f0-9]{32}$`).MatchString(os.Args[2]) {
			target := collectionHome(os.Args[2]) + "/collector-error.txt"
			if os.Args[1] == "connect" {
				target = connectionHome(os.Args[2]) + "/error.txt"
			}

            _ = atomic(root,target,[]byte(e.Error()))
		}
		fmt.Fprintln(os.Stderr, e)
		os.Exit(1)
	}
}
