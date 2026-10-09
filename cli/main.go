// Command glkvm sends a URL to the GLKVM Linker Chrome extension from the
// command line.
//
// It talks to the extension through Chrome native messaging, so it needs no
// remote debugging, no approval prompt and no browser window. The same binary
// plays three roles:
//
//	glkvm install   Register the binary with Chrome as a native messaging
//	                    host (run once, and again if the binary moves).
//	glkvm <URL>     Send URL to the extension and print the result.
//	(native host)   Chrome starts the binary with the extension origin as
//	                    its first argument. It relays requests that arrive on a
//	                    unix socket to the extension over stdin/stdout.
//
// The flow is:
//
//	glkvm <URL> --unix socket--> native host --stdio--> background.js
package main

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	// hostName is the native messaging host name; background.js connects to
	// it with chrome.runtime.connectNative.
	hostName = "com.dburger.glkvm_linker"
	// extensionID is the ID of the GLKVM Linker extension.
	extensionID = "imppanbjcbibdcbgfdkadhobjecmbfln"
	// sendTimeout limits how long the CLI waits for the extension.
	sendTimeout = 30 * time.Second
)

// request is what the CLI sends to the host over the socket.
type request struct {
	URL string `json:"url"`
}

// response is what the extension returns. It mirrors processLink() in
// background.js, plus the id that pairs it with its request.
type response struct {
	ID      int64  `json:"id,omitempty"`
	Success bool   `json:"success"`
	Error   string `json:"error,omitempty"`
}

// extensionMessage is what the host sends to the extension.
type extensionMessage struct {
	Type string `json:"type"`
	ID   int64  `json:"id"`
	URL  string `json:"url"`
}

func main() {
	log.SetFlags(0)
	log.SetPrefix("glkvm: ")

	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "Usage: glkvm <URL> | glkvm install")
		os.Exit(2)
	}

	switch arg := os.Args[1]; {
	case strings.HasPrefix(arg, "chrome-extension://"):
		// Chrome passes the calling extension's origin as the first argument.
		if err := runHost(); err != nil {
			log.Fatal(err)
		}
	case arg == "install":
		if err := install(); err != nil {
			log.Fatal(err)
		}
	default:
		if err := send(arg); err != nil {
			log.Fatalf("%s: %v", arg, err)
		}
		fmt.Printf("Sent to GLKVM: %s\n", arg)
	}
}

// socketPath is where the native host listens for the CLI.
func socketPath() string {
	if dir := os.Getenv("XDG_RUNTIME_DIR"); dir != "" {
		return filepath.Join(dir, "glkvm-linker.sock")
	}
	return filepath.Join(os.TempDir(), fmt.Sprintf("glkvm-linker-%d.sock", os.Getuid()))
}

// send asks the running native host to deliver url to the extension.
func send(url string) error {
	conn, err := net.DialTimeout("unix", socketPath(), 2*time.Second)
	if err != nil {
		return fmt.Errorf("cannot reach the extension (is Chrome running with GLKVM Linker loaded, and has `glkvm install` been run?): %w", err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(sendTimeout))

	if err := json.NewEncoder(conn).Encode(request{URL: url}); err != nil {
		return fmt.Errorf("sending request: %w", err)
	}
	var res response
	if err := json.NewDecoder(conn).Decode(&res); err != nil {
		return fmt.Errorf("reading response: %w", err)
	}
	if !res.Success {
		if res.Error == "" {
			res.Error = "unknown error"
		}
		return errors.New(res.Error)
	}
	return nil
}

// install writes the native messaging host manifest that tells Chrome where
// this binary is and which extension may start it.
func install() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if exe, err = filepath.EvalSymlinks(exe); err != nil {
		return err
	}
	if strings.Contains(exe, "go-build") {
		return fmt.Errorf("%s is a temporary `go run` binary; build it first (go build -o ~/bin/glkvm .) and run install from there", exe)
	}

	dir := os.Getenv("CHROME_USER_DATA_DIR")
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return err
		}
		dir = filepath.Join(home, ".config", "google-chrome")
	}
	dir = filepath.Join(dir, "NativeMessagingHosts")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}

	manifest, err := json.MarshalIndent(map[string]any{
		"name":            hostName,
		"description":     "GLKVM Linker command-line sender",
		"path":            exe,
		"type":            "stdio",
		"allowed_origins": []string{"chrome-extension://" + extensionID + "/"},
	}, "", "  ")
	if err != nil {
		return err
	}
	path := filepath.Join(dir, hostName+".json")
	if err := os.WriteFile(path, append(manifest, '\n'), 0o644); err != nil {
		return err
	}
	fmt.Printf("Installed %s\nReload the GLKVM Linker extension at chrome://extensions to connect.\n", path)
	return nil
}

