package main

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

type ConnectionAuthorization struct {
	Retry    bool              `json:"metadataRetry,omitempty"`
	Purpose  string            `json:"purpose"`
	ID       string            `json:"id"`
	Previous string            `json:"previousDescriptor"`
	Next     string            `json:"nextDescriptor"`
	Old      map[string]string `json:"oldFiles"`
	New      map[string]string `json:"newFiles"`
	Bridge   map[string]string `json:"bridgeFiles"`
}
type ConnectionJournal struct {
	Nonce     string            `json:"nonce"`
	Identity  string            `json:"identity"`
	Target    string            `json:"target,omitempty"`
	Phase     string            `json:"phase"`
	StateHash string            `json:"stateHash"`
	Modes     map[string]uint32 `json:"modes"`
}

var connectionFault = func(string) error { return nil }

func connectionBase(id string) string { return "/usr/local/kobold-connect-" + id }
func connectionHome(id string) string { return "/mnt/onboard/.adds/kobold-connect/" + id }
func connectionRule(id string) string { return "/etc/udev/rules.d/97-kobold-connect-" + id + ".rules" }
func rootFiles() []string {
	return []string{system + "/bootstrap.sh", system + "/controller.sh", system + "/provenance", system + "/release-keys.json", system + "/release.json", system + "/GO-LICENSE.txt", "/etc/udev/rules.d/98-kobold-0.1.0.rules"}
}
func managedFiles(a ConnectionAuthorization) []string {
	paths := make([]string, 0, len(a.Old))
	for p := range a.Old {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	return paths
}
func validateRootSet(files map[string]string) error {
	allowed := rootFiles()
	if len(files) == len(allowed)+3 {
		allowed = append(allowed, home+"/releases/0.1.0/runtime.sh", home+"/releases/0.1.0/probe.sh", home+"/releases/0.1.0/SHA256SUMS")
	}
	if len(files) != len(allowed) {
		return errors.New("unexpected managed file set")
	}
	for _, p := range allowed {
		if !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(files[p]) {
			return errors.New("invalid managed file authorization")
		}
	}
	return nil
}
func connectionAuth(root, id string) (ConnectionAuthorization, error) {
	var a ConnectionAuthorization
	var env Envelope
	var keys map[string]string
	b, e := read(root, connectionBase(id)+"/authorization.json")
	if e != nil {
		return a, e
	}
	if e = json.Unmarshal(b, &env); e != nil {
		return a, e
	}
	b, e = read(root, system+"/release-keys.json")
	if e != nil {
		return a, e
	}
	if e = json.Unmarshal(b, &keys); e != nil {
		return a, e
	}
	pub, e := decode(keys[env.KeyID])
	if e != nil || len(pub) != 32 {
		return a, errors.New("connection signer not trusted by installed reader")
	}
	payload, e := decode(env.Payload)
	if e != nil {
		return a, e
	}
	sig, e := decode(env.Signature)
	if e != nil || !ed25519.Verify(pub, payload, sig) {
		return a, errors.New("connection authorization signature failed")
	}
	if e = json.Unmarshal(payload, &a); e != nil {
		return a, e
	}
	if (a.Purpose != "continue-inspected-install" && a.Purpose != "upgrade-managed-install") || a.ID != id || a.Previous == a.Next {
		return a, errors.New("invalid connection authorization")
	}
	if e = validateRootSet(a.Old); e != nil {
		return a, e
	}
	if e = validateRootSet(a.New); e != nil {
		return a, e
	}
	for p := range a.Old {
		if _, ok := a.New[p]; !ok {
			return a, errors.New("managed scope changed")
		}
	}
	if len(a.Bridge) != 3 {
		return a, errors.New("invalid bridge file set")
	}
	for _, p := range []string{connectionBase(id) + "/bootstrap.sh", connectionBase(id) + "/provenance", connectionRule(id)} {
		data, e := read(root, p)
		if e != nil {
			return a, e
		}
		if digest(data) != a.Bridge[p] {
			return a, errors.New("connection helper changed")
		}
	}
	for path, hash := range a.New {
		data, e := read(root, connectionBase(id)+"/next"+path)
		if e != nil {
			return a, e
		}
		if digest(data) != hash {
			return a, errors.New("connection candidate changed")
		}
	}
	if a.New[system+"/release-keys.json"] != a.Old[system+"/release-keys.json"] {
		return a, errors.New("signing key rotation is not authorized")
	}
	return a, nil
}
func restoreConnection(root, id string, a ConnectionAuthorization, j ConnectionJournal) error {
	for _, p := range managedFiles(a) {
		b, e := read(root, connectionBase(id)+"/old"+p)
		if e != nil {
			return e
		}
		if digest(b) != a.Old[p] {
			return errors.New("rollback copy changed")
		}
	}
	b, e := read(root, connectionBase(id)+"/old-state.json")
	if e != nil {
		return e
	}
	if digest(b) != j.StateHash {
		return errors.New("rollback state changed")
	}
	for _, p := range managedFiles(a) {
		data, _ := read(root, connectionBase(id)+"/old"+p)
		if e = atomicMode(root, p, data, os.FileMode(j.Modes[p])); e != nil {
			return e
		}
	}
	return atomic(root, statePath, b)
}
func connect(root, id string) (err error) {
	if !regexp.MustCompile(`^[a-f0-9]{32}$`).MatchString(id) {
		return errors.New("invalid connection ID")
	}
	base := connectionBase(id)
	usb := connectionHome(id)
	if _, e := os.Lstat(root + usb + "/request.json"); os.IsNotExist(e) {
		return nil
	}
	a, e := connectionAuth(root, id)
	if e != nil {
		return e
	}
	b, e := read(root, usb+"/request.json")
	if e != nil {
		return e
	}
	if len(b) > 1024 {
		return errors.New("oversized connection request")
	}
	var request CollectionRequest
	if e = json.Unmarshal(b, &request); e != nil {
		return e
	}
	if !regexp.MustCompile(`^[a-f0-9]{32}$`).MatchString(request.ID) {
		return errors.New("invalid connection nonce")
	}
	version, e := read(root, "/mnt/onboard/.kobo/version")
	if e != nil {
		return e
	}
	if digest(version) != request.Identity {
		return errors.New("connection reader mismatch")
	}
	work := "/tmp/kobold-controller"
	if e = os.MkdirAll(root+work, 0700); e != nil {
		return e
	}
	for q := root + work; q != "/" && q != "."; q = filepath.Dir(q) {
		i, e := os.Lstat(q)
		if e != nil {
			return e
		}
		if i.Mode()&os.ModeSymlink != 0 {
			return errors.New("unsafe connection lock")
		}
	}
	if e = os.Mkdir(root+work+"/lock", 0700); e != nil {
		return errors.New("reader is busy; reconnect and retry")
	}
	defer os.Remove(root + work + "/lock")
	if _, e = os.Lstat(root + home + "/request.txt"); !os.IsNotExist(e) {
		return errors.New("finish the existing reader job first")
	}
	journalPath := base + "/journal.json"
	var j ConnectionJournal
	if old, e := read(root, journalPath); e == nil {
		if e = json.Unmarshal(old, &j); e != nil {
			return e
		}
		if a.Retry && j.Target != a.Next {
			return errors.New("metadata retry requires an untouched connection transaction")
		}
		if j.Nonce != request.ID || j.Identity != request.Identity {
			return errors.New("connection journal mismatch")
		}
		if j.Phase != "complete" {
			if e = restoreConnection(root, id, a, j); e != nil {
				return fmt.Errorf("connection recovery stopped: %w", e)
			}
		}
	} else if !os.IsNotExist(e) {
		return e
	}
	report := home + "/reports/" + request.ID
	if j.Phase != "complete" {
		d, hash, e := release(root)
		if e != nil {
			return e
		}
		upgrade := a.Purpose == "upgrade-managed-install"
		if hash != a.Previous || (!upgrade && d.Purpose != "inspect-only") || (upgrade && d.Purpose != "install" && d.Purpose != "connection-trial") {
			return errors.New("connection requires the authorized inspect-only installation")
		}
		if e = record(root, "verify", request.ID); e != nil {
			return e
		}
		if _, e := os.Lstat(root + home + "/state/tailscaled.state"); !upgrade && !os.IsNotExist(e) {
			return errors.New("existing Tailscale identity needs explicit migration; preserved")
		}
		oldState, e := read(root, statePath)
		if e != nil {
			return e
		}
		var state State
		if e = json.Unmarshal(oldState, &state); e != nil {
			return e
		}
		if (!upgrade && state.Receipt.Status != "prepared") || (upgrade && state.Receipt.Status != "installed" && state.Receipt.Status != "prepared" && state.Receipt.Status != "healthy" && state.Receipt.Status != "disabled") {
			return errors.New("this continuation only accepts a prepared installation")
		}
		expected, e := read(root, home+"/backup-ack.txt")
		if e != nil {
			return e
		}
		archive, e := read(root, home+"/system-backup.tar.gz")
		if e != nil {
			return e
		}
		if strings.TrimSpace(string(expected)) != digest(archive) {
			return errors.New("system backup acknowledgement mismatch")
		}
		var required uint64
		for p, hash := range a.Old {
			data, e := read(root, p)
			if e != nil {
				return e
			}
			if digest(data) != hash {
				return errors.New("installed root file differs from inspected package")
			}
			required += uint64(len(data))
			next, e := read(root, base+"/next"+p)
			if e != nil {
				return e
			}
			required += uint64(len(next))
		}
		free, e := freeBytes(root + "/")
		if e != nil {
			return e
		}
		if free < required+16*1024*1024 {
			return errors.New("insufficient root space for reversible connection setup")
		}
		j = ConnectionJournal{Nonce: request.ID, Identity: request.Identity, Phase: "prepared", Target: a.Next, StateHash: digest(oldState), Modes: map[string]uint32{}}
		for _, p := range managedFiles(a) {
			data, _ := read(root, p)
			i, _ := os.Stat(root + p)
			j.Modes[p] = uint32(i.Mode().Perm())
			if e = atomic(root, base+"/old"+p, data); e != nil {
				return e
			}
		}
		if e = atomic(root, base+"/old-state.json", oldState); e != nil {
			return e
		}
		data, _ := json.Marshal(j)
		if e = atomic(root, journalPath, data); e != nil {
			return e
		}
		// Every mutation below has a private, hash-checked rollback copy. The bridge
		// rule remains until commit so an interrupted activation can recover on reboot.
		defer func() {
			if err != nil && j.Phase != "complete" {
				if rollback := restoreConnection(root, id, a, j); rollback != nil {
					err = fmt.Errorf("%v; rollback needs recovery: %w", err, rollback)
				}
			}
		}()
		for _, p := range managedFiles(a) {
			data, _ := read(root, base+"/next"+p)
			mode := os.FileMode(0644)
			if strings.HasSuffix(p, ".sh") || strings.HasSuffix(p, "/provenance") {
				mode = 0755
			}
			if e = atomicMode(root, p, data, mode); e != nil {
				return e
			}
			if e = connectionFault(p); e != nil {
				return e
			}
		}
		next, hash, e := release(root)
		if e != nil {
			return e
		}
		if hash != a.Next || next.Purpose != "connection-trial" {
			return errors.New("activated connection descriptor mismatch")
		}

		if upgrade {
			prior, err := json.Marshal(state.Receipt)
			if err != nil {
				return err
			}
			if digest(prior) != state.Digest {
				return errors.New("prior receipt digest mismatch")
			}
			key, err := decode(state.PrivateKey)
			if err != nil || len(key) != ed25519.PrivateKeySize {
				return errors.New("invalid previous signing key")
			}
			env := Envelope{KeyID: state.Receipt.PublicKey, Payload: base64.StdEncoding.EncodeToString(prior), Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(key, prior))}
			data, err := json.Marshal(env)
			if err != nil {
				return err
			}
			if err = atomic(root, report+"/prior-installation.json", data); err != nil {
				return err
			}
		}
		state.Receipt.PreviousRelease = a.Previous
		state.Receipt.Release = a.Next
		data, _ = json.Marshal(state)
		if e = atomic(root, statePath, data); e != nil {
			return e
		}
		if e = atomic(root, report+"/system-backup.sha256", []byte(digest(archive)+"\n")); e != nil {
			return e
		}
		receiptAction := "inspect"
		if upgrade {
			receiptAction = "status"
		}
		if e = record(root, receiptAction, request.ID); e != nil {
			return e
		}
		completed := j
		completed.Phase = "complete"
		data, _ = json.Marshal(completed)
		if e = atomic(root, journalPath, data); e != nil {
			return e
		}
		j = completed
	}

	if a.Purpose == "upgrade-managed-install" {
		// Retire an interrupted transaction only after this reversible update
		// commits. Keep its exact root-owned record for inspection/recovery.
		if data, e := read(root, jobPath); e == nil {
			if _, e = loadJob(root); e != nil {
				return e
			}
			if e = atomic(root, base+"/retired-job.json", data); e != nil {
				return e
			}
			if e = os.Remove(root + jobPath); e != nil {
				return e
			}
			dir, e := os.Open(root + filepath.Dir(jobPath))
			if e != nil {
				return e
			}
			e = dir.Sync()
			dir.Close()
			if e != nil {
				return e
			}
		} else if !os.IsNotExist(e) {
			return e
		}
	}
	if e = atomic(root, report+"/result.txt", []byte("complete\n")); e != nil {
		return e
	}
	if e = atomic(root, home+"/last-result.txt", []byte(request.ID+"\n")); e != nil {
		return e
	}
	rule := connectionRule(id)
	data, e := read(root, rule)
	if e == nil {
		if digest(data) != a.Bridge[rule] {
			return errors.New("bridge rule changed; retained")
		}
		if e = os.Remove(root + rule); e != nil {
			return e
		}
	}
	return os.Rename(root+usb+"/request.json", root+report+"/connection-request.json")
}
func checkHealth(root, nonce string) error {
	b, e := read(root, home+"/reports/"+nonce+"/status-private.json")
	if e != nil {
		return e
	}
	var status struct {
		BackendState string
		Health       []string
		Self         struct{ Tags []string }
	}
	if e = json.Unmarshal(b, &status); e != nil {
		return e
	}
	request, e := read(root, home+"/reports/"+nonce+"/request.txt")
	if e != nil {
		return e
	}
	tag := ""
	for _, line := range strings.Split(string(request), "\n") {
		if strings.HasPrefix(line, "tag=") {
			tag = strings.TrimPrefix(line, "tag=")
		}
	}
	if status.BackendState != "Running" || len(status.Health) > 0 || tag == "" {
		return errors.New("connection is not healthy")
	}
	for _, t := range status.Self.Tags {
		if t == tag {
			return nil
		}
	}
	return errors.New("reader tag does not match the requested policy")
}
