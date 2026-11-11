'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { generateAgentText } = require('../agent-provider.cjs');

test('provider errors become safe, actionable run reasons', async () => {
  let fixture;
  const server = http.createServer(async (request, response) => {
    for await (const _ of request) {}
    response.writeHead(fixture.status, { 'Content-Type': fixture.status === 200 ? 'text/event-stream' : 'application/json' });
    response.end(fixture.body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const prior = process.env.RENDEZ_OPENAI_RESPONSES_URL;
  process.env.RENDEZ_OPENAI_RESPONSES_URL = `http://127.0.0.1:${server.address().port}/v1/responses`;
  const attempt = () => generateAgentText({
    apiKey: 'sk-test-secret', model: 'test-model', prompt: 'test', context: '{}',
    signal: new AbortController().signal, onChunk: async () => {}
  });
  const httpError = (status, code) => ({ status, body: JSON.stringify({ error: { code, message: 'secret diagnostic: sk-test-secret' } }) });
  const event = item => ({ status: 200, body: `event: ${item.type}\ndata: ${JSON.stringify(item)}\n\n` });
  try {
    for (const [input, expected] of [
      [httpError(401, 'invalid_api_key'), /API key was rejected/],
      [httpError(429, 'insufficient_quota'), /API quota is exhausted/],
      [httpError(429, 'rate_limit_exceeded'), /API rate limit was reached/],
      [httpError(404, 'model_not_found'), /selected model was not found/],
      [httpError(400, 'context_length_exceeded'), /model context limit/],
      [httpError(503, 'server_is_overloaded'), /temporarily overloaded/],
      [event({ type: 'response.failed', response: { error: { code: 'server_error', message: 'secret diagnostic: sk-test-secret' } } }), /provider encountered a server error/],
      [event({ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }), /output token limit/],
      [event({ type: 'error', code: 'invalid_api_key', message: 'secret diagnostic: sk-test-secret' }), /API key was rejected/],
      [event({ type: 'response.failed', response: { error: { code: 'unknown_private_code', message: 'secret diagnostic: sk-test-secret' } } }), /provider did not complete the response/]
    ]) {
      fixture = input;
      await assert.rejects(attempt(), error => {
        assert.match(error.message, expected);
        assert.doesNotMatch(error.message, /sk-test-secret|secret diagnostic|unknown_private_code/);
        return true;
      });
    }
  } finally {
    if (prior === undefined) delete process.env.RENDEZ_OPENAI_RESPONSES_URL;
    else process.env.RENDEZ_OPENAI_RESPONSES_URL = prior;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
