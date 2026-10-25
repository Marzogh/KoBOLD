package main

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
)

func connectionFixture(t *testing.T, retry ...bool) (string, string, string, State, ConnectionAuthorization) {
	root, key, d := fixture(t)
	upgrade := len(retry) > 1 && retry[1]
	d.Purpose = "inspect-only"
	if upgrade {
		d.Purpose = "install"
	}
	for _, p := range rootFiles() {
		if strings.HasSuffix(p, "/release.json") {
			continue
		}
		if _, e := os.Stat(root + p); os.IsNotExist(e) {
			put(t, root, p, []byte("old:"+p))
		}
		b, _ := os.ReadFile(root + p)
		d.Files[p] = digest(b)
	}
	signDescriptor(t, root, key, d)
	put(t, root, "/mnt/onboard/book.epub", []byte("KEEP BOOK"))
	put(t, root, home+"/system-backup.tar.gz", []byte("backup"))
	put(t, root, home+"/backup-ack.txt", []byte(digest([]byte("backup"))+"\n"))
	action := "inspect"
	if upgrade {
		action = "enrol"
	}
	if e := record(root, action, strings.Repeat("a", 32)); e != nil {
		t.Fatal(e)
	}
	oldState := loadState(t, root)
	id := strings.Repeat("b", 32)
	nonce := strings.Repeat("c", 32)
	base := connectionBase(id)
	a := ConnectionAuthorization{Purpose: "continue-inspected-install", ID: id, Previous: oldState.Receipt.Release, Old: map[string]string{}, New: map[string]string{}, Bridge: map[string]string{}}
	if upgrade {
		a.Purpose = "upgrade-managed-install"
	}
	next := d
	next.Purpose = "connection-trial"
	next.Files = map[string]string{}
	for p, h := range d.Files {
		next.Files[p] = h
	}
	newFiles := map[string][]byte{}
	for _, p := range rootFiles() {
		b, _ := os.ReadFile(root + p)
		a.Old[p] = digest(b)
		if strings.HasSuffix(p, "/controller.sh") {
			b = []byte("new controller")
		}
		if strings.HasSuffix(p, "/provenance") {
			b = []byte("new executable")
		}
		newFiles[p] = b
		if !strings.HasSuffix(p, "/release.json") {
			next.Files[p] = digest(b)
		}
	}
	payload, _ := json.Marshal(next)
	a.Next = digest(payload)
	env := Envelope{KeyID: "test", Payload: base64.StdEncoding.EncodeToString(payload), Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(key, payload))}
	data, _ := json.Marshal(env)
	newFiles[system+"/release.json"] = data
	for p, b := range newFiles {
		a.New[p] = digest(b)
		put(t, root, base+"/next"+p, b)
	}
	for _, p := range []string{base + "/bootstrap.sh", base + "/provenance", connectionRule(id)} {
		b := []byte("bridge:" + p)
		put(t, root, p, b)
		a.Bridge[p] = digest(b)
	}
	a.Retry = len(retry) > 0 && retry[0]
	payload, _ = json.Marshal(a)
	env = Envelope{KeyID: "test", Payload: base64.StdEncoding.EncodeToString(payload), Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(key, payload))}
	data, _ = json.Marshal(env)
	put(t, root, base+"/authorization.json", data)
	request, _ := json.Marshal(CollectionRequest{ID: nonce, Identity: oldState.Receipt.Identity})
	put(t, root, connectionHome(id)+"/request.json", request)
	return root, id, nonce, oldState, a
}
func TestConnectionRetainsIdentityAndAuthorizesNewDescriptor(t *testing.T) {
	root, id, nonce, old, a := connectionFixture(t)
	if e := connect(root, id); e != nil {
		t.Fatal(e)
	}
	current := loadState(t, root)
	if current.PrivateKey != old.PrivateKey || current.Receipt.InstallationID != old.Receipt.InstallationID || current.Receipt.Sequence != old.Receipt.Sequence+1 || current.Receipt.Previous != old.Digest || current.Receipt.PreviousRelease != a.Previous || current.Receipt.Release != a.Next || current.Receipt.Status != "prepared" {
		t.Fatal("lost installation continuity")
	}
	b, _ := os.ReadFile(root + "/mnt/onboard/book.epub")
	if string(b) != "KEEP BOOK" {
		t.Fatal("book changed")
	}
	if _, e := os.Stat(root + connectionRule(id)); !os.IsNotExist(e) {
		t.Fatal("bridge hook retained")
	}
	b, _ = os.ReadFile(root + home + "/reports/" + nonce + "/result.txt")
	if string(b) != "complete\n" {
		t.Fatal("missing completion")
	}
	info, _ := os.Stat(root + system + "/provenance")
	if info.Mode().Perm() != 0755 {
		t.Fatal("helper not executable")
	}
	if e := connect(root, id); e != nil {
		t.Fatal("completion was replayed", e)
	}
}
func TestConnectionRollbackAndInterruptedActivation(t *testing.T) {
	for _, power := range []bool{false, true} {
		t.Run(map[bool]string{false: "failure", true: "power-interruption"}[power], func(t *testing.T) {
			root, id, _, old, a := connectionFixture(t)
			prior := connectionFault
			t.Cleanup(func() { connectionFault = prior })
			connectionFault = func(path string) error {
				if strings.HasSuffix(path, "controller.sh") {
					if power {
						panic("simulated stop")
					}
					return errors.New("simulated failure")
				}
				return nil
			}
			if power {
				func() { defer func() { recover() }(); _ = connect(root, id) }()
			} else if e := connect(root, id); e == nil {
				t.Fatal("failure accepted")
			}
			connectionFault = func(string) error { return nil }
			if !power {
				if loadState(t, root).PrivateKey != old.PrivateKey {
					t.Fatal("rollback changed identity")
				}
				for p, h := range a.Old {
					b, _ := os.ReadFile(root + p)
					if digest(b) != h {
						t.Fatal("rollback file mismatch", p)
					}
				}
			}
			if e := connect(root, id); e != nil {
				t.Fatal("recovery failed", e)
			}
			if loadState(t, root).Receipt.Release != a.Next {
				t.Fatal("recovery not activated")
			}
		})
	}
}
func TestConnectionRejectsChangedCandidateAndExistingIdentity(t *testing.T) {
	for _, kind := range []string{"candidate", "identity"} {
		t.Run(kind, func(t *testing.T) {
			root, id, _, old, _ := connectionFixture(t)
			if kind == "candidate" {
				put(t, root, connectionBase(id)+"/next"+system+"/controller.sh", []byte("changed"))
			} else {
				put(t, root, home+"/state/tailscaled.state", []byte("KEEP CLIENT IDENTITY"))
			}
			if e := connect(root, id); e == nil {
				t.Fatal("unsafe continuation accepted")
			}
			if loadState(t, root).Digest != old.Digest {
				t.Fatal("state changed on refusal")
			}
		})
	}
}
func TestNativeHealthRequiresRequestedTag(t *testing.T) {
	root, _, _ := fixture(t)
	nonce := strings.Repeat("d", 32)
	put(t, root, home+"/reports/"+nonce+"/request.txt", []byte("tag=tag:kobo-sync\n"))
	for _, data := range []string{`{"BackendState":"Running","Health":null,"Self":{"Tags":["tag:other"]}}`, `{"BackendState":"NeedsLogin","Self":{"Tags":["tag:kobo-sync"]}}`} {
		put(t, root, home+"/reports/"+nonce+"/status-private.json", []byte(data))
		if checkHealth(root, nonce) == nil {
			t.Fatal("invalid health accepted")
		}
	}
	put(t, root, home+"/reports/"+nonce+"/status-private.json", []byte(`{"BackendState":"Running","Health":[],"Self":{"Tags":["tag:kobo-sync"]}}`))
	if e := checkHealth(root, nonce); e != nil {
		t.Fatal(e)
	}
}

