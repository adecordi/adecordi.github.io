package main

import (
	"errors"
	"fmt"
	"io"
	"net/http"
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
	if c.offline {
		return nil, errors.New("internet non disponibile")
	}
	for attempt := 0; attempt < 4; attempt++ {
		if d := time.Until(c.last.Add(c.minInterval)); d > 0 {
			time.Sleep(d)
		}
		c.last = time.Now()
		req, _ := http.NewRequest("GET", u, nil)
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
			return nil, fmt.Errorf("risposta %d", resp.StatusCode)
		}
	}
	c.errors++
	return nil, errors.New("servizio non disponibile")
}
