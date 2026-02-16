package adapters

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCheckResponse_Success(t *testing.T) {
	resp := &http.Response{
		StatusCode: 200,
		Body:       http.NoBody,
	}
	assert.NoError(t, checkResponse(resp))
}

func TestCheckResponse_Error(t *testing.T) {
	body := `{"message":"Not Found"}`
	resp := &http.Response{
		StatusCode: 404,
		Body:       io.NopCloser(strings.NewReader(body)),
	}
	err := checkResponse(resp)
	require.Error(t, err)

	apiErr, ok := err.(*APIError)
	require.True(t, ok)
	assert.Equal(t, 404, apiErr.StatusCode)
	assert.Equal(t, "Not Found", apiErr.Message)
	assert.Contains(t, apiErr.Error(), "404")
	assert.Contains(t, apiErr.Error(), "Not Found")
}

func TestCheckResponse_NonJSONError(t *testing.T) {
	resp := &http.Response{
		StatusCode: 500,
		Body:       io.NopCloser(strings.NewReader("internal error")),
	}
	err := checkResponse(resp)
	require.Error(t, err)

	apiErr, ok := err.(*APIError)
	require.True(t, ok)
	assert.Equal(t, 500, apiErr.StatusCode)
	assert.Equal(t, "internal error", apiErr.Body)
	assert.Empty(t, apiErr.Message)
	assert.Contains(t, apiErr.Error(), "internal error")
}

func TestDoJSON_Success(t *testing.T) {
	type testResp struct {
		Value string `json:"value"`
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, http.MethodGet, r.Method)
		assert.Equal(t, "test-val", r.Header.Get("X-Test"))
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(testResp{Value: "hello"})
	}))
	defer srv.Close()

	result, err := doJSON[testResp](context.Background(), srv.Client(), http.MethodGet, srv.URL, nil, map[string]string{"X-Test": "test-val"})
	require.NoError(t, err)
	assert.Equal(t, "hello", result.Value)
}

func TestDoJSON_PostWithBody(t *testing.T) {
	type reqBody struct {
		Name string `json:"name"`
	}
	type testResp struct {
		ID string `json:"id"`
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, http.MethodPost, r.Method)
		assert.Equal(t, "application/json", r.Header.Get("Content-Type"))

		var body reqBody
		json.NewDecoder(r.Body).Decode(&body)
		assert.Equal(t, "test", body.Name)

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(testResp{ID: "123"})
	}))
	defer srv.Close()

	result, err := doJSON[testResp](context.Background(), srv.Client(), http.MethodPost, srv.URL, reqBody{Name: "test"}, nil)
	require.NoError(t, err)
	assert.Equal(t, "123", result.ID)
}

func TestDoJSON_APIError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(403)
		w.Write([]byte(`{"message":"Forbidden"}`))
	}))
	defer srv.Close()

	type empty struct{}
	_, err := doJSON[empty](context.Background(), srv.Client(), http.MethodGet, srv.URL, nil, nil)
	require.Error(t, err)

	apiErr, ok := err.(*APIError)
	require.True(t, ok)
	assert.Equal(t, 403, apiErr.StatusCode)
}

func TestDoJSON_NoContent(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	type empty struct{}
	result, err := doJSON[empty](context.Background(), srv.Client(), http.MethodDelete, srv.URL, nil, nil)
	require.NoError(t, err)
	assert.Equal(t, empty{}, result)
}
