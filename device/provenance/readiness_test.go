package main

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestEnableWaitsForRunningHealthAndExpectedTag(t *testing.T) {
	samples := []string{`{"BackendState":"NoState","Health":["private startup detail"]}`, `{"BackendState":"Starting"}`, `{"BackendState":"Running","Health":["temporary warning"],"Self":{"Tags":["tag:kobo-sync"]}}`, `{"BackendState":"Running","Self":{"Tags":["tag:other"]}}`, `{"BackendState":"Running","Health":[],"Self":{"Tags":["tag:kobo-sync"]}}`}
	i := 0
	b, r, e := awaitReady(context.Background(), "enable", "tag:kobo-sync", func(context.Context) ([]byte, error) { s := samples[i]; i++; return []byte(s), nil }, func(context.Context) error { return nil })
	if e != nil || i != 5 || r.Outcome != "ready" || !r.TagMatches || r.Health != 0 || !strings.Contains(string(b), "Running") {
		t.Fatal("readiness accepted early", r, e)
	}
}
func TestStatusAndEnrollmentCanReportNeedsLoginWithoutEnablingStartup(t *testing.T) {
	for _, action := range []string{"status", "enrol", "enable"} {
		_, r, e := awaitReady(context.Background(), action, "tag:kobo-sync", func(context.Context) ([]byte, error) { return []byte(`{"BackendState":"NeedsLogin"}`), nil }, func(context.Context) error { t.Fatal("permanent login condition was polled"); return nil })
		if (action == "enable") != (e != nil) || r.Outcome != "login-or-action-required" {
			t.Fatal(action, r, e)
		}
	}
}
func TestReadinessTimeoutAndErrorsNeverClaimSuccess(t *testing.T) {
	for _, sample := range []string{`{"BackendState":"NoState","Health":["secret"]}`, `{"BackendState":"Running","Health":["warning"],"Self":{"Tags":["tag:kobo-sync"]}}`, `not json`, `error`} {
		ctx, cancel := context.WithCancel(context.Background())
		attempt := 0
		_, r, e := awaitReady(ctx, "enable", "tag:kobo-sync", func(context.Context) ([]byte, error) {
			attempt++
			if sample == "error" {
				return nil, errors.New("private client detail")
			}
			return []byte(sample), nil
		}, func(context.Context) error { cancel(); return ctx.Err() })
		if e == nil || r.Outcome != "timeout" || attempt != 1 {
			t.Fatal("unready client accepted", r, e)
		}
		cancel()
	}
}
func TestReadinessNativeCommandRefusesFakeRoot(t *testing.T) {
	if e := readyStatus(t.TempDir(), "enable", strings.Repeat("a", 32)); e == nil {
		t.Fatal("native process executed in fake root")
	}
}
