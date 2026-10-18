package main

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

var userAgent = "RiparaMP3/" + version + " ( https://github.com/adecordi/adecordi.github.io )"

var errNotFound = errors.New("non trovato")

// offlineRetry: dopo quanto tempo un servizio considerato irraggiungibile
// viene riprovato. Zero vuol dire mai (il programma da console fa un solo
// giro); il server, che resta acceso per giorni, riprova dopo qualche minuto.
var offlineRetry time.Duration

// webClient fa richieste a un servizio online rispettando una pausa minima
// fra una richiesta e l'altra; dopo tre errori di rete di fila considera
// Internet non raggiungibile. Si può usare da più goroutine insieme: la pausa
// vale per tutte, come chiedono i servizi (MusicBrainz conta le richieste
// per indirizzo).
type webClient struct {
	http        *http.Client
	minInterval time.Duration

	mu           sync.Mutex
	last         time.Time // momento riservato all'ultima richiesta
	failures     int
	offlineSince time.Time // zero se il servizio è raggiungibile

	errs atomic.Int64 // errori in totale (rete o servizio), per avvisare l'utente
}

func newWebClient(minInterval time.Duration) *webClient {
	return &webClient{http: &http.Client{Timeout: 25 * time.Second}, minInterval: minInterval}
}

// isOffline dice se il servizio è considerato irraggiungibile.
func (c *webClient) isOffline() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.offlineSince.IsZero() {
		return false
	}
	if offlineRetry > 0 && time.Since(c.offlineSince) > offlineRetry {
		c.offlineSince, c.failures = time.Time{}, 0
		return false
	}
	return true
}

func (c *webClient) errorCount() int { return int(c.errs.Load()) }

func (c *webClient) get(u string) ([]byte, error) {
	return c.do("GET", u, nil)
}

// postForm invia un modulo (application/x-www-form-urlencoded).
func (c *webClient) postForm(u string, form url.Values) ([]byte, error) {
	return c.do("POST", u, form)
}

// httpError è una risposta di errore del servizio; il corpo serve a chi
// vuole leggere il messaggio (per esempio "chiave non valida").
type httpError struct {
	status int
	body   []byte
}

func (e *httpError) Error() string { return fmt.Sprintf("risposta %d", e.status) }

// wait riserva il prossimo turno libero e aspetta che arrivi. Il turno si
// prenota sotto il lucchetto, ma l'attesa e la richiesta avvengono fuori.
func (c *webClient) wait() {
	c.mu.Lock()
	slot := time.Now()
	if next := c.last.Add(c.minInterval); next.After(slot) {
		slot = next
	}
	c.last = slot
	c.mu.Unlock()
	if d := time.Until(slot); d > 0 {
		time.Sleep(d)
	}
}

func (c *webClient) netFailure() {
	c.errs.Add(1)
	c.mu.Lock()
	c.failures++
	if c.failures >= 3 && c.offlineSince.IsZero() {
		c.offlineSince = time.Now()
	}
	c.mu.Unlock()
}

func (c *webClient) netOK() {
	c.mu.Lock()
	c.failures = 0
	c.mu.Unlock()
}

func (c *webClient) do(method, u string, form url.Values) ([]byte, error) {
	if c.isOffline() {
		return nil, errors.New("internet non disponibile")
	}
	for attempt := 0; attempt < 4; attempt++ {
		c.wait()
		var req *http.Request
		if form != nil {
			req, _ = http.NewRequest(method, u, strings.NewReader(form.Encode()))
			req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		} else {
			req, _ = http.NewRequest(method, u, nil)
		}
		req.Header.Set("User-Agent", userAgent)
		resp, err := c.http.Do(req)
		if err != nil {
			c.netFailure()
			return nil, err
		}
		body, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
		resp.Body.Close()
		switch {
		case resp.StatusCode == http.StatusOK && err == nil:
			c.netOK()
			return body, nil
		case resp.StatusCode == http.StatusNotFound:
			c.netOK()
			return nil, errNotFound
		case resp.StatusCode == http.StatusServiceUnavailable || resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500:
			time.Sleep(time.Duration(2+2*attempt) * time.Second)
			continue
		default:
			c.errs.Add(1)
			return nil, &httpError{resp.StatusCode, body}
		}
	}
	c.errs.Add(1)
	return nil, errors.New("servizio non disponibile")
}
