const test = require('node:test');
const assert = require('node:assert/strict');
const { buildMetaOAuthUrl, buildMetaOAuthState } = require('../src/whatsappOAuth');

test('buildMetaOAuthUrl includes the official Meta OAuth parameters', () => {
  const url = buildMetaOAuthUrl({
    clientId: '12345',
    redirectUri: 'https://example.com/callback',
    state: 'state-123',
  });

  assert.ok(url.startsWith('https://www.facebook.com/v21.0/dialog/oauth?'));
  assert.match(url, /client_id=12345/);
  assert.match(url, /redirect_uri=https%3A%2F%2Fexample.com%2Fcallback/);
  assert.match(url, /state=state-123/);
  assert.match(url, /response_type=code/);
  assert.match(url, /scope=business_management%2Cwhatsapp_business_management%2Cwhatsapp_business_messaging/);
});

test('buildMetaOAuthState includes the company identifier', () => {
  const state = buildMetaOAuthState({ companyId: 7, userId: 99 });
  assert.match(state, /^whatsapp_oauth_/);
  assert.ok(state.includes('company_7'));
  assert.ok(state.includes('user_99'));
});
