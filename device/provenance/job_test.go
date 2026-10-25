package main

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func startJob(t *testing.T, root, action, n string) {
	t.Helper()
	put(t, root, home+"/request.txt", []byte("id="+n+"\naction="+action+"\nprofile=libra-colour-390-4.46.23836\nhostname=sample-kobo\ntag=tag:kobo-sync\n"))
	if e := job(root, "job-begin", n); e != nil {
		t.Fatal(e)
	}
}
func TestJobConsumptionRecoveryAndConflict(t *testing.T) {
	root, _, _ := fixture(t)
	n := strings.Repeat("a", 32)
	startJob(t, root, "status", n)
	os.Remove(root + home + "/request.txt")
	if e := job(root, "job-recover", ""); e != nil {
		t.Fatal(e)
	}
	b, e := read(root, home+"/request.txt")
	if e != nil || !validRequest(b, n) {
		t.Fatal("request not recovered", e)
	}
	put(t, root, home+"/request.txt", []byte("conflicting"))
	if e = job(root, "job-recover", ""); e == nil {
		t.Fatal("conflict accepted")
	}
	put(t, root, "/mnt/onboard/.kobo/version", []byte("foreign"))
	if e = job(root, "job-recover", ""); e == nil {
		t.Fatal("foreign reader accepted")
	}
}
func TestCommittedJobExportAfterInterruptionDoesNotAdvanceReceipt(t *testing.T) {
	root, _, _ := fixture(t)
	n := strings.Repeat("a", 32)
	startJob(t, root, "status", n)
	put(t, root, home+"/reports/"+n+"/status-private.json", []byte(`{"BackendState":"Running"}`))
	if e := record(root, "status", n); e != nil {
		t.Fatal(e)
	}
	before := loadState(t, root)
	os.Remove(root + home + "/request.txt")
	os.RemoveAll(root + home + "/reports/" + n)
	if e := job(root, "job-recover", ""); e != nil {
		t.Fatal(e)
	}
	after := loadState(t, root)
	if before.Digest != after.Digest || before.Receipt.Sequence != after.Receipt.Sequence {
		t.Fatal("export advanced signing state")
	}
	b, e := read(root, home+"/reports/"+n+"/result.txt")
	if e != nil || string(b) != "complete\n" {
		t.Fatal("completion missing", e)
	}
	b, e = read(root, home+"/reports/"+n+"/status-private.json")
	if e != nil || string(b) != `{"BackendState":"Running"}` {
		t.Fatal("committed report not restored", e)
	}
	if e = job(root, "job-recover", ""); e != nil {
		t.Fatal(e)
	}
	if loadState(t, root).Receipt.Sequence != before.Receipt.Sequence {
		t.Fatal("duplicate recovery replayed")
	}
}
func TestJobExportRetriesAcrossUnavailableMount(t *testing.T) {
	root, _, _ := fixture(t)
	n := strings.Repeat("a", 32)
	startJob(t, root, "inspect", n)
	if e := record(root, "inspect", n); e != nil {
		t.Fatal(e)
	}
	if e := os.Rename(root+"/mnt/onboard", root+"/exported"); e != nil {
		t.Fatal(e)
	}
	if e := job(root, "job-finish", n); e == nil {
		t.Fatal("export without reader accepted")
	}
	if e := os.Rename(root+"/exported", root+"/mnt/onboard"); e != nil {
		t.Fatal(e)
	}
	if e := job(root, "job-recover", ""); e != nil {
		t.Fatal(e)
	}
	if loadState(t, root).Receipt.Sequence != 1 {
		t.Fatal("state rolled or advanced")
	}
}
func TestJobRefusesAlteredCommittedReportAndInsecureJournal(t *testing.T) {
	root, _, _ := fixture(t)
	n := strings.Repeat("a", 32)
	startJob(t, root, "status", n)
	put(t, root, home+"/reports/"+n+"/status-private.json", []byte(`{}`))
	if e := record(root, "status", n); e != nil {
		t.Fatal(e)
	}
	s := loadState(t, root)
	s.ReportData["status-private.json"] = []byte("changed")
	b, _ := json.Marshal(s)
	put(t, root, statePath, b)
	if e := job(root, "job-finish", n); e == nil {
		t.Fatal("changed committed data accepted")
	}
	os.Chmod(root+jobPath, 0644)
	if e := job(root, "job-recover", ""); e == nil {
		t.Fatal("insecure journal accepted")
	}
}

func TestCommittedRequestReappearanceNeverReexecutes(t *testing.T) {
	root, _, _ := fixture(t)
	n := strings.Repeat("a", 32)
	startJob(t, root, "inspect", n)
	if e := record(root, "inspect", n); e != nil {
		t.Fatal(e)
	}
	if e := job(root, "job-recover", ""); e != nil {
		t.Fatal(e)
	}
	if _, e := os.Stat(root + home + "/request.txt"); !os.IsNotExist(e) {
		t.Fatal("committed queue retained")
	}
	j, e := loadJob(root)
	if e != nil {
		t.Fatal(e)
	}
	put(t, root, home+"/request.txt", j.Request)
	if e = job(root, "job-recover", ""); e != nil {
		t.Fatal(e)
	}
	if _, e = os.Stat(root + home + "/request.txt"); !os.IsNotExist(e) {
		t.Fatal("reappeared queue retained")
	}
	if loadState(t, root).Receipt.Sequence != 1 {
		t.Fatal("receipt advanced")
	}
}

func TestInterruptionPhasePersistsWithoutUSBMount(t *testing.T) {
	root, _, _ := fixture(t)
	n := strings.Repeat("a", 32)
	startJob(t, root, "status", n)
	if e := os.Rename(root+"/mnt/onboard", root+"/exported"); e != nil {
		t.Fatal(e)
	}
	if e := job(root, "job-error", n); e != nil {
		t.Fatal(e)
	}
	j, e := loadJournal(root)
	if e != nil || j.Phase != "interrupted" {
		t.Fatal("interruption lost", e)
	}
}