func TestMetadataRetryJournalAndPreservation(t *testing.T) {
	for _, prior := range []bool{false, true} {
		t.Run(map[bool]string{false: "metadata", true: "old-journal-refused"}[prior], func(t *testing.T) {
			root, id, nonce, old, a := connectionFixture(t, true)
			put(t, root, home+"/releases/0.1.0/bin/._tailscaled", []byte("host metadata"))
			if prior {
				data, _ := json.Marshal(ConnectionJournal{Nonce: nonce, Identity: old.Receipt.Identity, Phase: "prepared"})
				put(t, root, connectionBase(id)+"/journal.json", data)
			}
			e := connect(root, id)
			if prior {
				if e == nil || !strings.Contains(e.Error(), "untouched") {
					t.Fatal("existing transaction accepted", e)
				}
				for p, h := range a.Old {
					b, _ := os.ReadFile(root + p)
					if digest(b) != h {
						t.Fatal("file changed on refused retry")
					}
				}
			} else if e != nil {
				t.Fatal(e)
			}
			b, _ := os.ReadFile(root + home + "/releases/0.1.0/bin/._tailscaled")
			if string(b) != "host metadata" {
				t.Fatal("metadata removed")
			}
			if loadState(t, root).PrivateKey != old.PrivateKey {
				t.Fatal("identity replaced")
			}
		})
	}
}
func TestMetadataRetryCanRecoverItsOwnInterruptedTransaction(t *testing.T) {
	root, id, _, _, _ := connectionFixture(t, true)
	prior := connectionFault
	t.Cleanup(func() { connectionFault = prior })
	connectionFault = func(path string) error {
		if strings.HasSuffix(path, "controller.sh") {
			panic("simulated interruption")
		}
		return nil
	}
	func() { defer func() { recover() }(); _ = connect(root, id) }()
	connectionFault = func(string) error { return nil }
	if e := connect(root, id); e != nil {
		t.Fatal(e)
	}
}

