package main

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"regexp"
	"strings"
)

const jobPath = "/usr/local/kobold-state/jobs/active.json"

type Job struct {
	Nonce    string `json:"nonce"`
	Action   string `json:"action"`
	Identity string `json:"identity"`
	Request  []byte `json:"request"`
	Phase    string `json:"phase"`
}

func loadJournal(root string) (Job, error) {
	var j Job
	b, e := read(root, jobPath)
	if e != nil {
		return j, e
	}
	i, e := os.Stat(root + jobPath)
	if e != nil || i.Mode().Perm()&0077 != 0 {
		return j, errors.New("job permissions")
	}
	e = json.Unmarshal(b, &j)
	if e != nil {
		return j, e
	}
	if !regexp.MustCompile(`^[a-f0-9]{32}$`).MatchString(j.Nonce) || !validRequest(j.Request, j.Nonce) || !strings.Contains("|started|interrupted|exported|", "|"+j.Phase+"|") {
		return j, errors.New("invalid job journal")
	}
	fields := requestFields(j.Request)
	if fields["action"] != j.Action {
		return j, errors.New("job action mismatch")
	}
	return j, nil
}
func loadJob(root string) (Job, error) {
	j, e := loadJournal(root)
	if e != nil {
		return j, e
	}
	v, e := read(root, "/mnt/onboard/.kobo/version")
	if e != nil {
		return j, e
	}
	if digest(v) != j.Identity {
		return j, errors.New("job reader mismatch")
	}
	return j, nil
}
func requestFields(b []byte) map[string]string {
	m := map[string]string{}
	for _, line := range strings.Split(strings.TrimSuffix(string(b), "\n"), "\n") {
		p := strings.SplitN(line, "=", 2)
		if len(p) != 2 || m[p[0]] != "" {
			return nil
		}
		m[p[0]] = p[1]
	}
	return m
}
func validRequest(b []byte, nonce string) bool {
	if len(b) > 1024 {
		return false
	}
	m := requestFields(b)
	if len(m) != 5 || m["id"] != nonce || m["profile"] != "libra-colour-390-4.46.23836" {
		return false
	}
	switch m["action"] {
	case "inspect", "enrol", "status", "enable", "disable", "uninstall":
	default:
		return false
	}
	return regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`).MatchString(m["hostname"]) && regexp.MustCompile(`^tag:[a-z][a-z0-9-]{0,62}$`).MatchString(m["tag"])
}
func saveJob(root string, j Job) error {
	b, e := json.Marshal(j)
	if e != nil {
		return e
	}
	return atomic(root, jobPath, b)
}
func committed(root, nonce string) (State, bool, error) {
	var s State
	b, e := read(root, statePath)
	if os.IsNotExist(e) {
		return s, false, nil
	}
	if e != nil {
		return s, false, e
	}
	i, e := os.Stat(root + statePath)
	if e != nil || i.Mode().Perm()&0077 != 0 {
		return s, false, errors.New("private state permissions")
	}
	if e = json.Unmarshal(b, &s); e != nil {
		return s, false, e
	}
	return s, s.Receipt.Nonce == nonce, nil
}
func exportCommitted(root string, j Job, s State) error {
	r := s.Receipt
	if r.Nonce != j.Nonce || r.Identity != j.Identity || r.Installer != installer {
		return errors.New("committed job mismatch")
	}
	payload, e := json.Marshal(r)
	if e != nil {
		return e
	}
	if digest(payload) != s.Digest {
		return errors.New("committed receipt digest mismatch")
	}
	key, e := decode(s.PrivateKey)
	if e != nil || len(key) != ed25519.PrivateKeySize {
		return errors.New("invalid private state")
	}
	if base64.StdEncoding.EncodeToString(ed25519.PrivateKey(key).Public().(ed25519.PublicKey)) != r.PublicKey {
		return errors.New("device key mismatch")
	}
	prefix := home + "/reports/" + j.Nonce
	for name, want := range r.Reports {
		switch name {
		case "status-private.json", "sign-in.txt", "system-backup.sha256":
		default:
			return errors.New("unknown committed report")
		}
		data, ok := s.ReportData[name]
		if !ok || digest(data) != want {
			return errors.New("committed report unavailable")
		}
		if e = atomic(root, prefix+"/"+name, data); e != nil {
			return e
		}
	}
	// Do not carry an unsigned report file into an older committed receipt.
	for _, name := range []string{"status-private.json", "sign-in.txt", "system-backup.sha256"} {
		if r.Reports[name] == "" {
			if _, err := read(root, prefix+"/"+name); err == nil {
				return errors.New("unexpected report file")
			} else if !os.IsNotExist(err) {
				return err
			}
		}
	}
	env := Envelope{KeyID: r.PublicKey, Payload: base64.StdEncoding.EncodeToString(payload), Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(key, payload))}
	b, e := json.Marshal(env)
	if e != nil {
		return e
	}
	if e = atomic(root, prefix+"/installation.json", b); e != nil {
		return e
	}
	if e = atomic(root, prefix+"/result.txt", []byte("complete\n")); e != nil {
		return e
	}
	return atomic(root, home+"/last-result.txt", []byte(j.Nonce+"\n"))
}
func clearCommittedRequest(root string, j Job) error {
	b, e := read(root, home+"/request.txt")
	if os.IsNotExist(e) {
		return nil
	}
	if e != nil {
		return e
	}
	if string(b) != string(j.Request) {
		return errors.New("queued request conflicts with committed job")
	}
	return os.Remove(root + home + "/request.txt")
}
func job(root, action, nonce string) error {
	if action == "job-begin" {
		if !regexp.MustCompile(`^[a-f0-9]{32}$`).MatchString(nonce) {
			return errors.New("invalid job nonce")
		}
		b, e := read(root, home+"/request.txt")
		if e != nil {
			return e
		}
		if !validRequest(b, nonce) {
			return errors.New("invalid job request")
		}
		v, e := read(root, "/mnt/onboard/.kobo/version")
		if e != nil {
			return e
		}
		old, e := loadJob(root)
		if e == nil && old.Phase == "exported" && old.Nonce == nonce {
			return errors.New("replayed completed job")
		}
		if e == nil && old.Phase != "exported" {
			if old.Nonce != nonce || string(old.Request) != string(b) {
				return errors.New("unfinished job must complete first")
			}
			return nil
		}
		if e != nil && !os.IsNotExist(e) {
			return e
		}
		fields := requestFields(b)
		return saveJob(root, Job{nonce, fields["action"], digest(v), b, "started"})
	}
	j, e := loadJournal(root)
	if action != "job-error" {
		j, e = loadJob(root)
	}
	if os.IsNotExist(e) && action == "job-recover" {
		return nil
	}
	if e != nil {
		return e
	}
	if action != "job-recover" && j.Nonce != nonce {
		return errors.New("job nonce mismatch")
	}
	if action == "job-error" {
		j.Phase = "interrupted"
		return saveJob(root, j)
	}
	if action != "job-recover" && action != "job-finish" {
		return errors.New("unknown job operation")
	}
	if j.Phase == "exported" {
		if b, err := read(root, home+"/request.txt"); err == nil && string(b) == string(j.Request) {
			return clearCommittedRequest(root, j)
		} else if err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	s, ok, e := committed(root, j.Nonce)
	if e != nil {
		return e
	}
	if ok {
		if e = exportCommitted(root, j, s); e != nil {
			return e
		}
		if e = clearCommittedRequest(root, j); e != nil {
			return e
		}
		j.Phase = "exported"
		return saveJob(root, j)
	}
	if action == "job-finish" {
		return errors.New("job has no committed receipt")
	}
	if b, err := read(root, home+"/request.txt"); err == nil {
		if string(b) != string(j.Request) {
			return errors.New("queued request conflicts with unfinished job")
		}
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}
	// Re-run only the exact validated transaction. Existing native state and nonce
	// determine whether work is repeated or its committed result is re-exported.
	return atomic(root, home+"/request.txt", j.Request)
}
