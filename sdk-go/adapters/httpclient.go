package adapters

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

// HTTPClient is an interface for making HTTP requests, enabling dependency injection for tests.
type HTTPClient interface {
	Do(req *http.Request) (*http.Response, error)
}

// APIError represents an HTTP API error response.
type APIError struct {
	StatusCode int
	Body       string
	Message    string
}

func (e *APIError) Error() string {
	if e.Message != "" {
		return fmt.Sprintf("API error %d: %s", e.StatusCode, e.Message)
	}
	return fmt.Sprintf("API error %d: %s", e.StatusCode, e.Body)
}

// checkResponse returns an *APIError if the response status code is >= 400.
func checkResponse(resp *http.Response) error {
	if resp.StatusCode < 400 {
		return nil
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()

	apiErr := &APIError{
		StatusCode: resp.StatusCode,
		Body:       string(body),
	}

	// Try to extract message from JSON error body.
	var errBody struct {
		Message string `json:"message"`
	}
	if json.Unmarshal(body, &errBody) == nil && errBody.Message != "" {
		apiErr.Message = errBody.Message
	}

	return apiErr
}

// doRequest makes an HTTP request with the given parameters.
func doRequest(ctx context.Context, client HTTPClient, method, url string, body interface{}, headers map[string]string) (*http.Response, error) {
	var bodyReader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("marshal request body: %w", err)
		}
		bodyReader = bytes.NewReader(data)
	}

	req, err := http.NewRequestWithContext(ctx, method, url, bodyReader)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}

	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}

	return client.Do(req)
}

// doJSON makes an HTTP request and decodes the JSON response into type T.
func doJSON[T any](ctx context.Context, client HTTPClient, method, url string, body interface{}, headers map[string]string) (T, error) {
	var zero T

	resp, err := doRequest(ctx, client, method, url, body, headers)
	if err != nil {
		return zero, err
	}
	defer resp.Body.Close()

	if err := checkResponse(resp); err != nil {
		return zero, err
	}

	// For 204 No Content, return zero value.
	if resp.StatusCode == http.StatusNoContent {
		return zero, nil
	}

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return zero, fmt.Errorf("read response body: %w", err)
	}

	var result T
	if err := json.Unmarshal(respBody, &result); err != nil {
		return zero, fmt.Errorf("decode response: %w", err)
	}
	return result, nil
}