// host relays requests from CLI connections to the extension and routes the
// extension's responses back.
type host struct {
	out     io.Writer // stdout, the pipe to the extension
	writeMu sync.Mutex

	mu      sync.Mutex
	nextID  int64
	pending map[int64]chan response
}

// runHost runs until Chrome closes stdin, which happens when the extension
// disconnects or the browser exits.
func runHost() error {
	// Anything written to stdout must be a framed message, so log to stderr.
	log.SetOutput(os.Stderr)

	ln, err := listen(socketPath())
	if err != nil {
		return err
	}
	defer os.Remove(socketPath())
	defer ln.Close()

	h := &host{out: os.Stdout, pending: map[int64]chan response{}}
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go h.serve(conn)
		}
	}()
	return h.readExtension(bufio.NewReader(os.Stdin))
}

// listen creates the socket, replacing a stale one. If another host is still
// listening (an old one that has not exited yet), it waits briefly for it.
func listen(path string) (net.Listener, error) {
	for i := 0; i < 20; i++ {
		ln, err := net.Listen("unix", path)
		if err == nil {
			return ln, os.Chmod(path, 0o600)
		}
		if conn, derr := net.Dial("unix", path); derr == nil {
			conn.Close() // still in use
			time.Sleep(100 * time.Millisecond)
			continue
		}
		os.Remove(path) // stale socket from a host that died
	}
	return nil, fmt.Errorf("socket %s is in use by another host", path)
}

// serve handles one CLI connection: one request, one response.
func (h *host) serve(conn net.Conn) {
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(sendTimeout))

	var req request
	if err := json.NewDecoder(conn).Decode(&req); err != nil {
		json.NewEncoder(conn).Encode(response{Error: "bad request: " + err.Error()})
		return
	}

	h.mu.Lock()
	h.nextID++
	id := h.nextID
	ch := make(chan response, 1)
	h.pending[id] = ch
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		delete(h.pending, id)
		h.mu.Unlock()
	}()

	res := response{Error: "timed out waiting for the extension"}
	if err := h.writeExtension(extensionMessage{Type: "SEND_URL_TO_GLKVM", ID: id, URL: req.URL}); err != nil {
		res.Error = "writing to the extension: " + err.Error()
	} else {
		select {
		case res = <-ch:
		case <-time.After(sendTimeout - time.Second):
		}
	}
	res.ID = 0
	json.NewEncoder(conn).Encode(res)
}

// writeExtension sends one native message: a 32-bit length in native byte
// order (little-endian on the platforms Chrome supports), then the JSON.
func (h *host) writeExtension(msg any) error {
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	h.writeMu.Lock()
	defer h.writeMu.Unlock()
	if err := binary.Write(h.out, binary.LittleEndian, uint32(len(data))); err != nil {
		return err
	}
	_, err = h.out.Write(data)
	return err
}

// readExtension reads responses from the extension until stdin closes.
func (h *host) readExtension(r io.Reader) error {
	for {
		var n uint32
		if err := binary.Read(r, binary.LittleEndian, &n); err != nil {
			if errors.Is(err, io.EOF) {
				return nil // extension disconnected
			}
			return err
		}
		data := make([]byte, n)
		if _, err := io.ReadFull(r, data); err != nil {
			return err
		}
		var res response
		if err := json.Unmarshal(data, &res); err != nil {
			log.Printf("ignoring bad message from extension: %v", err)
			continue
		}
		h.mu.Lock()
		ch := h.pending[res.ID]
		h.mu.Unlock()
		if ch != nil {
			ch <- res
		}
	}
}
