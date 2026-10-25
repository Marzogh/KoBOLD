package main

import (
	"context"
	"encoding/json"
	"errors"
	"os/exec"
	"regexp"
	"time"
)

type Readiness struct {
	Attempts   int    `json:"attempts"`
	State      string `json:"state"`
	Health     int    `json:"healthCount"`
	TagMatches bool   `json:"tagMatches"`
	Outcome    string `json:"outcome"`
}
type statusProbe func(context.Context) ([]byte, error)

func awaitReady(ctx context.Context, action, tag string, probe statusProbe, pause func(context.Context) error) ([]byte, Readiness, error) {
	var last []byte
	r := Readiness{Outcome: "waiting"}
	for {
		if ctx.Err() != nil {
			r.Outcome = "timeout"
			return last, r, errors.New("Tailscale readiness timed out")
		}
		r.Attempts++
		b, e := probe(ctx)
		if e != nil {
			r.Outcome = "client-error"
		} else {
			var s struct {
				BackendState string
				Health       []string
				Self         struct{ Tags []string }
			}
			if len(b) > 2*1024*1024 || json.Unmarshal(b, &s) != nil {
				r.Outcome = "malformed-status"
			} else {
				last = b
				r.State = s.BackendState
				r.Health = len(s.Health)
				r.TagMatches = false
				for _, v := range s.Self.Tags {
					if v == tag {
						r.TagMatches = true
					}
				}
				switch s.BackendState {
				case "NoState", "Starting", "":
					r.Outcome = "waiting"
				case "Running":
					if action != "enable" || r.Health == 0 && r.TagMatches {
						r.Outcome = "ready"
						return last, r, nil
					}
					r.Outcome = "unhealthy"
				case "NeedsLogin", "NeedsMachineAuth", "Stopped":
					r.Outcome = "login-or-action-required"
					if action != "enable" {
						return last, r, nil
					}
					return last, r, errors.New("Tailscale needs login or operator action before startup can be enabled")
				default:
					r.State = "unrecognised"
					r.Outcome = "unexpected-state"
					return last, r, errors.New("Unexpected Tailscale backend state")
				}
			}
		}
		if pause(ctx) != nil {
			r.Outcome = "timeout"
			return last, r, errors.New("Tailscale readiness timed out")
		}
	}
}
func readyStatus(root, action, nonce string) error {
	if root != "" {
		return errors.New("native execution forbidden in fake-root tests")
	}
	if !regexp.MustCompile(`^[a-f0-9]{32}$`).MatchString(nonce) {
		return errors.New("invalid readiness nonce")
	}
	request, e := read(root, home+"/reports/"+nonce+"/request.txt")
	if e != nil {
		return e
	}
	if !validRequest(request, nonce) || requestFields(request)["action"] != action {
		return errors.New("readiness request mismatch")
	}
	tag := requestFields(request)["tag"]
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	probe := func(ctx context.Context) ([]byte, error) {
		sample, cancel := context.WithTimeout(ctx, 3*time.Second)
		defer cancel()
		return exec.CommandContext(sample, "/bin/sh", home+"/releases/0.1.0/runtime.sh", "cli", "status", "--json").Output()
	}
	pause := func(ctx context.Context) error {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(500 * time.Millisecond):
			return nil
		}
	}
	b, r, readyErr := awaitReady(ctx, action, tag, probe, pause)
	metadata, e := json.Marshal(r)
	if e != nil {
		return e
	}
	// Preserve bounded, non-secret failure context even if onboard disappears.
	if e = atomic(root, "/usr/local/kobold-state/jobs/"+nonce+"-readiness.json", metadata); e != nil {
		return e
	}
	prefix := home + "/reports/" + nonce
	if e = atomic(root, prefix+"/readiness.json", metadata); e != nil {
		return e
	}
	if len(b) > 0 {
		if e = atomic(root, prefix+"/status-private.json", b); e != nil {
			return e
		}
	}
	return readyErr
}