func TestManagedUpgradePreservesPrivateIdentityAndExportsPriorReceipt(t *testing.T) {
	for _, interrupted := range []bool{false, true} {
		t.Run(map[bool]string{false: "exported", true: "private-commit"}[interrupted], func(t *testing.T) {
			root, id, nonce, old, a := connectionFixture(t, false, true)
			private := "/usr/local/kobold-state/tailscale/tailscaled.state"
			put(t, root, private, []byte("KEEP TAILSCALE IDENTITY"))
			if interrupted {
				if e := record(root, "status", strings.Repeat("f", 32)); e != nil {
					t.Fatal(e)
				}
				old = loadState(t, root)
			}
			previousJob := Job{Nonce: strings.Repeat("f", 32), Action: "enable", Identity: old.Receipt.Identity, Phase: "interrupted"}
			previousJob.Request = []byte("id=" + previousJob.Nonce + "\naction=enable\nprofile=libra-colour-390-4.46.23836\nhostname=sample-kobo\ntag=tag:kobo-sync\n")
			if e := saveJob(root, previousJob); e != nil {
				t.Fatal(e)
			}
			if e := connect(root, id); e != nil {
				t.Fatal(e)
			}
			next := loadState(t, root)
			if _, e := os.Stat(root + jobPath); !os.IsNotExist(e) {
				t.Fatal("interrupted job not retired")
			}
			if _, e := read(root, connectionBase(id)+"/retired-job.json"); e != nil {
				t.Fatal("retired job evidence missing", e)
			}
			if next.PrivateKey != old.PrivateKey || next.Receipt.InstallationID != old.Receipt.InstallationID || next.Receipt.Previous != old.Digest || next.Receipt.Sequence != old.Receipt.Sequence+1 || next.Receipt.PreviousRelease != a.Previous || next.Receipt.Status != "installed" {
				t.Fatal("managed continuity lost")
			}
			b, e := read(root, private)
			if e != nil || string(b) != "KEEP TAILSCALE IDENTITY" {
				t.Fatal("identity modified")
			}
			b, e = read(root, home+"/reports/"+nonce+"/prior-installation.json")
			if e != nil {
				t.Fatal(e)
			}
			var env Envelope
			if e = json.Unmarshal(b, &env); e != nil {
				t.Fatal(e)
			}
			data, _ := decode(env.Payload)
			if digest(data) != old.Digest {
				t.Fatal("prior receipt changed")
			}
		})
	}
}
