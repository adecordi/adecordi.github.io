package main

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const userAgent = "RiparaMP3/1.1 ( https://github.com/adecordi/adecordi.github.io )"

var errNotFound = errors.New("non trovato")

// webClient fa richieste a un servizio online rispettando una pausa minima
// fra una richiesta e l'altra; dopo tre errori di rete di fila considera
// Internet non raggiungibile.
type webClient struct {
	http        *http.Client
	minInterval time.Duration
	last        time.Time
	failures    int
	errors      int // errori in totale (rete o servizio), per avvisare l'utente
	offline     bool
}

func newWebClient(minInterval time.Duration) *webClient {
	return &webClient{http: &http.Client{Timeout: 25 * time.Second}, minInterval: minInterval}
}

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

func (c *webClient) do(method, u string, form url.Values) ([]byte, error) {
	if c.offline {
		return nil, errors.New("internet non disponibile")
	}
	for attempt := 0; attempt < 4; attempt++ {
		if d := time.Until(c.last.Add(c.minInterval)); d > 0 {
			time.Sleep(d)
		}
		c.last = time.Now()
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
			c.errors++
			c.failures++
			if c.failures >= 3 {
				c.offline = true
			}
			return nil, err
		}
		body, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
		resp.Body.Close()
		switch {
		case resp.StatusCode == http.StatusOK && err == nil:
			c.failures = 0
			return body, nil
		case resp.StatusCode == http.StatusNotFound:
			c.failures = 0
			return nil, errNotFound
		case resp.StatusCode == http.StatusServiceUnavailable || resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500:
			time.Sleep(time.Duration(2+2*attempt) * time.Second)
			continue
		default:
			c.errors++
			return nil, &httpError{resp.StatusCode, body}
		}
	}
	c.errors++
	return nil, errors.New("servizio non disponibile")
}
